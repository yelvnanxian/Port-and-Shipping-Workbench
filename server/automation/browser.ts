import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core';
import { classifyTrackingError, isReferenceMissFailure, trackingError } from './errors.js';
import { parseHapagTrackingText } from './hapag.js';
import { parseMaerskTrackingText } from './maersk.js';
import { parseMscTrackingPayload } from './msc.js';
import { parseOoclDate } from './oocl.js';
import { probeUrl } from './official-probe.js';
import { parseZimTrackingText } from './zim.js';
import { legacyStatePath, sourceEvidenceDirectory, sourceEvidenceUrl, sourceStatePath } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { ArrivalKind, TrackingEventDetail, TrackingQuery, TrackingResult, TrackingDetail, TrackingEventType, TrackingCargoState, RunProgress, TrackingRouteStop } from './types.js';
import { parseCarrierRoute } from './routes/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 20_000;
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// 持久化 Chrome 在同一 Node 进程内复用。每次更新只关闭当前查询页，
// 不关闭整个浏览器进程，避免下次运行出现“Chrome 未正确关闭”的恢复提示。
let sharedBrowser: Browser | null = null;
let sharedBrowserLaunch: Promise<Browser> | null = null;
const sharedContexts = new Map<string, BrowserContext>();

/** 仅供 Node 服务正常退出时调用；任务级 close 仍保留会话复用。 */
export async function shutdownBrowser() {
  const launch = sharedBrowserLaunch;
  if (launch) await launch.catch(() => undefined);
  const contexts = [...sharedContexts.values()];
  sharedContexts.clear();
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (browser) await browser.close().catch(() => undefined);
}

// User-Agent 池 - 用于反检测轮换
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// 反检测启动参数
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // 自动化会话不承载用户浏览历史，禁止 Chrome 在旧进程异常退出后弹出恢复气泡。
  '--disable-session-crashed-bubble',
  '--window-size=1920,1080',
];

// 反检测初始化脚本 - 隐藏 webdriver 特征
const STEALTH_INIT_SCRIPT = `
  // 隐藏 webdriver 标记
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  });

  // 伪装 chrome 对象
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // 伪装 plugins（headless 模式默认为空数组）
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ]
  });

  // 伪装 languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en']
  });

  // 伪装 Permissions API
  if (window.navigator.permissions) {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
        : originalQuery(parameters)
    );
  }

  // 隐藏 CDP 特征
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
`;

function getUserAgent(carrierCode: string): string {
  const hash = [...carrierCode].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return USER_AGENTS[hash % USER_AGENTS.length];
}

/**
 * 随机延迟 - 模拟真人操作
 */
async function humanDelay(min = 500, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 模拟真人打字 - 逐字符输入，带随机间隔
 */
async function humanType(locator: Locator, text: string) {
  await locator.click({ timeout: 5_000 }).catch(() => undefined);
  await humanDelay(200, 500);
  // Cookie 会话可能保留上一次查询值；先清空，避免把新号码追加到旧号码后面。
  await locator.fill('');
  // 使用 pressSequentially 逐字符输入，模拟真人打字节奏
  await locator.pressSequentially(text, {
    delay: 50 + Math.random() * 100
  });
}

const INPUT_SELECTORS = [
  'input[type="search"]',
  'input[name*="track" i]',
  'input[id*="track" i]',
  'input[name*="bill" i]',
  'input[id*="bill" i]',
  'input[name*="container" i]',
  'input[id*="container" i]',
  'input[placeholder*="提单"]',
  'input[placeholder*="柜号"]',
  'input[placeholder*="Container/Bill" i]',
  'input[placeholder*="bill of lading" i]',
  'input[placeholder*="container" i]',
  'input[placeholder*="tracking" i]',
];

const DATE_PATTERNS = [
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
];

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractDate(source: string) {
  for (const pattern of DATE_PATTERNS) {
    const matched = source.match(pattern)?.[0];
    if (!matched) continue;
    const monthFirst = matched.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(.*)$/);
    const normalized = monthFirst ? `${monthFirst[2]} ${monthFirst[1]} ${monthFirst[3]}${monthFirst[4]}` : matched;
    const parsed = parseOoclDate(normalized);
    if (parsed) return parsed;
  }
  return null;
}

function findLabeledDate(lines: string[], label: RegExp, excluded?: RegExp, preferLast = false, preferPrevious = false) {
  const indexes = Array.from({ length: lines.length }, (_, index) => index);
  if (preferLast) indexes.reverse();
  for (const index of indexes) {
    if (!label.test(lines[index])) continue;
    // 船司页面的时间线通常把“日期、地点、事件、船名”拆成多个相邻节点，
    // 也有页面把事件和日期放在同一行。按距离寻找最近日期，避免把上一条
    // 事件（例如 MSC 的 04/08 Empty received）误配给当前事件的 29/07。
    const offsets = preferPrevious
      ? [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]
      : [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
    for (const offset of offsets) {
      const candidateIndex = index + offset;
      if (candidateIndex < 0 || candidateIndex >= lines.length) continue;
      const candidateLine = lines[candidateIndex];
      const context = `${lines[index]} ${candidateLine}`;
      if (excluded?.test(context)) continue;
      const parsed = extractDate(candidateLine) || extractDate(context);
      if (parsed) return parsed;
    }
  }
  return null;
}

function findLabeledDateText(lines: string[], label: RegExp, excluded?: RegExp, preferLast = false) {
  const indexes = Array.from({ length: lines.length }, (_, index) => index);
  if (preferLast) indexes.reverse();
  for (const index of indexes) {
    if (!label.test(lines[index])) continue;
    // 结果页通常先渲染事件标签，再渲染日期；优先取标签后的日期。
    const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
    for (const offset of offsets) {
      const candidateIndex = index + offset;
      if (candidateIndex < 0 || candidateIndex >= lines.length) continue;
      const candidateLine = lines[candidateIndex];
      const context = `${lines[index]} ${candidateLine}`;
      if (excluded?.test(context)) continue;
      for (const pattern of DATE_PATTERNS) {
        const matched = candidateLine.match(pattern)?.[0] || context.match(pattern)?.[0];
        if (!matched) continue;
        const suffix = candidateLine.slice(candidateLine.indexOf(matched) + matched.length).match(/^\s+([A-Z]{2,5})\b/)?.[1];
        return `${matched}${suffix ? ` ${suffix}` : ''}`;
      }
    }
  }
  return null;
}

function findCoscoDestinationArrival(lines: string[]) {
  // 中远页面同时展示“实际到港”“提货时间”“还空箱”等多个时间。
  // 只从明确的实际到港标签取日期，并排除后续场站事件，不能按页面
  // 最后一个日期倒推，否则会把还空箱时间误写成 ATA。
  const arrivalLabel = /实际到港|实际到达|实际抵达|actual(?: time of)? arrival|actual arrival/i;
  const excluded = /预计|预估|estimated|expected|planned|提货|pickup|还空箱|空箱归还|empty\s+(?:returned|return)|gate\s+out|returned\s+from\s+consignee/i;
  const date = findLabeledDate(lines, arrivalLabel, excluded, true);
  const text = findLabeledDateText(lines, arrivalLabel, excluded, true);
  if (date && text) return { date, text };

  // 少数语言版本只保留日期和“目的港”节点，不渲染实际到港标签；
  // 此时仍限制在提货/还空箱等后续事件之前，并取最后一个候选日期。
  const pickupIndex = lines.findIndex((line) => /提货时间|pickup\s*time/i.test(line));
  const end = pickupIndex >= 0 ? pickupIndex : lines.length;
  for (let index = end - 1; index >= 0; index -= 1) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(end, index + 3)).join(' ');
    if (excluded.test(context)) continue;
    const parsed = extractDate(lines[index]) || extractDate(context);
    if (!parsed) continue;
    const matched = lines[index].match(DATE_PATTERNS[0])?.[0] || lines[index].match(DATE_PATTERNS[1])?.[0]
      || lines[index].match(DATE_PATTERNS[2])?.[0] || lines[index].match(DATE_PATTERNS[3])?.[0];
    if (matched) return { date: parsed, text: matched };
  }
  return null;
}

function routeFromRenderedLines(lines: string[]) {
  const locations = lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => /^[A-Z][A-Z0-9 .,'-]{2,},\s*[A-Z][A-Z0-9 .,'-]{2,}$/.test(line) || /^(?:[\u4e00-\u9fff]{2,}[，,]){1,}[\u4e00-\u9fffA-Za-z0-9 .-]{2,}$/.test(line))
    .filter((line, index, all) => all.indexOf(line) === index);
  return locations.length >= 2 ? locations.join(' → ') : null;
}

const COSCO_ROUTE_ROLES: Array<{ role: TrackingRouteStop['role']; label: RegExp }> = [
  { role: 'origin', label: /起始地|起运地|place\s+of\s+receipt|origin/i },
  { role: 'loading', label: /始发港|装货港|port\s+of\s+loading|port\s+of\s+origin/i },
  { role: 'transshipment', label: /中转港|transshipment|转运港/i },
  { role: 'discharge', label: /目的港|卸货港|port\s+of\s+discharge|port\s+of\s+discharging/i },
  { role: 'delivery', label: /目的地|收货地|place\s+of\s+delivery|destination/i },
];

const COSCO_EVENT_DEFINITIONS: Array<{ label: RegExp; eventType: TrackingEventType }> = [
  { label: /还空箱|空箱归还|empty\s+(?:container\s+)?returned|empty\s+return/i, eventType: 'empty-return' },
  { label: /提货时间|提货完成|pickup\s*time|picked\s*up|gate\s+out\s+for\s+delivery/i, eventType: 'pickup' },
  { label: /实际到港|实际到达|实际抵达|actual(?: time of)? arrival|arrival at port of discharge|arrived at/i, eventType: 'arrival' },
  { label: /^(?:卸船|卸货)$|卸船完成|实际卸船|卸船时间|卸货完成|卸货时间|unloaded|discharged|discharge completed|discharged from vessel/i, eventType: 'discharge' },
  { label: /实际离港|实际出港|departure from port|departed from|departure/i, eventType: 'departure' },
  { label: /装船|loaded on|loading at/i, eventType: 'departure' },
  { label: /还重时间|重箱进场|full\s+(?:container\s+)?gate\s*in/i, eventType: 'origin' },
];

function coscoLocation(value: string) {
  const location = value.replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim().replace(/^[-–—:|]+|[-–—:|]+$/g, '');
  if (!location || location.length < 2 || location.length > 120) return null;
  if (/^(?:CST|CDT|UTC|GMT|PST|PDT|MST|MDT|EST|EDT)$/i.test(location)) return null;
  if (DATE_PATTERNS.some((pattern) => pattern.test(location))) return null;
  if (/货物跟踪|运输详情|最新动态|起始地|始发港|中转港|目的港|目的地|提货|还空箱|实际到|实际离|卸船|卸货|装船|时间|日期|船名|航次|container|bill|booking|yard|depot|truck|cy\s*\|\s*cy/i.test(location)) return null;
  if (/^[A-Z][A-Z0-9 .,'()&/-]{2,}(?:,\s*[A-Z][A-Z0-9 .,'()&/-]{1,}){0,3}$/i.test(location)) return location;
  if (/^[\u4e00-\u9fff]{2,}(?:[，,][\u4e00-\u9fffA-Za-z0-9 ./'()&/-]{2,}){0,3}$/.test(location)) return location;
  return null;
}

function coscoLocationNear(lines: string[], index: number, preferPrevious = true) {
  const offsets = preferPrevious ? [-1, 1, -2, 2, -3, 3] : [1, -1, 2, -2, 3, -3];
  for (const offset of offsets) {
    const candidateIndex = index + offset;
    if (candidateIndex < 0 || candidateIndex >= lines.length) continue;
    const candidate = coscoLocation(lines[candidateIndex]);
    if (candidate) return candidate;
  }
  return null;
}

function coscoInlineLocation(line: string, label: RegExp) {
  const match = line.match(new RegExp(`(?:${label.source})\\s*(?:[:：|→-])?\\s*(.+)$`, label.flags));
  return match ? coscoLocation(match[1]) : null;
}

function coscoDateNear(lines: string[], index: number) {
  const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
  for (const offset of offsets) {
    const candidateIndex = index + offset;
    if (candidateIndex < 0 || candidateIndex >= lines.length) continue;
    const line = lines[candidateIndex];
    const matched = line.match(DATE_PATTERNS[0])?.[0]
      || line.match(DATE_PATTERNS[1])?.[0]
      || line.match(DATE_PATTERNS[2])?.[0]
      || line.match(DATE_PATTERNS[3])?.[0];
    if (!matched) continue;
    const suffix = line.slice(line.indexOf(matched) + matched.length).match(/^\s+([A-Z]{2,5})\b/)?.[1];
    const date = coscoDateWithTimezone(matched, suffix);
    if (date) return { date, text: `${matched}${suffix ? ` ${suffix}` : ''}` };
  }
  return null;
}

function coscoDateWithTimezone(value: string, timezone?: string) {
  const matched = value.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
  if (!matched) return extractDate(value);
  if (!matched[2]) return new Date(`${matched[1]}T00:00:00Z`);
  const offset = ({ CST: '+08:00', CDT: '-05:00', EST: '-05:00', EDT: '-04:00', PST: '-08:00', PDT: '-07:00', MST: '-07:00', MDT: '-06:00', UTC: 'Z', GMT: 'Z' } as Record<string, string>)[(timezone || '').toUpperCase()];
  if (!offset) return null;
  const date = new Date(`${matched[1]}T${matched[2]}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function coscoDatePartsNear(lines: string[], index: number) {
  const dateLine = lines[index + 1] || '';
  const timeLine = lines[index + 2] || '';
  const timezoneLine = lines[index + 3] || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLine) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(timeLine)) return null;
  const timeText = `${dateLine} ${timeLine}${/^[A-Z]{2,5}$/.test(timezoneLine) ? ` ${timezoneLine}` : ''}`;
  const timezone = /^[A-Z]{2,5}$/.test(timezoneLine) ? timezoneLine : undefined;
  const date = coscoDateWithTimezone(`${dateLine} ${timeLine}`, timezone);
  return date ? { date, text: timeText, consumed: /^[A-Z]{2,5}$/.test(timezoneLine) ? 3 : 2 } : null;
}

function coscoCargoState(label: string): TrackingCargoState {
  if (/空箱|empty/i.test(label)) return 'empty';
  // “实际到港/离港”只说明船期事件，不足以证明柜内是有货还是空箱；
  // 只有明确的装船、卸船/卸货等货物事件才标记为 laden。
  if (/装船|卸船|卸货|loaded|unloaded|discharg/i.test(label)) return 'laden';
  return 'unknown';
}

function coscoEventType(label: string, fallback: TrackingEventType): TrackingEventType {
  if (/空箱|empty/i.test(label)) return 'empty-return';
  if (/提货|pickup|gate\s+out/i.test(label)) return 'pickup';
  if (/卸船|卸货|unloaded|discharg/i.test(label)) return 'discharge';
  if (/到港|arrival|arrived/i.test(label)) return 'arrival';
  if (/离港|出港|departure|departed|装船|loaded/i.test(label)) return 'departure';
  return fallback;
}

function coscoRoleForEvent(eventType: TrackingEventType): TrackingRouteStop['role'] {
  if (eventType === 'departure' || eventType === 'origin') return 'loading';
  if (eventType === 'arrival' || eventType === 'discharge') return 'discharge';
  if (eventType === 'pickup' || eventType === 'delivery' || eventType === 'empty-return') return 'delivery';
  return 'unknown';
}

function coscoSameLocation(left: string, right: string) {
  const a = left.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
  const b = right.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
  return a === b || (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)));
}

function coscoExactLocation(left: string, right: string) {
  return left.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '') === right.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
}

function coscoRouteHeaderIndex(lines: string[]) {
  const expected = ['起始地', '始发港', '中转港', '目的港', '目的地'];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (expected.every((label, offset) => lines[index + offset] === label)) return index;
  }
  return -1;
}

function coscoRouteFromHeader(lines: string[]) {
  const headerIndex = coscoRouteHeaderIndex(lines);
  if (headerIndex < 0) return { headerIndex, routeStops: [] as TrackingRouteStop[] };
  const roles: TrackingRouteStop['role'][] = ['origin', 'loading', 'transshipment', 'discharge', 'delivery'];
  const routeStops = roles.flatMap((role, offset) => {
    const location = coscoLocation(lines[headerIndex + 5 + offset] || '');
    return location ? [{ name: location, role }] : [];
  });
  return { headerIndex, routeStops };
}

function coscoTimelineEvents(lines: string[], routeHeaderIndex: number, routeStops: TrackingRouteStop[]) {
  if (routeHeaderIndex < 0 || !routeStops.length) return [];
  const start = routeHeaderIndex + 10;
  const end = lines.findIndex((line, index) => index > start && /运输详情|transportation details/i.test(line));
  const events: TrackingEventDetail[] = [];
  let routeIndex = 0;
  for (let index = start; index < (end >= 0 ? end : lines.length); index += 1) {
    const definition = COSCO_EVENT_DEFINITIONS.find((item) => item.label.test(lines[index]));
    if (!definition) continue;
    const date = coscoDatePartsNear(lines, index);
    if (!date) continue;
    const label = lines[index].replace(/[\t ]+/g, ' ').trim();
    const eventType = coscoEventType(label, definition.eventType);
    events.push({
      label,
      eventType,
      location: routeStops[Math.min(routeIndex, routeStops.length - 1)]?.name || null,
      time: date.date.toISOString(),
      timeText: date.text,
      actual: !/预计|预估|estimated|expected|planned|计划/i.test(label),
      cargoState: /还重时间|重箱进场|full\s+(?:container\s+)?gate\s*in/i.test(label) ? 'laden' : coscoCargoState(label),
      sourceLine: lines[index],
    });
    routeIndex += 1;
    index += date.consumed;
  }
  return events;
}

function coscoLatestEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const occurrence = line.match(/(?:发生于|于)\s*(.+?),?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[A-Z]{2,5})?)/i);
    if (!occurrence) continue;
    const label = lines[index - 1] || '';
    const definition = COSCO_EVENT_DEFINITIONS.find((item) => item.label.test(label));
    const timezone = occurrence[2].match(/\s([A-Z]{2,5})$/)?.[1];
    const date = coscoDateWithTimezone(occurrence[2], timezone);
    const location = coscoLocation(occurrence[1]);
    if (!definition || !location) continue;
    const eventType = coscoEventType(label, definition.eventType);
    events.push({ label, eventType, location, time: date?.toISOString() || null, timeText: occurrence[2], actual: true, cargoState: coscoCargoState(label), sourceLine: `${label} ${line}` });
  }
  return events;
}

function coscoScheduleEvents(lines: string[], knownEvents: TrackingEventDetail[]) {
  const start = lines.findIndex((line) => /实时船期|real.?time schedule/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /提单信息|bill of lading information/i.test(line));
  if (start < 0) return [];
  const events: TrackingEventDetail[] = [];
  const limit = end >= 0 ? end : lines.length;
  for (let index = start + 1; index < limit - 4; index += 1) {
    if (!/^预计[：:]\s*\d{4}-\d{2}-\d{2}/.test(lines[index]) || !/^实际[：:]\s*\d{4}-\d{2}-\d{2}/.test(lines[index + 1])) continue;
    const loadingPort = coscoLocation(lines[index - 1] || '');
    const dischargePort = coscoLocation(lines[index + 2] || '');
    if (!loadingPort || !dischargePort || !/^预计[：:]\s*\d{4}-\d{2}-\d{2}/.test(lines[index + 3]) || !/^实际[：:]\s*\d{4}-\d{2}-\d{2}/.test(lines[index + 4])) continue;
    const pairs: Array<{ label: string; eventType: TrackingEventType; location: string; value: string; actual: boolean }> = [
      { label: '预计离港', eventType: 'departure', location: loadingPort, value: lines[index], actual: false },
      { label: '实际离港', eventType: 'departure', location: loadingPort, value: lines[index + 1], actual: true },
      { label: '预计到港', eventType: 'arrival', location: dischargePort, value: lines[index + 3], actual: false },
      { label: '实际到港', eventType: 'arrival', location: dischargePort, value: lines[index + 4], actual: true },
    ];
    for (const item of pairs) {
      const value = item.value.replace(/^[^：:]+[：:]\s*/, '');
      const timezone = knownEvents.find((event) => event.location && coscoSameLocation(event.location, item.location) && event.timeText)?.timeText?.match(/\s([A-Z]{2,5})$/)?.[1];
      const date = coscoDateWithTimezone(value, timezone);
      if (date) events.push({ label: item.label, eventType: item.eventType, location: item.location, time: date.toISOString(), timeText: value, actual: item.actual, cargoState: 'unknown', sourceLine: item.value });
    }
    index += 4;
  }
  return events;
}

function dedupeCoscoEvents(events: TrackingEventDetail[]) {
  const unique: TrackingEventDetail[] = [];
  for (const event of events) {
    if (unique.some((item) => item.eventType === event.eventType && item.actual === event.actual && item.time === event.time && item.location && event.location && coscoSameLocation(item.location, event.location))) continue;
    unique.push(event);
  }
  return unique;
}

function coscoFallbackEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const definition = COSCO_EVENT_DEFINITIONS.find((item) => item.label.test(lines[index]));
    if (!definition) continue;
    const date = coscoDateNear(lines, index);
    const location = coscoInlineLocation(lines[index], definition.label) || coscoLocationNear(lines, index, true);
    if (!date || !location) continue;
    const label = lines[index].replace(/[\t ]+/g, ' ').trim();
    events.push({
      label,
      eventType: coscoEventType(label, definition.eventType),
      location,
      time: date.date.toISOString(),
      timeText: date.text,
      actual: !/预计|预估|estimated|expected|planned|计划/i.test(label),
      cargoState: /还重时间|重箱进场/i.test(label) ? 'laden' : coscoCargoState(label),
      sourceLine: lines[index],
    });
  }
  return events;
}

function parseCoscoTrackingDetail(lines: string[], input: TrackingQuery): TrackingDetail {
  const structuredRoute = coscoRouteFromHeader(lines);
  const routeStops = structuredRoute.routeStops;
  const timelineEvents = coscoTimelineEvents(lines, structuredRoute.headerIndex, routeStops);
  let events = dedupeCoscoEvents([
    ...timelineEvents,
    ...coscoScheduleEvents(lines, timelineEvents),
    ...coscoLatestEvents(lines),
  ]);

  // 兼容旧版/英文版页面：只有在标准五节点标题不存在时才启用严格的标题邻近兜底。
  if (!routeStops.length) {
    for (const { role, label } of COSCO_ROUTE_ROLES) {
      for (let index = 0; index < lines.length; index += 1) {
        if (!label.test(lines[index])) continue;
        const inline = coscoInlineLocation(lines[index], label);
        const location = inline || coscoLocationNear(lines, index, true);
        if (location && !routeStops.some((stop) => coscoExactLocation(stop.name, location))) routeStops.push({ name: location, role });
      }
    }
    events = dedupeCoscoEvents([...events, ...coscoFallbackEvents(lines)]);
  }

  // 官网有时只在事件时间线中提供场站/港口，而不渲染“目的港”等路线标题。
  // 将这些事件地点补入线路节点，避免多港、多次卸船时只显示一个目的港。
  for (const event of events) {
    if (!event.location || routeStops.some((stop) => coscoSameLocation(stop.name, event.location!))) continue;
    routeStops.push({ name: event.location, role: coscoRoleForEvent(event.eventType) });
  }

  return {
    carrierCode: input.rule.code,
    queryType: input.queryType,
    queryValue: input.queryType === 'container' ? input.containerNo : input.queryBillNo,
    capturedAt: new Date().toISOString(),
    routeStops,
    events,
  };
}

export interface BrowserVerificationCallbacks {
  onRequired?: (verification: NonNullable<RunProgress['verification']>) => void;
  onResolved?: () => void;
  shouldSkip?: () => boolean;
}

export function parseRenderedTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const compactText = text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|enable javascript and cookies/i.test(compactText)) {
    throw trackingError('验证码或风控', `${input.rule.name}浏览器页面仍要求安全验证或被风控拦截`);
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `${input.rule.name}浏览器查询未找到 ${queryValue}`);
  }
  if (/\b(?:4|5)\d{2}\s+(?:bad gateway|service unavailable|internal server error|gateway timeout)/i.test(compactText)) {
    throw trackingError('官网接口异常', `${input.rule.name}浏览器页面返回网关或服务器异常`);
  }
  const references = [queryValue, input.originalBillNo, input.containerNo].filter(Boolean).map(normalizedReference);
  const normalizedText = normalizedReference(compactText);
  if (!references.some((reference) => reference && normalizedText.includes(reference))) {
    throw trackingError('解析失败', `${input.rule.name}浏览器页面未显示对应的提单号或柜号，拒绝写入无法核验的数据`);
  }

  const lines = compactText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const coscoDetail = input.rule.code === 'COSCO' ? parseCoscoTrackingDetail(lines, input) : undefined;
  const structuredRouteText = coscoDetail && coscoDetail.routeStops.length >= 2
    ? coscoDetail.routeStops.map((stop) => stop.name).join(' → ')
    : null;
  const routeText = structuredRouteText || parseCarrierRoute({ carrierCode: input.rule.code, text: compactText, lines }) || routeFromRenderedLines(lines);
  const preferDestinationEvent = input.rule.code === 'COSCO';
  const coscoDestinationArrival = input.rule.code === 'COSCO' ? findCoscoDestinationArrival(lines) : null;
  const coscoDestinationStop = coscoDetail?.routeStops.find((stop) => stop.role === 'discharge')?.name || '';
  const sameCoscoLocation = (left: string | null, right: string) => {
    if (!left || !right) return false;
    const normalizedLeft = left.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
    const normalizedRight = right.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
    return normalizedLeft === normalizedRight
      || (normalizedLeft.length >= 5 && normalizedRight.length >= 5 && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)));
  };
  const coscoArrivalEvents = coscoDetail?.events.filter((event) => event.eventType === 'arrival' && event.actual && event.time);
  const coscoDestinationArrivalEvent = coscoArrivalEvents?.filter((event) => sameCoscoLocation(event.location, coscoDestinationStop)).at(-1)
    || coscoArrivalEvents?.at(-1);
  const structuredCoscoArrival = coscoDestinationArrivalEvent?.time ? new Date(coscoDestinationArrivalEvent.time) : null;
  const actualArrivalLabel = input.rule.code === 'ONE'
    ? /\bATA\b|actual(?: time of)? arrival|actual arrival|vessel arrival at port of discharge|POD\/Vessel Arrival|实际到港|实际到达|实际抵达|到港时间|到达目的港/i
    : /\bATA\b|actual(?: time of)? arrival|actual arrival|实际到港|实际到达|实际抵达|到港时间|到达目的港/i;
  const dischargeLabel = input.rule.code === 'ONE'
    ? /actual[^\n]{0,30}discharg|container discharged|discharged|discharge completed|unloaded from vessel at port of discharg(?:e|ing)|full\s+available\s+for\s+delivery|卸船完成|实际卸船|卸载完成|卸船时间/i
    : /actual[^\n]{0,30}discharg|container discharged|discharged|discharge completed|full\s+available\s+for\s+delivery|卸船完成|实际卸船|卸载完成|卸船时间/i;
  const actualArrival = structuredCoscoArrival || coscoDestinationArrival?.date || findLabeledDate(lines, actualArrivalLabel, /estimated|expected|预计/i, preferDestinationEvent);
  const estimatedArrival = findLabeledDate(lines, /\bETA\b|estimated(?: time of)? arrival|expected arrival|预计到港|预计抵达/i, undefined, preferDestinationEvent);
  const mscImportDischarged = input.rule.code === 'MSC'
    ? findLabeledDate(lines, /import\s+discharged\s+from\s+vessel/i, /estimated|expected|planned|预计|计划/i, false, true)
    : null;
  const coscoDischargeEvents = coscoDetail?.events.filter((event) => event.eventType === 'discharge' && event.actual && event.cargoState === 'laden' && event.time);
  const coscoDestinationDischargeEvent = coscoDischargeEvents?.filter((event) => sameCoscoLocation(event.location, coscoDestinationStop)).at(-1)
    || coscoDischargeEvents?.at(-1);
  const structuredCoscoDischarge = coscoDestinationDischargeEvent?.time ? new Date(coscoDestinationDischargeEvent.time) : null;
  const explicitDischarge = structuredCoscoDischarge || mscImportDischarged || findLabeledDate(
    lines,
    dischargeLabel,
    /estimated|expected|planned|预计|计划/i,
    false,
    input.rule.code === 'MSC',
  );
  // COSCO 的公开页面不一定提供单独的“卸船完成时刻”。目的港实际到港之后，
  // 若页面出现提货/还空箱等后续实际节点，只能确认卸船已经完成，不能把 ATA
  // 冒充成卸船时刻。状态可标记为已卸船，卸船时间仍保持为空并明确说明口径。
  const coscoCompletion = input.rule.code === 'COSCO' && Boolean(coscoDetail?.events.some((event) => event.actual && (event.eventType === 'pickup' || event.eventType === 'empty-return')) || lines.some((line, index) => {
    if (!/还空箱|空箱归还|empty\s+(?:returned|return)|pickup\s*time|提货时间|已提货|提货完成|delivery\s+completed/i.test(line)) return false;
    const context = lines.slice(Math.max(0, index - 2), index + 3).join(' ');
    return !/预计|预估|estimated|expected|planned/i.test(context);
  }));
  const discharge = explicitDischarge;
  // MSC 的结果页把“Import Discharged from Vessel”作为目的港到港的第一条
  // 实际事件，不再额外展示 ATA。只要确认了该事件，就同时填入到港和卸船日期。
  const arrivalTime = actualArrival || estimatedArrival || (input.rule.code === 'MSC' ? explicitDischarge : null);
  if (!arrivalTime && !discharge && !coscoCompletion) {
    throw trackingError('解析失败', `${input.rule.name}浏览器已打开订单结果，但没有发现可验证的 ATA、ETA 或实际卸船时间`);
  }
  const arrivalKind: ArrivalKind = actualArrival
    ? 'ATA'
    : estimatedArrival
      ? 'ETA'
      : input.rule.code === 'MSC' && explicitDischarge
        ? 'ATA'
        : null;
  const preserveLocalTime = input.rule.code === 'COSCO' || input.rule.code === 'ONE';
  const arrivalTimeText = preserveLocalTime
    ? coscoDestinationArrivalEvent?.timeText || coscoDestinationArrival?.text || findLabeledDateText(
      lines,
      actualArrival ? actualArrivalLabel : /\bETA\b|estimated(?: time of)? arrival|expected arrival|预计到港|预计抵达/i,
      actualArrival ? /estimated|expected|预计/i : undefined,
      true,
    )
    : null;
  const dischargeTimeText = preserveLocalTime && discharge
    ? coscoDestinationDischargeEvent?.timeText || findLabeledDateText(lines, dischargeLabel, /estimated|expected|planned|预计|计划/i)
    : null;
  const resolvedDischargeTimeText = dischargeTimeText;
  return {
    arrivalTime: arrivalTimeText ? null : arrivalTime,
    arrivalTimeText: arrivalTimeText ? `${arrivalTimeText}（官网当地时间）` : undefined,
    arrivalKind,
    arrived: Boolean(actualArrival || discharge || coscoCompletion),
    discharged: Boolean(discharge || coscoCompletion),
    dischargeTime: resolvedDischargeTimeText ? null : discharge,
    dischargeTimeText: resolvedDischargeTimeText ? `${resolvedDischargeTimeText}（官网当地时间）` : undefined,
    rawSummary: `${input.rule.name}浏览器模拟查询成功；页面已核对${input.queryType === 'container' ? '柜号' : '提单号'}=${queryValue}${explicitDischarge ? '；已发现实际卸船字段' : coscoCompletion ? '；官网后续提货/还空箱事件确认已卸船，但未提供精确卸船时刻' : ''}${routeText ? `；已识别运行线路=${routeText}` : ''}${preserveLocalTime ? '；官网时间按港口当地时间原样保留' : ''}`,
    routeText,
    sourceUrl: input.rule.url,
    trackingDetail: coscoDetail,
    rawPageText: coscoDetail ? compactText : undefined,
  };
}

export async function browserExecutablePath() {
  const configured = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (configured) {
    await fs.access(configured);
    return configured;
  }
  for (const candidate of CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* 尝试下一个系统浏览器 */ }
  }
  throw trackingError('官网接口异常', '未找到可用的 Chrome/Edge 浏览器，请安装 Chrome 或配置 BROWSER_EXECUTABLE_PATH');
}

async function firstVisibleInput(page: Page) {
  for (const frame of page.frames()) {
    for (const selector of INPUT_SELECTORS) {
      const locator = frame.locator(selector);
      for (let index = 0; index < await locator.count(); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) return candidate;
      }
    }
    const fallbackInputs = frame.locator('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
    for (let index = 0; index < await fallbackInputs.count(); index += 1) {
      const candidate = fallbackInputs.nth(index);
      if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function renderedPageText(page: Page) {
  const texts = await Promise.all(page.frames().map(async (frame) => {
    const body = await frame.locator('body').innerText().catch(() => '');
    const inputValues = await frame.locator('input:not([type="hidden"])').evaluateAll((elements) => elements
      .map((element) => element as HTMLInputElement)
      .filter((element) => element.value)
      .map((element) => element.value)
      .join('\n')).catch(() => '');
    return [body, inputValues].filter(Boolean).join('\n');
  }));
  return texts.filter(Boolean).join('\n');
}

function verificationText(text: string) {
  // 单独出现 “challenge” 可能只是官网帮助或推广文案，不能据此判定人机验证。
  return /cloudflare|verify you are human|security check|attention required|access denied|captcha|challenge platform|验证码|安全验证|被阻止|请验证您是真人|滑动以保护|确认本人/i.test(text);
}

function hasTrackingOutcomeText(text: string, queryValue: string, input?: TrackingQuery) {
  const normalizedText = normalizedReference(text);
  if (!normalizedText.includes(normalizedReference(queryValue))) return false;

  if (input?.rule.code === 'ONE') {
    // ONE 会在空结果页的 Recent Track 中回显上一次提单号，同时表头固定包含
    // “POD/Vessel Arrival”。仅凭“单号 + Arrival”会把尚未执行查询的页面误判为成功。
    // 必须再核验非零结果数或本票对应柜号确实已经出现在结果区域。
    const resultCount = Number(text.match(/Total\s+(\d+)\s+results?/i)?.[1] || 0);
    const containerVisible = Boolean(input.containerNo)
      && normalizedText.includes(normalizedReference(input.containerNo));
    if (resultCount < 1 && !containerVisible) return false;
    // 结果表格先渲染，完整线路时间线稍后才挂载。等待起运地、目的地和航行信息
    // 三个区域全部出现，避免只截到结果行、尚未读取实际卸船等后续事件。
    if (!/Place of Receipt/i.test(text)
      || !/Place of Delivery/i.test(text)
      || !/Sailing Information/i.test(text)) return false;
    const timelineEvents = text.match(/Empty Container Release|Gate In to Outbound Terminal|Loaded on Vessel|Vessel Departure|Vessel Arrival|Unloaded from Vessel|Loaded on rail|Inbound Rail|Gate Out from Inbound|Empty Container Returned/gi) || [];
    if (timelineEvents.length < 2) return false;
  }

  if (input?.rule.code === 'MAERSK') {
    // 马士基空查询表单固定包含 “tracking details”，输入框也会回显查询号。
    // 只有对应柜号和至少一个真实/预计运输事件均已渲染才算取得结果。
    const containerVisible = Boolean(input.containerNo)
      && normalizedText.includes(normalizedReference(input.containerNo));
    const eventVisible = /Arrived at|Latest event|Vessel arrival|Estimated vessel arrival|Vessel departure|Discharge|Gate out for delivery|Empty container return/i.test(text);
    if (!containerVisible || !eventVisible) return false;
  }

  return /\bATA\b|\bETA\b|current ETA|arrival in|actual(?: time of)? arrival|estimated(?: time of)? arrival|expected arrival|实际到港|预计到港|实际抵达|预计抵达|discharg|import\s+discharged|full\s+available\s+for\s+delivery|卸船|卸载完成|details/i.test(text);
}

function humanVerificationEnabled() {
  return process.env.BROWSER_HEADLESS === 'false' && process.env.BROWSER_HUMAN_VERIFY !== 'false';
}

function humanVerificationTimeout() {
  const configured = Number(process.env.BROWSER_HUMAN_VERIFY_TIMEOUT_MS || 180_000);
  return Number.isFinite(configured) && configured >= 30_000 ? Math.min(configured, 30 * 60_000) : 180_000;
}

function humanVerificationStableMs() {
  const configured = Number(process.env.BROWSER_HUMAN_VERIFY_STABLE_MS || 10_000);
  return Number.isFinite(configured) && configured >= 3_000 ? Math.min(configured, 30_000) : 10_000;
}

export function verificationStability(clearSince: number, challengeVisible: boolean, now: number, stableMs: number) {
  if (challengeVisible) return { clearSince: 0, resolved: false };
  const nextClearSince = clearSince || now;
  return { clearSince: nextClearSince, resolved: now - nextClearSince >= stableMs };
}

async function waitForManualVerification(page: Page, input: TrackingQuery, callbacks?: BrowserVerificationCallbacks) {
  let text = await renderedPageText(page);
  if (!verificationText(text)) return false;
  if (!humanVerificationEnabled()) {
    throw trackingError('验证码或风控', `${input.rule.name}需要人工通过安全验证；请将 BROWSER_HEADLESS=false 后重试，打开的 Chrome 窗口完成验证后系统会复用本地会话`);
  }
  callbacks?.onRequired?.({
    carrier: input.rule.name,
    carrierCode: input.rule.code,
    billNo: input.originalBillNo,
    containerNo: input.containerNo,
    sourceUrl: page.url() || input.rule.url,
  });
  const timeout = humanVerificationTimeout();
  const stableMs = humanVerificationStableMs();
  console.log(`[BrowserTrackingProvider] ${input.rule.name}需要人工验证，请在打开的 Chrome 窗口完成验证；等待 ${Math.round(timeout / 1000)} 秒`);
  const deadline = Date.now() + timeout;
  let clearSince = 0;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', `${input.rule.name}验证页面已关闭，无法继续查询`);
    if (callbacks?.shouldSkip?.()) {
      throw trackingError('验证码或风控', `${input.rule.name}当前记录已按用户指令跳过人工验证`);
    }
    await page.waitForTimeout(1_000);
    text = await renderedPageText(page);
    const stability = verificationStability(clearSince, verificationText(text), Date.now(), stableMs);
    clearSince = stability.clearSince;
    const hasUsablePage = Boolean(await firstVisibleInput(page)) || text.length > 30;
    if (stability.resolved && hasUsablePage) {
      console.log(`[BrowserTrackingProvider] ${input.rule.name}验证页面已连续稳定 ${Math.round(stableMs / 1000)} 秒，继续等待查询结果`);
      return true;
    }
  }
  throw trackingError('验证码或风控', `${input.rule.name}人工验证等待超时；请完成验证后重新执行该船司查询`);
}

async function waitForCarrierReady(page: Page, input: TrackingQuery, callbacks?: BrowserVerificationCallbacks) {
  const timeout = ['WANHAI', 'SMLINE', 'OOCL', 'CMA', 'HAPAG'].includes(input.rule.code) ? 60_000 : 15_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await waitForManualVerification(page, input, callbacks).catch((error) => { throw error; });
    const text = await renderedPageText(page);
    if (text.trim() || await firstVisibleInput(page)) return;
    await page.waitForTimeout(500);
  }
  throw trackingError('官网接口异常', `${input.rule.name}官网页面长时间未完成加载，未发现可交互的查询界面`);
}

async function preventZimMapScroll(page: Page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    if (!(window as Window & { __portOpsZimScrollPatched?: boolean }).__portOpsZimScrollPatched) {
      Element.prototype.scrollIntoView = function scrollIntoView() {
        void originalScrollIntoView;
      };
      (window as Window & { __portOpsZimScrollPatched?: boolean }).__portOpsZimScrollPatched = true;
    }
  }).catch(() => undefined);
}

async function clickWanhaiTrackingEntry(page: Page) {
  for (const frame of page.frames()) {
    const links = frame.locator('a, button, [role="button"]').filter({ hasText: /cargo tracking|货物追踪|货柜追踪|cargotracking/i });
    for (let index = 0; index < await links.count(); index += 1) {
      const link = links.nth(index);
      if (!await link.isVisible().catch(() => false)) continue;
      await link.click({ timeout: 5_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function openHapagContainerDetails(page: Page, input: TrackingQuery) {
  if (input.rule.code !== 'HAPAG' || !input.containerNo) return false;
  const expected = normalizedReference(input.containerNo);
  for (const frame of page.frames()) {
    const rows = frame.locator('tr');
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const rowText = normalizedReference(await row.innerText().catch(() => ''));
      if (!rowText.includes(expected)) continue;
      const radio = row.locator('input[type="radio"], input[type="checkbox"]');
      if (await radio.count()) await radio.first().check({ force: true }).catch(() => radio.first().click({ force: true }).catch(() => undefined));
      const details = row.locator('button, a, [role="button"]').filter({ hasText: /^details$/i });
      if (await details.count() && await details.first().isVisible().catch(() => false)) {
        await details.first().click({ force: true, timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(750);
        return true;
      }
    }
    const details = frame.locator('button, a, [role="button"]').filter({ hasText: /^details$/i });
    if (await details.count() && await details.first().isVisible().catch(() => false)) {
      await details.first().click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      return true;
    }
  }
  return false;
}

async function clickCookieButton(frame: Frame) {
  const label = /accept all(?: cookies?)?|allow all|同意全部|全部接受|接受所有(?:\s*Cookie)?|允许全部/i;
  const candidates = [
    frame.locator('#onetrust-accept-btn-handler'),
    frame.locator('button, a, [role="button"]').filter({ hasText: label }),
  ];
  for (const group of candidates) {
    for (let index = 0; index < await group.count(); index += 1) {
      const button = group.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      const clicked = await button.click({ force: true, timeout: 3_000 }).then(() => true).catch(async () => {
        return button.evaluate((element) => {
          if (!(element instanceof HTMLElement)) return false;
          element.click();
          return true;
        }).catch(() => false);
      });
      if (clicked) return true;
    }
  }
  return false;
}

async function dismissCookieDialog(page: Page, waitMs = 0) {
  if (waitMs > 0) {
    await Promise.race(page.frames().map((frame) => frame.locator('#onetrust-accept-btn-handler').waitFor({ state: 'visible', timeout: waitMs }))).catch(() => undefined);
  }
  for (const frame of page.frames()) {
    if (!await clickCookieButton(frame)) continue;
    await page.locator('#onetrust-consent-sdk').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function dismissOnePromotion(page: Page) {
  for (const frame of page.frames()) {
    const overlay = frame.locator('[data-testid="tnt-promotion-overlay"]');
    if (!await overlay.isVisible().catch(() => false)) continue;
    const skip = frame.locator('button, [role="button"]').filter({ hasText: /^(?:skip|跳过|关闭)$/i }).last();
    if (await skip.isVisible().catch(() => false)) await skip.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    await overlay.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
  }
}

async function dismissOneResultOverlays(page: Page) {
  for (const frame of page.frames()) {
    const feedbackClose = frame.locator('[class*="SurveyPopup_close-icon"]');
    if (await feedbackClose.isVisible().catch(() => false)) {
      await feedbackClose.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    }
    const cookieClose = frame.locator('[data-cy="cookie-panel-close-btn"], button[aria-label="Close"][class*="CookiePolicy"]');
    if (await cookieClose.isVisible().catch(() => false)) {
      await cookieClose.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    }
  }
}

async function prepareMaerskTrackingForm(page: Page) {
  for (const frame of page.frames()) {
    const bookingType = frame.locator('select').filter({ has: frame.locator('option[value="ocean"]') }).first();
    if (await bookingType.isVisible().catch(() => false)) {
      await bookingType.selectOption('ocean').catch(() => undefined);
    }
  }
}

async function submitMaerskTrackingQuery(page: Page) {
  for (const frame of page.frames()) {
    const track = frame.locator('button[aria-label="Track"], button').filter({ hasText: /^Track$/i }).first();
    if (!await track.isVisible().catch(() => false)) continue;
    await track.click({ force: true, timeout: 5_000 });
    return true;
  }
  return false;
}

async function submitTrackingQuery(inputElement: Locator, page?: Page) {
  const form = inputElement.locator('xpath=ancestor::form[1]');
  if (await form.count()) {
    const submit = form.locator('button[type="submit"], input[type="submit"], button').filter({ hasText: /track|search|submit|查询|追踪/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click({ timeout: 5_000 });
      return;
    }
  }
  const nearbyButtons = inputElement.locator('xpath=..').locator('button, [role="button"], input[type="submit"]');
  for (let index = await nearbyButtons.count() - 1; index >= 0; index -= 1) {
    const button = nearbyButtons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click({ timeout: 5_000 });
    return;
  }
  if (page) {
    for (const frame of page.frames()) {
      const candidates = frame.locator('button, input[type="submit"], input[type="button"], [role="button"]');
      for (let index = 0; index < await candidates.count(); index += 1) {
        const button = candidates.nth(index);
        if (!await button.isVisible().catch(() => false) || !await button.isEnabled().catch(() => false)) continue;
        const label = `${await button.innerText().catch(() => '')} ${await button.getAttribute('aria-label').catch(() => '')} ${await button.getAttribute('title').catch(() => '')}`;
        if (!/track|search|submit|查询|追踪|检索/i.test(label)) continue;
        await button.click({ timeout: 5_000 }).catch(() => undefined);
        return;
      }
    }
  }
  await inputElement.press('Enter');
}

async function submitMscTrackingQuery(inputElement: Locator) {
  const form = inputElement.locator('xpath=ancestor::form[1]');
  const button = form.locator('button.msc-search-autocomplete__search').last();
  if (await button.count() && await button.isVisible().catch(() => false)) {
    await button.click({ force: true, timeout: 5_000 });
    return true;
  }
  return false;
}

async function waitForRenderedOutcome(page: Page, queryValue: string, timeout = RESULT_TIMEOUT_MS, input?: TrackingQuery) {
  const deadline = Date.now() + timeout;
  do {
    const text = await renderedPageText(page);
    if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在|bad gateway|service unavailable|internal server error|gateway timeout/i.test(text)) return;
    if (hasTrackingOutcomeText(text, queryValue, input)) return;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
}

async function waitForOutcomeAndVerification(page: Page, input: TrackingQuery, timeout = RESULT_TIMEOUT_MS, callbacks?: BrowserVerificationCallbacks) {
  const deadline = Date.now() + timeout;
  const normalizedQuery = normalizedReference(input.queryType === 'container' ? input.containerNo : input.queryBillNo);
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', '官网查询页面被关闭，未能取得结果');
    const text = await renderedPageText(page);
    if (verificationText(text)) {
      await waitForManualVerification(page, input, callbacks);
      continue;
    }
    if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(text)) return true;
    if (hasTrackingOutcomeText(text, normalizedQuery, input)) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

export class BrowserTrackingProvider implements TrackingProvider {
  // 复用一个普通 Chrome 进程和按船司隔离的上下文；每次查询只关闭当前页面。
  private browser: Browser | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;

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
    if (sharedBrowser?.isConnected()) {
      this.browser = sharedBrowser;
      return sharedBrowser;
    }
    if (sharedBrowser) {
      sharedBrowser = null;
      sharedContexts.clear();
    }
    if (this.browser?.isConnected()) return this.browser;
    this.browser = null;
    if (!sharedBrowserLaunch) {
      sharedBrowserLaunch = (async () => {
        // 允许通过环境变量控制是否使用有头模式（有头模式反检测效果更好）
        const headless = process.env.BROWSER_HEADLESS !== 'false';
        const browser = await chromium.launch({
          headless,
          executablePath: await browserExecutablePath(),
          args: STEALTH_ARGS,
          ignoreDefaultArgs: ['--enable-automation'],
        });
        browser.on('disconnected', () => {
          if (sharedBrowser === browser) sharedBrowser = null;
          sharedContexts.clear();
        });
        sharedBrowser = browser;
        return browser;
      })();
    }
    try {
      this.browser = await sharedBrowserLaunch;
      return this.browser;
    } finally {
      sharedBrowserLaunch = null;
    }
  }

  private async saveEvidence(page: Page, input: TrackingQuery, outcome: 'success' | 'failure') {
    const evidenceDirectory = sourceEvidenceDirectory(this.dataDirectory, input.rule.code);
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const reference = normalizedReference(input.queryType === 'container' ? input.containerNo : input.originalBillNo).slice(0, 32) || 'UNKNOWN';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${input.rule.code}_${reference}_${outcome}.png`;
    try {
      await page.screenshot({ path: path.join(evidenceDirectory, fileName), fullPage: true });
      return sourceEvidenceUrl(input.rule.code, fileName);
    } catch {
      return undefined;
    }
  }

  private statePath(input: TrackingQuery) {
    return sourceStatePath(this.dataDirectory, input.rule.code);
  }

  private async existingStatePath(input: TrackingQuery) {
    const current = this.statePath(input);
    try {
      await fs.access(current);
      return current;
    } catch {
      const legacy = legacyStatePath(this.dataDirectory, input.rule.code);
      try {
        await fs.access(legacy);
        return legacy;
      } catch {
        return undefined;
      }
    }
  }

  private async getContext(browser: Browser, input: TrackingQuery): Promise<BrowserContext> {
    const existing = sharedContexts.get(input.rule.code);
    if (existing) {
      try {
        await existing.pages();
        return existing;
      } catch {
        sharedContexts.delete(input.rule.code);
      }
    }
    const storageState = await this.existingStatePath(input);
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1920, height: 1080 },
      userAgent: getUserAgent(input.rule.code),
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      ignoreHTTPSErrors: true,
      ...(storageState ? { storageState } : {}),
    });
    await context.addInitScript(STEALTH_INIT_SCRIPT);
    sharedContexts.set(input.rule.code, context);
    return context;
  }

  private async saveState(context: BrowserContext, input: TrackingQuery) {
    const statePath = this.statePath(input);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `${input.rule.name}${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const browser = await this.getBrowser();
    const context = await this.getContext(browser, input);
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    let sourceUrl = input.rule.url;
    let navigationWarning = '';
    let mscResponsePayload: unknown;
    let mscResponsePayloadPromise: Promise<unknown> | undefined;
    let maerskApiRequestFailure = '';
    let maerskApiResponsePromise: Promise<{ status: number; body: string } | undefined> | undefined;
    let maerskApiResponse: { status: number; body: string } | undefined;
    if (input.rule.code === 'MSC') {
      mscResponsePayloadPromise = page.waitForResponse(
        (response) => /\/api\/feature\/tools\/TrackingInfo(?:\?|$)/i.test(response.url()) && response.status() === 200,
        { timeout: this.timeoutMs },
      ).then((response) => response.json()).catch(() => undefined);
    }
    if (input.rule.code === 'MAERSK') {
      maerskApiResponsePromise = page.waitForResponse(
        (response) => /api\.maersk\.com\/synergy\/tracking\//i.test(response.url()),
        { timeout: this.timeoutMs },
      ).then(async (response) => ({ status: response.status(), body: await response.text().catch(() => '') })).catch(() => undefined);
      page.on('requestfailed', (request) => {
        if (!/api\.maersk\.com\/synergy\/tracking\//i.test(request.url())) return;
        maerskApiRequestFailure = request.failure()?.errorText || '官方追踪接口连接中断';
      });
    }
    try {
      if (input.rule.code === 'MSC') {
        // 仅清理 MSC 自己的 Cookie，不关闭 Chrome，也不影响其他船司的人机验证会话。
        await context.clearCookies({ domain: /(?:^|\.)msccargo\.cn$/ }).catch(() => undefined);
      }
      try {
        const navigationUrl = input.rule.code === 'MAERSK' ? new URL(input.rule.url) : probeUrl(input);
        await page.goto(navigationUrl.toString(), { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      } catch (error) {
        if (error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`)) navigationWarning = '页面导航超时后继续检查已加载内容';
        else throw error;
      }
      if (input.rule.code === 'MSC') {
        // MSC 的前端会把上一次失败的空查询状态缓存到 local/sessionStorage；
        // 清理当前站点状态并在同一个 Chrome 页面刷新，不关闭浏览器进程，
        // 避免 macOS 出现“Chrome 未正确关闭”的恢复提示。
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        }).catch(() => undefined);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs }).catch(() => undefined);
      }
      sourceUrl = page.url();
      await waitForCarrierReady(page, input, this.verificationCallbacks);
      const cookies = await context.cookies(sourceUrl);
      let acceptedCookies = await dismissCookieDialog(page);
      await waitForRenderedOutcome(
        page,
        queryValue,
        input.rule.code === 'COSCO' || input.rule.code === 'MSC' ? 8_000 : 1_500,
        input,
      );
      if (!acceptedCookies) acceptedCookies = await dismissCookieDialog(page);
      if (!acceptedCookies && input.rule.code === 'COSCO' && !cookies.some((cookie) => cookie.name === 'cookieClause')) {
        acceptedCookies = await dismissCookieDialog(page, 2_000);
      }
      if (acceptedCookies) {
        await this.saveState(context, input);
        // MSC 接受 Cookie 后会重新挂载追踪表单；给前端一个短暂的重绘窗口，
        // 避免第一次点击落在旧节点上而停留在空白查询页。
        await page.waitForTimeout(1_000);
      }
      if (input.rule.code === 'ONE') await dismissOnePromotion(page);
      if (input.rule.code === 'MAERSK') await prepareMaerskTrackingForm(page);
      const initialText = await renderedPageText(page);
      if (!hasTrackingOutcomeText(initialText, queryValue, input)) {
        if (input.rule.code === 'WANHAI') await clickWanhaiTrackingEntry(page);
        const inputElement = await firstVisibleInput(page);
        if (inputElement) {
          // 真人行为模拟：环境变量控制是否启用
          const humanBehavior = process.env.BROWSER_HUMAN_BEHAVIOR !== 'false';
          if (humanBehavior) {
            await humanDelay(300, 800);       // 查看页面
            await humanType(inputElement, queryValue);  // 模拟打字
            await humanDelay(500, 1200);      // 思考时间
          } else {
            await inputElement.fill(queryValue);
          }
          if (input.rule.code === 'ONE') await dismissOnePromotion(page);
          if (input.rule.code === 'MSC') {
            const submitted = await submitMscTrackingQuery(inputElement);
            if (!submitted) await submitTrackingQuery(inputElement, page);
          } else if (input.rule.code === 'MAERSK') {
            const submitted = await submitMaerskTrackingQuery(page);
            if (!submitted) await submitTrackingQuery(inputElement, page);
          } else {
            await submitTrackingQuery(inputElement, page);
          }
          if (input.rule.code === 'ZIM') await preventZimMapScroll(page);
        }
      }
      const verificationResolved = await waitForManualVerification(page, input, this.verificationCallbacks);
      // 东方海外、森罗验证通过后先等待官网返回结果；只有稳定等待后仍停留在空表单才补交一次。
      if (verificationResolved && (input.rule.code === 'OOCL' || input.rule.code === 'SMLINE')) {
        const outcomeReady = await waitForOutcomeAndVerification(page, input, 30_000, this.verificationCallbacks);
        const afterVerification = await renderedPageText(page);
        if (!outcomeReady && !verificationText(afterVerification)) {
          const inputElement = await firstVisibleInput(page);
          if (inputElement) {
            await humanType(inputElement, queryValue);
            await submitTrackingQuery(inputElement, page);
            await waitForManualVerification(page, input, this.verificationCallbacks);
          }
        }
      }
      if (input.rule.code === 'HAPAG') await openHapagContainerDetails(page, input);
      await waitForOutcomeAndVerification(page, input, Math.min(this.timeoutMs, input.rule.code === 'OOCL' || input.rule.code === 'SMLINE' || input.rule.code === 'ONE' ? 45_000 : RESULT_TIMEOUT_MS), this.verificationCallbacks);
      // ONE 的结果摘要、航行信息和完整事件时间线分批渲染。成功条件出现后再给
      // 时间线一个稳定窗口，避免只读取到前两条节点便开始解析和截图。
      if (input.rule.code === 'ONE') {
        await page.waitForTimeout(3_000);
        await dismissOnePromotion(page);
        await dismissOneResultOverlays(page);
      }
      sourceUrl = page.url();
      if (input.rule.code === 'MAERSK') {
        maerskApiResponse = maerskApiResponsePromise
          ? await Promise.race([
            maerskApiResponsePromise,
            page.waitForTimeout(750).then(() => undefined),
          ])
          : undefined;
        if (!maerskApiResponse && maerskApiRequestFailure) {
          throw trackingError('官网拒绝访问', `马士基官方追踪接口连接被中断（${maerskApiRequestFailure}），不能据此判定订单号无效`);
        }
        if (maerskApiResponse && (maerskApiResponse.status === 403 || maerskApiResponse.status === 412 || /access denied|akamai|captcha|verify you are human/i.test(maerskApiResponse.body))) {
          throw trackingError('验证码或风控', `马士基官方追踪接口被 Akamai 拒绝（HTTP ${maerskApiResponse.status}），不能把官网错误页当成订单号验证失败`);
        }
        if (maerskApiResponse && maerskApiResponse.status >= 500) {
          throw trackingError('官网接口异常', `马士基官方追踪接口返回 HTTP ${maerskApiResponse.status}，本次不写入未经核验的数据`);
        }
      }
      if (mscResponsePayloadPromise) mscResponsePayload = await mscResponsePayloadPromise;
      const renderedText = await renderedPageText(page);
      // MSC 接口已返回完整官方 JSON，但部分 Chrome 会话不会把 Alpine 响应
      // 回填到 DOM；将官方响应作为解析兜底，仍要求提单号和事件日期可核验。
      const parserText = mscResponsePayload
        ? `${renderedText}\n${JSON.stringify(mscResponsePayload, null, 2)}`
        : renderedText;
      let result = input.rule.code === 'MSC' && mscResponsePayload
        ? parseMscTrackingPayload(mscResponsePayload, input, renderedText)
        : input.rule.code === 'MAERSK'
        ? parseMaerskTrackingText(parserText, input)
        : input.rule.code === 'ZIM'
          ? parseZimTrackingText(parserText, input)
          : input.rule.code === 'HAPAG'
            ? parseHapagTrackingText(parserText, input)
            : parseRenderedTrackingText(parserText, input);
      if (input.rule.code === 'MAERSK') {
        // 页面文字负责本次可见结果解析；同一次查询捕获到的 Synergy 官方响应
        // 原样附在详情文件中，完整保留网页尚未展示的字段，供后续核验和解析升级。
        result = {
          ...result,
          rawPageText: [
            '===== 马士基成功结果页面可见文字 =====',
            renderedText,
            maerskApiResponse?.body ? '===== 马士基 Synergy 官方追踪响应 =====\n' + maerskApiResponse.body : '',
          ].filter(Boolean).join('\n\n'),
        };
      }
      const evidencePath = await this.saveEvidence(page, input, 'success');
      const finalRouteText = result.routeText || parseCarrierRoute({ carrierCode: input.rule.code, text: parserText, lines: parserText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }) || undefined;
      return { ...result, sourceUrl, evidencePath, routeText: finalRouteText };
    } catch (error) {
      if (page.isClosed() || /target closed|browser has been closed|context has been closed|page crashed/i.test(error instanceof Error ? error.message : String(error))) {
        throw trackingError('查询超时', `${input.rule.name}浏览器页面已关闭或崩溃，未写入未经核验的数据`, { sourceUrl });
      }
      const failure = classifyTrackingError(error);
      sourceUrl = page.url() || sourceUrl;
      const evidencePath = await this.saveEvidence(page, input, 'failure');
      throw trackingError(failure.category, `${failure.reason}${navigationWarning ? `；${navigationWarning}` : ''}`, { evidencePath, sourceUrl });
    } finally {
      await this.saveState(context, input).catch(() => undefined);
      await page.close().catch(() => undefined);
      // 验证提示保持到本条查询已取得结果或明确结束，避免官网短暂重绘时提示反复出现。
      this.verificationCallbacks?.onResolved?.();
    }
  }

  async close() {
    if (!this.closing) {
      this.closing = (async () => {
        await this.queue;
        // 保留持久化 Chrome；只在进程退出时由操作系统回收浏览器。
        // 直接 browser.close() 会让 Chrome 下次启动弹出恢复页面。
        this.browser = null;
      })();
    }
    await this.closing;
  }
}

export class FallbackTrackingProvider implements TrackingProvider {
  constructor(
    private readonly primary: TrackingProvider,
    private readonly fallback: TrackingProvider,
  ) {}

  async query(input: TrackingQuery) {
    try {
      return await this.primary.query(input);
    } catch (primaryError) {
      try {
        return await this.fallback.query(input);
      } catch (fallbackError) {
        const primaryFailure = classifyTrackingError(primaryError);
        const fallbackFailure = classifyTrackingError(fallbackError);
        // 直连接口已经明确确认“无此号码”时，浏览器侧的验证码/风控不能覆盖
        // 这一可信结论，否则上层将无法继续按业务规则尝试柜号。
        if (isReferenceMissFailure(primaryFailure) && !isReferenceMissFailure(fallbackFailure)) {
          throw trackingError(
            primaryFailure.category,
            `${primaryFailure.reason}；浏览器复核未完成（${fallbackFailure.category}：${fallbackFailure.reason}）`,
            { evidencePath: fallbackFailure.evidencePath || primaryFailure.evidencePath, sourceUrl: fallbackFailure.sourceUrl || primaryFailure.sourceUrl },
          );
        }
        throw trackingError(
          fallbackFailure.category,
          `${fallbackFailure.reason}；直连结果=${primaryFailure.category}：${primaryFailure.reason}`,
          { evidencePath: fallbackFailure.evidencePath, sourceUrl: fallbackFailure.sourceUrl },
        );
      }
    }
  }

  async close() {
    await Promise.all([this.primary.close?.(), this.fallback.close?.()]);
  }
}
