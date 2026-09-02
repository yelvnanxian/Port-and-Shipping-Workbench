import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function wanhaiDateText(value: string) {
  return value.match(/\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/)?.[0] || '';
}

function eventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState } | null {
  // The summary/table contains fields such as “卸货港预计到港时间”.  They are
  // metadata, not actual movement events; matching “离港/到港” here would
  // create a fake departure and can also attach the wrong nearby date.
  if (/预计|预估|estimate|estimated|expected/i.test(label)) return null;
  if (/空柜进站|还空箱|empty.*(?:return|gate.?in)/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty' };
  if (/进口重柜领出|提货|pickup|gate.?out.*(?:full|laden)/i.test(label)) return { eventType: 'pickup', cargoState: 'laden' };
  if (/卸船|卸货完成|discharg|unload/i.test(label)) return { eventType: 'discharge', cargoState: 'laden' };
  if (/已到达[A-Z]{5}|实际到达|实际到港|arriv/i.test(label) && !/预计|estimate|expected/i.test(label)) return { eventType: 'arrival', cargoState: 'laden' };
  if (/已开船|离港|开船|depart/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/装船|loaded on/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/重柜进站|网上Booking|舱单制作|gate.?in.*(?:full|laden)/i.test(label)) return { eventType: 'origin', cargoState: 'laden' };
  return null;
}

function locationFromLabel(label: string) {
  return (label.match(/已到达([A-Z]{5})/i)?.[1] || label.match(/([A-Z]{5})已开船/i)?.[1])?.toUpperCase() || null;
}

function nearestDate(lines: string[], index: number) {
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    const candidate = lines[index + offset];
    if (!candidate) continue;
    const date = wanhaiDateText(candidate);
    if (date) return date;
  }
  return '';
}

function parseEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const definition = eventDefinition(lines[index]);
    if (!definition) continue;
    const timeText = nearestDate(lines, index);
    if (!timeText) continue;
    const label = lines[index].replace(wanhaiDateText(lines[index]), '').trim();
    const location = locationFromLabel(label);
    events.push({
      label,
      eventType: definition.eventType,
      location,
      time: null,
      timeText: `${timeText}（官网未标注时区）`,
      actual: true,
      cargoState: definition.cargoState,
      transportMode: /空柜进站|重柜进站|领出|提货/i.test(label) ? 'truck' : definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' : undefined,
      sourceLine: lines[index],
    });
  }
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.label}|${event.timeText}|${event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
}

function routeStops(events: TrackingEventDetail[], origin = '', destination = '') {
  const stops: TrackingRouteStop[] = [];
  for (const event of events) {
    if (!event.location || stops.some((stop) => stop.name === event.location)) continue;
    const role: TrackingRouteStop['role'] = destination && sameLocation(event.location, destination)
      ? 'discharge'
      : origin && sameLocation(event.location, origin)
        ? 'loading'
        : stops.length
          ? 'transshipment'
          : 'origin';
    stops.push({ name: event.location, role });
  }
  if (origin && !stops.some((stop) => sameLocation(stop.name, origin))) stops.unshift({ name: origin, role: 'loading' });
  if (destination && !stops.some((stop) => sameLocation(stop.name, destination))) stops.push({ name: destination, role: 'discharge' });
  return stops;
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedReference(left || '');
  const b = normalizedReference(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function valueAfterLabel(lines: string[], label: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(new RegExp(`${label.source}\\s*[:：]?\\s*(.+)$`, label.flags.replace(/g/g, '')))?.[1]?.trim();
    if (inline) return inline;
    if (label.test(lines[index]) && lines[index + 1] && !wanhaiDateText(lines[index + 1])) return lines[index + 1].trim();
  }
  return '';
}

function firstMatchingLine(lines: string[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line))?.trim() || '';
}

const WanhaiTableFields = [
  '船名/航次',
  '提单号',
  '装货港',
  '装货港预计离港时间',
  '卸货港',
  '卸货港预计到港时间',
  '关单号',
  '提单类型',
  '签单时间',
] as const;

function normalizeFieldLabel(value: string) {
  return value
    .replace(/[：:]/g, '')
    .replace(/裝/g, '装')
    .replace(/卸貨/g, '卸货')
    .replace(/提單/g, '提单')
    .replace(/簽單/g, '签单')
    .replace(/離港/g, '离港')
    .replace(/到港/g, '到港')
    .replace(/關單/g, '关单')
    .trim();
}

/**
 * 万海结果表在浏览器 innerText 中经常按“整行表头 + 整行数据”输出，
 * 而不是 label/value 相邻输出。按固定表头顺序重建字段，避免把“装货港
 * 预计离港时间”误当成装货港，并能读取卸货港预计到港时间。
 */
function parseWanhaiTableFields(lines: string[]) {
  const fields = new Map<string, string>();
  for (let index = 0; index <= lines.length - WanhaiTableFields.length * 2; index += 1) {
    const headerBlock = lines.slice(index, index + WanhaiTableFields.length).map(normalizeFieldLabel);
    if (!WanhaiTableFields.every((label, offset) => headerBlock[offset] === normalizeFieldLabel(label))) continue;
    const valueBlock = lines.slice(index + WanhaiTableFields.length, index + WanhaiTableFields.length * 2)
      .map((value) => value.replace(/^\s*[:：]\s*/, '').trim());
    WanhaiTableFields.forEach((label, offset) => {
      if (valueBlock[offset]) fields.set(label, valueBlock[offset]);
    });
    return fields;
  }
  return fields;
}

function parseWanhaiInlineFields(pageText: string) {
  const fields = new Map<string, string>();
  const labels = [...WanhaiTableFields].sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${labels.join('|')})\\s*[:：]\\s*(.*?)(?=${labels.join('|')}\\s*[:：]|$)`, 'gi');
  for (const match of pageText.matchAll(pattern)) {
    const label = WanhaiTableFields.find((item) => item.toLowerCase() === String(match[1]).toLowerCase());
    const value = String(match[2] || '').trim();
    if (label && value) fields.set(label, value);
  }
  return fields;
}

export function parseWanhaiTrackingText(pageText: string, input: TrackingQuery): TrackingResult {
  // Provider logs may append captured JSON responses after the rendered page.
  // Keep that payload in rawPageText, but do not let API keys/status labels be
  // mistaken for visible movement events while parsing the page itself.
  const renderedPageText = pageText.split(/\n\s*\[WANHAI API /i, 1)[0];
  const normalizedPageText = renderedPageText.replace(/\u00a0/g, ' ');
  const compactText = normalizedPageText.replace(/[ \t]+/g, ' ').trim();
  if (/captcha|cloudflare|verify you are human|验证码|安全验证|滑块|拖拽/i.test(compactText)) {
    throw trackingError('验证码或风控', '万海页面仍停留在安全验证界面');
  }
  if (/未找到|查无|无记录|不存在|no\s+(?:data|result|record)|not found/i.test(compactText)) {
    throw trackingError('订单号验证失败', `万海官网未找到${input.queryType === 'container' ? '柜号' : '提单号'}查询结果`);
  }
  const references = [input.queryType === 'container' ? input.containerNo : input.queryBillNo, input.originalBillNo, input.containerNo]
    .filter(Boolean)
    .map(normalizedReference);
  const normalizedText = normalizedReference(compactText);
  if (!references.some((reference) => reference && normalizedText.includes(reference))) {
    throw trackingError('解析失败', '万海结果页未显示本次提单号或柜号，拒绝写入无法核验的数据');
  }
  const lines = normalizedPageText
    .split(/[\r\n\t]+/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
  const tableFields = parseWanhaiTableFields(lines);
  const inlineFields = parseWanhaiInlineFields(normalizedPageText);
  const readField = (label: (typeof WanhaiTableFields)[number], fallbackPattern: RegExp) => tableFields.get(label)
    || inlineFields.get(label)
    || valueAfterLabel(lines, fallbackPattern);
  const events = parseEvents(lines);
  const origin = readField('装货港', /^装货港$/i);
  const destination = readField('卸货港', /^卸货港$/i);
  const isDestinationEvent = (event: TrackingEventDetail) => !destination
    || (event.location ? sameLocation(event.location, destination) : ['discharge', 'pickup', 'empty-return'].includes(event.eventType));
  const destinationEvents = events.filter(isDestinationEvent);
  const actualArrival = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const discharge = [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  const completion = [...destinationEvents].reverse().find((event) => event.actual && (event.eventType === 'pickup' || event.eventType === 'empty-return'));
  const estimatedArrivalField = readField('卸货港预计到港时间', /^卸货港预计到港时间$/i);
  const estimatedArrivalText = wanhaiDateText(estimatedArrivalField)
    || (lines.findIndex((line) => /卸货港预计到港时间|预计到港|ETA/i.test(line)) >= 0
      ? nearestDate(lines, lines.findIndex((line) => /卸货港预计到港时间|预计到港|ETA/i.test(line)))
      : '');
  if (!actualArrival && !estimatedArrivalText && !discharge && !completion) {
    throw trackingError('解析失败', '万海结果页没有可核验的实际到港、预计到港或卸船后续事件');
  }
  const stops = routeStops(events, origin, destination);
  const routeText = stops.map((stop) => stop.name).join(' → ') || null;
  const facts = [
    ['提单号', firstMatchingLine(lines, /^(?:WHLC)?\d{3}[A-Z]\d{6}$/i)],
    ['柜号', firstMatchingLine(lines, /^[A-Z]{4}\d{7}$/)],
    ['船名/航次', firstMatchingLine(lines, /^[A-Z][A-Z .'-]{2,}\s*\/\s*[A-Z0-9-]{2,}$/i)],
    ['装货港', stops.find((stop) => stop.role === 'loading')?.name || ''],
    ['卸货港', stops.find((stop) => stop.role === 'discharge')?.name || ''],
    ['ISO Code', firstMatchingLine(lines, /^\d{2}[A-Z]\d$/i)],
    ['货物件数/重量', firstMatchingLine(lines, /\b(?:CTN|CARTON|KGS?|KG)\b/i)],
    ['预计到港时间', estimatedArrivalText],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);

  return {
    arrivalTime: null,
    arrivalTimeText: actualArrival?.timeText || (estimatedArrivalText ? `${estimatedArrivalText}（官网未标注时区）` : null),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrivalText ? 'ETA' : null,
    estimatedArrivalTimeText: estimatedArrivalText ? `${estimatedArrivalText}（官网未标注时区）` : null,
    arrived: Boolean(actualArrival || discharge || completion),
    discharged: Boolean(discharge || completion),
    dischargeTime: null,
    dischargeTimeText: discharge?.timeText || null,
    rawSummary: `万海官网解析成功；已核验 ${events.length} 条事件${completion && !discharge ? '；提货/还空箱后续事件确认已卸船，但官网当前文本未提供精确卸船时刻' : ''}`,
    sourceUrl: 'https://cn.wanhai.com/cec/#/cargotracking?q=N',
    routeText,
    trackingDetail: {
      carrierCode: 'WANHAI',
      queryType: input.queryType,
      queryValue: input.queryType === 'container' ? input.containerNo : input.queryBillNo,
      capturedAt: new Date().toISOString(),
      routeStops: stops,
      events,
      currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText: estimatedArrivalText ? `${estimatedArrivalText}（官网未标注时区）` : null,
      facts,
    },
    rawPageText: compactText,
  };
}
