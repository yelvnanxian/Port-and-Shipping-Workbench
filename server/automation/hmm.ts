import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { browserExecutablePath } from './browser.js';
import type { BrowserVerificationCallbacks } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { legacyStatePath, sourceEvidenceDirectory, sourceEvidenceUrl, sourceStatePath } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingFact, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const HMM_SOURCE = 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do';
const DEFAULT_TIMEOUT_MS = 50_000;

// 韩新海运必须使用持久化的真实 Chrome 会话来通过风控。这个会话不能在每次
// 更新任务结束时关闭：Playwright 关闭持久化上下文后，下一次启动会被 Chrome
// 视为上次异常退出，从而出现“Chrome 未正确关闭/恢复页面”提示。
let sharedHmmContext: BrowserContext | null = null;
let sharedHmmProfile: string | null = null;
let sharedHmmLaunch: Promise<BrowserContext> | null = null;

/** 仅在服务退出时关闭，任务之间继续复用已通过验证的持久会话。 */
export async function shutdownHmmBrowser() {
  const launch = sharedHmmLaunch;
  if (launch) await launch.catch(() => undefined);
  const context = sharedHmmContext;
  if (context) {
    resetSharedHmmContext(context);
    await context.close().catch(() => undefined);
  }
}

function resetSharedHmmContext(context: BrowserContext) {
  if (sharedHmmContext !== context) return;
  sharedHmmContext = null;
  sharedHmmProfile = null;
}

async function sharedHmmBrowserContext(dataDirectory: string) {
  const profile = path.resolve(
    process.env.HMM_BROWSER_USER_DATA_DIR?.trim() || path.join(dataDirectory, 'browser-profile', 'HMM'),
  );
  if (sharedHmmContext && sharedHmmProfile === profile) {
    try {
      // pages() 是轻量级的健康检查；上下文被外部关闭后会抛出异常。
      await sharedHmmContext.pages();
      return sharedHmmContext;
    } catch {
      resetSharedHmmContext(sharedHmmContext);
    }
  }
  if (sharedHmmLaunch) return sharedHmmLaunch;

  sharedHmmLaunch = (async () => {
    await fs.mkdir(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      headless: process.env.HMM_BROWSER_HEADLESS === 'true',
      executablePath: await browserExecutablePath(),
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-session-crashed-bubble',
        '--window-size=1440,1000',
      ],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
    });
    sharedHmmContext = context;
    sharedHmmProfile = profile;
    context.once('close', () => resetSharedHmmContext(context));
    return context;
  })();
  try {
    return await sharedHmmLaunch;
  } finally {
    sharedHmmLaunch = null;
  }
}

interface HmmEvent {
  dateTime: string;
  location: string;
  status: string;
  mode: string;
}

interface HmmScheduleColumn {
  label: string;
  role: TrackingRouteStop['role'];
  location: string;
  terminal: string;
  vessel: string;
  arrival: string;
  arrivalActual: boolean;
  departure: string;
  departureActual: boolean;
}

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function plainText(value: string) {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedReference(left || '');
  const b = normalizedReference(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]).trim() : '';
}

function hiddenValue(html: string, id: string) {
  const tag = [...html.matchAll(/<input\b[^>]*>/gi)].find((match) => attribute(match[0], 'id') === id)?.[0];
  return tag ? attribute(tag, 'value') : '';
}

function shipmentEvents(html: string): HmmEvent[] {
  const table = html.match(/<div\b[^>]*id=["']shipmentProgress["'][^>]*>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1] || '';
  return [...table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)].flatMap((row) => {
    if (!/\bclsMoves\b/i.test(row[1])) return [];
    const cells = [...row[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => plainText(cell[1]));
    if (cells.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0]) || !/^\d{2}:\d{2}$/.test(cells[1])) return [];
    return [{ dateTime: `${cells[0]} ${cells[1]}`, location: cells[2], status: cells[3], mode: cells[4] }];
  });
}

interface HtmlCell {
  text: string;
  html: string;
}

function tableRows(table: string) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => (
    [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell): HtmlCell => ({
      text: plainText(cell[1]),
      html: cell[1],
    }))
  )).filter((cells) => cells.length > 0);
}

const HMM_SECTION_HEADINGS = [
  'Shipment Schedule',
  'Container Information',
  'Customs Status',
  'Cargo Delivery Information',
  'Empty Container Return Location',
];

function sectionBlock(html: string, heading: string) {
  const start = html.search(new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  if (start < 0) return '';
  let end = html.length;
  for (const otherHeading of HMM_SECTION_HEADINGS) {
    if (otherHeading === heading) continue;
    const index = html.slice(start + heading.length).search(new RegExp(otherHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (index >= 0) end = Math.min(end, start + heading.length + index);
  }
  return html.slice(start, end);
}

function tablesInSection(html: string, heading: string) {
  return [...sectionBlock(html, heading).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((match) => match[0]);
}

function scheduleRole(value: string): TrackingRouteStop['role'] {
  if (/^Origin$/i.test(value)) return 'origin';
  if (/Loading Port/i.test(value)) return 'loading';
  if (/Discharging Port|Port of Discharge/i.test(value)) return 'discharge';
  if (/Destination/i.test(value)) return 'delivery';
  if (/Transshipment/i.test(value)) return 'transshipment';
  return 'unknown';
}

function cellHasActualTime(cell: HtmlCell | undefined) {
  return Boolean(cell && /\bclass=["'][^"']*\bred\b/i.test(cell.html));
}

function hmmSchedule(html: string) {
  const rows = tablesInSection(html, 'Shipment Schedule').flatMap(tableRows);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /^(?:Origin|Loading Port|Discharging Port|Destination)$/i.test(cell.text)));
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const fieldRow = (pattern: RegExp) => rows.slice(headerIndex + 1).find((row) => pattern.test(row[0]?.text || '')) || [];
  const locations = fieldRow(/^Location$/i);
  const terminals = fieldRow(/^Terminal$/i);
  const vessels = fieldRow(/^Vessel$/i);
  const arrivals = fieldRow(/^Arrival(?:\(ETB\))?$/i);
  const departures = fieldRow(/^Departure$/i);
  const columns: HmmScheduleColumn[] = [];
  for (let index = 0; index < header.length; index += 1) {
    const label = header[index].text;
    if (!label || scheduleRole(label) === 'unknown') continue;
    columns.push({
      label,
      role: scheduleRole(label),
      location: locations[index]?.text || '',
      terminal: terminals[index]?.text || '',
      vessel: vessels[index]?.text || '',
      arrival: arrivals[index]?.text.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || '',
      arrivalActual: cellHasActualTime(arrivals[index]),
      departure: departures[index]?.text.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || '',
      departureActual: cellHasActualTime(departures[index]),
    });
  }
  return columns;
}

function vesselAndVoyage(value: string) {
  const normalized = value.replace(/^\[[^\]]+\]\s*/, '').trim();
  const matched = normalized.match(/^(.+?)\s+([A-Z0-9-]{3,})$/i);
  return matched ? { vesselName: matched[1].trim(), voyageNo: matched[2].trim() } : { vesselName: normalized || null, voyageNo: null };
}

function hmmEventDefinition(status: string): { eventType: TrackingEventType; cargoState: TrackingCargoState; transportMode: TrackingEventDetail['transportMode'] } {
  if (/empty.*(?:return|gate.?in)|returned empty/i.test(status)) return { eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/(?:container|vessel).*(?:discharged|unloaded)|(?:discharged|unloaded).*(?:container|vessel)/i.test(status)) return { eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  if (/vessel arrival at pod|arrival at (?:the )?port of discharg|vessel arrived at pod|vessel berthing at pod/i.test(status)) return { eventType: 'arrival', cargoState: 'laden', transportMode: 'ocean' };
  if (/transship|relay/i.test(status)) return { eventType: 'transshipment', cargoState: 'laden', transportMode: 'ocean' };
  if (/loaded.*vessel|vessel departure|departed|departure/i.test(status)) return { eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/gate.?out|picked up|delivery/i.test(status)) return { eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  if (/gate.?in|received.*terminal/i.test(status)) return { eventType: 'origin', cargoState: 'laden', transportMode: 'terminal' };
  return { eventType: 'other', cargoState: 'unknown', transportMode: 'unknown' };
}

function structuredHistoryEvents(events: HmmEvent[]) {
  return events.map((event): TrackingEventDetail => {
    const definition = hmmEventDefinition(event.status);
    const vessel = vesselAndVoyage(event.mode);
    return {
      label: event.status,
      eventType: definition.eventType,
      location: event.location || null,
      time: null,
      timeText: localTime(event.dateTime),
      actual: true,
      cargoState: definition.cargoState,
      vesselName: vessel.vesselName,
      voyageNo: vessel.voyageNo,
      transportMode: definition.transportMode,
      sourceLine: `${event.dateTime} | ${event.location} | ${event.status} | ${event.mode}`,
    };
  });
}

function scheduleEvents(columns: HmmScheduleColumn[]) {
  return columns.flatMap((column): TrackingEventDetail[] => {
    const vessel = vesselAndVoyage(column.vessel);
    const common = {
      location: column.location || null,
      facility: column.terminal || null,
      time: null,
      cargoState: 'laden' as const,
      vesselName: vessel.vesselName,
      voyageNo: vessel.voyageNo,
      transportMode: 'ocean' as const,
    };
    return [
      ...(column.arrival ? [{
        ...common,
        label: `${column.label} Arrival${column.arrivalActual ? '' : ' (Estimated)'}`,
        eventType: 'arrival' as const,
        timeText: localTime(column.arrival),
        actual: column.arrivalActual,
        sourceLine: `${column.label} | Arrival | ${column.arrival} | ${column.location} | ${column.terminal} | ${column.vessel}`,
      }] : []),
      ...(column.departure ? [{
        ...common,
        label: `${column.label} Departure${column.departureActual ? '' : ' (Estimated)'}`,
        eventType: 'departure' as const,
        timeText: localTime(column.departure),
        actual: column.departureActual,
        sourceLine: `${column.label} | Departure | ${column.departure} | ${column.location} | ${column.terminal} | ${column.vessel}`,
      }] : []),
    ];
  });
}

function uniqueTrackingEvents(events: TrackingEventDetail[]) {
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.timeText}|${event.location || ''}|${event.label}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
}

function scheduleRoute(columns: HmmScheduleColumn[], events: TrackingEventDetail[], destination = '') {
  const stops: TrackingRouteStop[] = [];
  for (const column of columns) {
    if (!column.location) continue;
    const previous = stops.at(-1);
    if (previous?.name.toUpperCase() === column.location.toUpperCase()) {
      if (column.role === 'loading' || column.role === 'discharge') previous.role = column.role;
      continue;
    }
    const role = destination && sameLocation(column.location, destination) && (column.role === 'discharge' || column.role === 'delivery')
      ? 'discharge'
      : column.role === 'discharge' && destination
        ? 'transshipment'
        : column.role;
    stops.push({ name: column.location, role });
  }
  if (stops.length < 2) {
    for (const event of events) {
      if (!event.location || stops.some((stop) => stop.name.toUpperCase() === event.location!.toUpperCase())) continue;
      stops.push({
        name: event.location,
        role: destination && sameLocation(event.location, destination)
          ? 'discharge'
          : stops.length ? 'transshipment' : 'loading',
      });
    }
  }
  return stops;
}

function uniqueFacts(facts: TrackingFact[]) {
  const unique = new Map<string, TrackingFact>();
  for (const fact of facts) {
    const label = fact.label.trim();
    const value = fact.value.trim();
    if (!label || !value) continue;
    const key = `${label}|${value}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, { label, value });
  }
  return [...unique.values()];
}

function scheduleFacts(columns: HmmScheduleColumn[]) {
  return columns.flatMap((column): TrackingFact[] => [
    ...(column.location ? [{ label: `${column.label} · 地点`, value: column.location }] : []),
    ...(column.terminal ? [{ label: `${column.label} · 码头`, value: column.terminal }] : []),
    ...(column.vessel ? [{ label: `${column.label} · 船舶/航次`, value: column.vessel }] : []),
    ...(column.arrival ? [{ label: `${column.label} · 到达`, value: `${column.arrival}（${column.arrivalActual ? '实际' : '预计'}，官网当地时间）` }] : []),
    ...(column.departure ? [{ label: `${column.label} · 离开`, value: `${column.departure}（${column.departureActual ? '实际' : '预计'}，官网当地时间）` }] : []),
  ]);
}

function sectionFacts(html: string, heading: string) {
  const tables = tablesInSection(html, heading);
  const facts: TrackingFact[] = [];
  for (const table of tables) {
    const rows = tableRows(table).map((row) => row.map((cell) => cell.text));
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.length === 2 && row[0] && row[1]) {
        facts.push({ label: `${heading} · ${row[0]}`, value: row[1] });
        continue;
      }
      const previous = rows[index - 1];
      if (previous && previous.length === row.length && previous.some((cell) => /Container No\.|Nation\s*\/\s*Item|Empty Container Return Location|No\./i.test(cell))) {
        for (let column = 0; column < row.length; column += 1) {
          if (previous[column] && row[column]) facts.push({ label: `${heading} · ${previous[column]}`, value: row[column] });
        }
        continue;
      }
      const header = rows[0];
      if (index > 0 && header?.length === row.length && row[0]) {
        for (let column = 1; column < row.length; column += 1) {
          if (header[column] && row[column]) facts.push({ label: `${heading} · ${row[0]} · ${header[column]}`, value: row[column] });
        }
      }
    }
  }
  return facts;
}

function destinationArrival(html: string) {
  const labelIndex = html.search(/Arrival at Destination/i);
  if (labelIndex < 0) return null;
  const context = html.slice(labelIndex, labelIndex + 700);
  const match = context.match(/<div\b[^>]*class=["'][^"']*\b(red|blue)\b[^"']*["'][^>]*>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*<\/div>/i);
  return match ? { kind: match[1].toLowerCase() === 'red' ? 'ATA' as const : 'ETA' as const, dateTime: match[2] } : null;
}

function isArrivalAtPod(status: string) {
  return /vessel arrival at pod|arrival at (?:the )?port of discharg|vessel arrived at pod/i.test(status);
}

function isActualDischarge(status: string) {
  return /(?:container|vessel).*(?:discharged|unloaded)|(?:discharged|unloaded).*(?:container|vessel|pod)/i.test(status);
}

function localTime(value: string | undefined) {
  return value ? `${value}（官网当地时间）` : null;
}

function verificationText(text: string) {
  return /access to this site has been limited|access denied|security check|captcha|verify you are human|challenge|验证码|安全验证|被阻止/i.test(text);
}

function humanVerificationEnabled() {
  return process.env.HMM_BROWSER_HEADLESS !== 'true' && process.env.BROWSER_HUMAN_VERIFY !== 'false';
}

function humanVerificationTimeout() {
  const configured = Number(process.env.BROWSER_HUMAN_VERIFY_TIMEOUT_MS || 180_000);
  return Number.isFinite(configured) && configured >= 10_000 ? configured : 180_000;
}

async function waitForManualVerification(page: Page, input: TrackingQuery, callbacks?: BrowserVerificationCallbacks) {
  let text = await page.locator('body').innerText().catch(() => '');
  if (!verificationText(text)) return;
  if (!humanVerificationEnabled()) {
    throw trackingError('验证码或风控', '韩新海运官网需要人工验证；请将 HMM_BROWSER_HEADLESS=false 后重试');
  }
  callbacks?.onRequired?.({
    carrier: input.rule.name,
    carrierCode: input.rule.code,
    billNo: input.originalBillNo,
    containerNo: input.containerNo,
    sourceUrl: page.url() || HMM_SOURCE,
  });
  const deadline = Date.now() + humanVerificationTimeout();
  while (Date.now() < deadline) {
    if (callbacks?.shouldSkip?.()) throw trackingError('验证码或风控', '韩新海运当前记录已按用户指令跳过人工验证');
    await page.waitForTimeout(1_000);
    text = await page.locator('body').innerText().catch(() => '');
    if (!verificationText(text)) {
      callbacks?.onResolved?.();
      return;
    }
  }
  throw trackingError('验证码或风控', '韩新海运人工验证等待超时，请完成验证后重新执行');
}

export function parseHmmTrackingHtml(html: string, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
  const bodyText = plainText(html);
  if (/access to this site has been limited|access denied|security check|captcha|verify you are human/i.test(bodyText)) {
    throw trackingError('验证码或风控', '韩新海运官网限制了当前浏览器会话');
  }
  if (/500 Error|This page isn't working|service unavailable|internal server error/i.test(bodyText)) {
    throw trackingError('官网接口异常', '韩新海运官网查询接口返回服务器异常');
  }
  const returnedBill = hiddenValue(html, 'thisBl').toUpperCase();
  const returnedContainer = hiddenValue(html, 'thisCntr').toUpperCase();
  if (!returnedBill) {
    if (/no data|no result|not found|invalid/i.test(bodyText)) throw trackingError('订单号验证失败', `韩新海运官网未找到 ${expectedBillNo}`);
    throw trackingError('订单号验证失败', `韩新海运官网未返回提单号 ${expectedBillNo}`);
  }
  if (normalizedReference(returnedBill) !== normalizedReference(expectedBillNo)) {
    throw trackingError('订单号验证失败', `韩新海运官网返回提单号 ${returnedBill}，与查询号 ${expectedBillNo} 不一致`);
  }
  if (expectedContainerNo && normalizedReference(returnedContainer) !== normalizedReference(expectedContainerNo)) {
    throw trackingError('订单号验证失败', `韩新海运官网返回柜号 ${returnedContainer || '空'}，与输入柜号 ${expectedContainerNo} 不一致`);
  }

  const rawEvents = shipmentEvents(html);
  const schedule = hmmSchedule(html);
  const events = uniqueTrackingEvents([...structuredHistoryEvents(rawEvents), ...scheduleEvents(schedule)]);
  const destination = [...schedule].reverse().find((column) => (column.role === 'discharge' || column.role === 'delivery') && column.location)?.location || '';
  const destinationRawEvents = rawEvents.filter((event) => !destination || sameLocation(event.location, destination));
  const arrivalEvent = destinationRawEvents.find((event) => isArrivalAtPod(event.status));
  const berthEvent = destinationRawEvents.find((event) => /vessel berthing at pod/i.test(event.status));
  const dischargeEvent = destinationRawEvents.find((event) => isActualDischarge(event.status));
  const scheduleActualArrival = [...schedule].reverse().find((column) => column.arrival && column.arrivalActual && (column.role === 'discharge' || column.role === 'delivery'));
  const scheduleEstimatedArrival = [...schedule].reverse().find((column) => column.arrival && !column.arrivalActual && (column.role === 'discharge' || column.role === 'delivery'));
  const legacyDestinationArrival = destinationArrival(html);
  const actualArrivalText = arrivalEvent?.dateTime || scheduleActualArrival?.arrival || berthEvent?.dateTime || '';
  const estimatedArrivalText = scheduleEstimatedArrival?.arrival || (legacyDestinationArrival?.kind === 'ETA' ? legacyDestinationArrival.dateTime : '');
  const arrivalKind = actualArrivalText ? 'ATA' as const : estimatedArrivalText ? 'ETA' as const : null;
  const arrivalTimeText = localTime(actualArrivalText || estimatedArrivalText);
  const dischargeTimeText = localTime(dischargeEvent?.dateTime);
  if (!arrivalTimeText && !dischargeTimeText) {
    throw trackingError('解析失败', `韩新海运官网已返回提单 ${returnedBill}，但没有可验证的到港或实际卸船时间`);
  }

  const latest = rawEvents[0];
  const routeStops = scheduleRoute(schedule, events, destination);
  const routeText = routeStops.map((stop) => stop.name).join(' → ') || null;
  const facts = uniqueFacts([
    { label: '官网提单号', value: returnedBill },
    ...(returnedContainer ? [{ label: '官网柜号', value: returnedContainer }] : []),
    ...scheduleFacts(schedule),
    ...sectionFacts(html, 'Container Information'),
    ...sectionFacts(html, 'Customs Status'),
    ...sectionFacts(html, 'Cargo Delivery Information'),
    ...sectionFacts(html, 'Empty Container Return Location'),
  ]);
  return {
    arrivalTime: null,
    arrivalTimeText,
    arrivalKind,
    estimatedArrivalTimeText: estimatedArrivalText ? localTime(estimatedArrivalText) : null,
    arrived: Boolean(actualArrivalText || dischargeEvent),
    discharged: Boolean(dischargeEvent),
    dischargeTime: null,
    dischargeTimeText,
    rawSummary: `韩新海运官网浏览器查询解析成功；官网提单=${returnedBill}；官网柜号=${returnedContainer || '未提供'}${actualArrivalText ? `；实际到港=${actualArrivalText}` : estimatedArrivalText ? `；预计到港=${estimatedArrivalText}` : ''}${dischargeEvent ? `；实际卸船事件=${dischargeEvent.status} ${dischargeEvent.dateTime}` : '；未发现实际卸船事件'}${latest ? `；最新事件=${latest.status} ${latest.dateTime}` : ''}；已采集 ${events.length} 条轨迹事件与 ${facts.length} 项页面事实；官网明确所有时间均为当地时间`,
    sourceUrl: HMM_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'HMM',
      queryType: 'bill',
      queryValue: expectedBillNo,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText: estimatedArrivalText ? localTime(estimatedArrivalText) : null,
      facts,
    },
    rawPageText: html,
  };
}

export class HmmTrackingProvider implements TrackingProvider {
  private browser: BrowserContext | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly verificationCallbacks?: BrowserVerificationCallbacks,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const pending = this.queue.then(() => this.execute(input));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async getBrowser() {
    if (!this.browser) {
      this.browser = await sharedHmmBrowserContext(this.dataDirectory);
    }
    return this.browser;
  }

  private statePath() {
    return sourceStatePath(this.dataDirectory, 'HMM');
  }

  private async existingStatePath() {
    const current = this.statePath();
    try {
      await fs.access(current);
      return current;
    } catch {
      const legacy = legacyStatePath(this.dataDirectory, 'HMM');
      try {
        await fs.access(legacy);
        return legacy;
      } catch {
        return undefined;
      }
    }
  }

  private async getContext() {
    if (this.context) return this.context;
    let storageState: string | undefined;
    storageState = await this.existingStatePath();
    void storageState;
    this.context = await this.getBrowser();
    await this.context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    return this.context;
  }

  private async saveState() {
    if (!this.context) return;
    await fs.mkdir(path.dirname(this.statePath()), { recursive: true });
    await this.context.storageState({ path: this.statePath() });
  }

  private async saveEvidence(page: Page, input: TrackingQuery, outcome: 'success' | 'failure') {
    const evidenceDirectory = sourceEvidenceDirectory(this.dataDirectory, 'HMM');
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const reference = normalizedReference(input.originalBillNo).slice(0, 32) || 'UNKNOWN';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_HMM_${reference}_${outcome}.png`;
    try {
      await page.screenshot({ path: path.join(evidenceDirectory, fileName), fullPage: true });
      return sourceEvidenceUrl('HMM', fileName);
    } catch {
      return undefined;
    }
  }

  private async getPage(context: BrowserContext) {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = context.pages().find((candidate) => /hmm21\.com/i.test(candidate.url())) || await context.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);
    return this.page;
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'HMM') throw trackingError('解析失败', `韩新海运解析器不能查询 ${input.rule.name}`);
    const billNo = input.queryBillNo.trim().toUpperCase();
    const containerNo = input.containerNo.trim().toUpperCase();
    const queryValue = input.queryType === 'container' ? containerNo : billNo;
    if (input.queryType === 'bill' && !/^[A-Z0-9]{10,16}$/.test(queryValue)) throw trackingError('订单号验证失败', `韩新海运提单号格式不正确：${queryValue || '空'}`);
    if (input.queryType === 'container' && !/^[A-Z]{4}\d{7}$/.test(queryValue)) throw trackingError('订单号验证失败', `韩新海运柜号格式不正确：${queryValue || '空'}`);

    const context = await this.getContext();
    const page = await this.getPage(context);
    let sourceUrl = HMM_SOURCE;
    try {
      await page.bringToFront().catch(() => undefined);
      sourceUrl = page.url() || HMM_SOURCE;
      await waitForManualVerification(page, input, this.verificationCallbacks);
      const afterVerification = await page.locator('body').innerText().catch(() => '');
      if (/access to this site has been limited|access denied|security check/i.test(afterVerification)) {
        throw trackingError('验证码或风控', '韩新海运官网限制了当前浏览器会话；该站必须使用有界面的真实 Chrome 会话');
      }
      const queryField = input.queryType === 'container' ? 'input[name="srchCntrNo1"]' : 'input[name="srchBlNo1"]';
      let field = page.locator(queryField);
      const fieldReady = await field.isVisible().catch(() => false) && await field.isEditable().catch(() => false);
      if (!fieldReady) {
        // 结果页仍复用同一个 HMM 会话；只有搜索表单不存在时才回到追踪页。
        await page.goto(HMM_SOURCE, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
        sourceUrl = page.url();
        await waitForManualVerification(page, input, this.verificationCallbacks);
        field = page.locator(queryField);
      }
      await page.waitForFunction("typeof search === 'function'", undefined, { timeout: this.timeoutMs });
      await field.fill('');
      await field.fill(queryValue);
      const responsePromise = page.waitForResponse((response) => response.url().includes('/selectTrackNTrace.do'), { timeout: this.timeoutMs });
      await page.locator('button[onclick="search()"]').click();
      const response = await responsePromise;
      if (response.status() === 403 || response.status() === 412) throw trackingError('验证码或风控', `韩新海运官网查询被风控拦截（HTTP ${response.status()}）`);
      if (!response.ok()) throw trackingError('官网接口异常', `韩新海运官网查询返回 HTTP ${response.status()}`);
      const html = await response.text();
      await page.waitForTimeout(1_000);
      await waitForManualVerification(page, input, this.verificationCallbacks);
      const renderedHtml = await page.content().catch(() => html);
      const result = parseHmmTrackingHtml(renderedHtml, billNo, containerNo);
      const evidencePath = await this.saveEvidence(page, input, 'success');
      return {
        ...result,
        sourceUrl,
        evidencePath,
        trackingDetail: result.trackingDetail ? { ...result.trackingDetail, queryType: input.queryType, queryValue } : undefined,
      };
    } catch (error) {
      const failure = classifyTrackingError(error);
      const evidencePath = await this.saveEvidence(page, input, 'failure');
      throw trackingError(failure.category, failure.reason, { sourceUrl: page.url() || sourceUrl, evidencePath });
    } finally {
      await this.saveState().catch(() => undefined);
      // 保留查询页和验证状态，下一条记录直接复用当前页面。
      this.page = page.isClosed() ? null : page;
    }
  }

  async close() {
    await this.queue;
    await this.saveState().catch(() => undefined);
    // 不关闭持久化 Chrome。任务级 close 只释放当前 provider 的引用；共享
    // 上下文和人工验证会话继续保留，下一次任务直接复用，避免 Chrome 恢复提示。
    this.context = null;
    this.browser = null;
    this.page = null;
  }
}
