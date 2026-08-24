import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function wanhaiDateText(value: string) {
  return value.match(/\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/)?.[0] || '';
}

function eventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState } | null {
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

function routeStops(events: TrackingEventDetail[]) {
  const stops: TrackingRouteStop[] = [];
  for (const event of events) {
    if (!event.location || stops.some((stop) => stop.name === event.location)) continue;
    stops.push({ name: event.location, role: event.eventType === 'arrival' || event.eventType === 'discharge' ? 'discharge' : 'loading' });
  }
  return stops;
}

function firstMatchingLine(lines: string[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line))?.trim() || '';
}

export function parseWanhaiTrackingText(pageText: string, input: TrackingQuery): TrackingResult {
  const normalizedPageText = pageText.replace(/\u00a0/g, ' ');
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
  const events = parseEvents(lines);
  const actualArrival = [...events].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const discharge = [...events].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  const completion = [...events].reverse().find((event) => event.actual && (event.eventType === 'pickup' || event.eventType === 'empty-return'));
  const estimatedArrivalLabel = lines.findIndex((line) => /卸货港预计到港时间|预计到港|ETA/i.test(line));
  const estimatedArrivalText = estimatedArrivalLabel >= 0 ? nearestDate(lines, estimatedArrivalLabel) : '';
  if (!actualArrival && !estimatedArrivalText && !discharge && !completion) {
    throw trackingError('解析失败', '万海结果页没有可核验的实际到港、预计到港或卸船后续事件');
  }
  const stops = routeStops(events);
  const routeText = stops.map((stop) => stop.name).join(' → ') || null;
  const facts = [
    ['提单号', firstMatchingLine(lines, /^(?:WHLC)?\d{3}[A-Z]\d{6}$/i)],
    ['柜号', firstMatchingLine(lines, /^[A-Z]{4}\d{7}$/)],
    ['船名/航次', firstMatchingLine(lines, /^[A-Z][A-Z .'-]{2,}\s*\/\s*[A-Z0-9-]{2,}$/i)],
    ['装货港', stops.find((stop) => stop.role === 'loading')?.name || ''],
    ['卸货港', stops.find((stop) => stop.role === 'discharge')?.name || ''],
    ['ISO Code', firstMatchingLine(lines, /^\d{2}[A-Z]\d$/i)],
    ['货物件数/重量', firstMatchingLine(lines, /\b(?:CTN|CARTON|KGS?|KG)\b/i)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);

  return {
    arrivalTime: null,
    arrivalTimeText: actualArrival?.timeText || (estimatedArrivalText ? `${estimatedArrivalText}（官网未标注时区）` : null),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrivalText ? 'ETA' : null,
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
      facts,
    },
    rawPageText: compactText,
  };
}
