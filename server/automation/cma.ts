import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

export const CMA_TRACKING_SOURCE = 'https://www.cma-cgm.com/ebusiness/tracking';
const DATE_PATTERN = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}(?:-|\s)[A-Za-z]{3,9}(?:-|\s)\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?\b/i;
const TIME_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i;
const TIME_IN_TEXT_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/i;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedReference(left || '');
  const b = normalizedReference(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function linesOf(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/[\r\n\t]+/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
}

function dateNear(lines: string[], index: number) {
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const candidate = lines[index + offset];
    const matched = candidate?.match(DATE_PATTERN)?.[0];
    if (!matched) continue;
    const normalized = matched.replace(/,\s+(?=\d{1,2}:)/, ' ').replace(/\s{2,}/g, ' ').trim();
    if (/\d{1,2}:\d{2}/.test(normalized)) return normalized;
    const inlineTime = candidate?.match(TIME_IN_TEXT_PATTERN)?.[0];
    if (inlineTime) return `${normalized} ${inlineTime}`;
    for (const timeOffset of [1, -1]) {
      const time = lines[index + offset + timeOffset];
      if (time && TIME_PATTERN.test(time)) return `${normalized} ${time}`;
    }
    return normalized;
  }
  return '';
}

function eventDate(lines: string[], label: RegExp, excluded?: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!label.test(lines[index])) continue;
    // Route metadata such as “Port of Discharge” is not an event. If the
    // actual event appears a few lines later, using the route label's nearby
    // date would assign the arrival timestamp to the discharge field.
    if (/^(?:place of receipt|port of loading|port of discharge|place of delivery|origin|destination|pol|pod)\b/i.test(lines[index])) continue;
    // Only exclude the event line itself.  Looking several lines ahead can
    // accidentally see a nearby route label such as “Port of Discharge” and
    // discard a valid “Current ETA” on the preceding line.
    if (excluded?.test(lines[index])) continue;
    const date = dateNear(lines, index);
    if (date) return date;
  }
  return '';
}

function valueAfterLabel(lines: string[], label: RegExp) {
  const matcher = new RegExp(`(?:${label.source})\\s*[:：-]?\\s*(.+)$`, label.flags.replace(/g/g, ''));
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(matcher)?.[1]?.trim();
    if (inline && inline !== ':') return inline;
    if (label.test(lines[index]) && lines[index + 1] && !DATE_PATTERN.test(lines[index + 1])) {
      return lines[index + 1];
    }
  }
  return '';
}

function valueAfterRouteLabel(lines: string[], label: RegExp) {
  const flags = label.flags.replace(/g/g, '');
  const matcher = new RegExp(`^(?:${label.source})\\s*[:：-]?\\s*(.*)$`, flags);
  for (let index = 0; index < lines.length; index += 1) {
    const matched = lines[index].match(matcher);
    if (!matched) continue;
    const inline = matched[1]?.trim();
    if (inline) return inline;
    const next = lines[index + 1];
    if (next && !DATE_PATTERN.test(next)) return next;
  }
  return '';
}

function cmaEventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState; actual: boolean } | null {
  if (/^(?:place of receipt|port of loading|port of discharge|place of delivery|final place of delivery|origin|destination|pol|pod|fpd)\b/i.test(label)) return null;
  if (/empty\s+(?:returned|return)|empty return|returned empty|还空箱/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty', actual: true };
  if (/gate out|picked up|delivery|full available/i.test(label)) return { eventType: 'pickup', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/discharg|unload|import\s+discharged|unloaded from vessel/i.test(label)) return { eventType: 'discharge', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/actual(?: time of)? arrival|arrived at|vessel arrived|arrival at (?:pod|destination)/i.test(label)) return { eventType: 'arrival', cargoState: 'laden', actual: true };
  if (/estimated(?: time of)? arrival|expected arrival|current eta|\bETA\b/i.test(label)) return { eventType: 'arrival', cargoState: 'laden', actual: false };
  if (/depart|loaded on vessel|loaded on board|vessel departure|loaded at/i.test(label)) return { eventType: 'departure', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/gate in|received at terminal|empty container release|shipper'?s owned full|ready to be loaded/i.test(label)) return { eventType: 'origin', cargoState: /empty/i.test(label) ? 'empty' : 'laden', actual: true };
  return null;
}

function placesNear(lines: string[], index: number) {
  const places: string[] = [];
  for (let offset = 1; offset <= 6; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || DATE_PATTERN.test(candidate)) continue;
    if (TIME_PATTERN.test(candidate) || /^(?:date|moves|location(?: terminal)?|status|type|details|customs|place of activity|event|actual|estimated)$/i.test(candidate)) continue;
    // These are metadata rows, not a port/terminal.  Without this guard the
    // vessel row following an event can become a fake route stop.
    if (/^(?:vessel\s*\/\s*voyage|bill of lading|container(?: no\.?| number)?|booking(?: no\.?| number)?)\b/i.test(candidate)) continue;
    if (/^[A-Z][A-Z0-9 .,'/&()\-]{2,}(?:,\s*[A-Z]{2,})?$/i.test(candidate) && !/^(?:CMA|CGM|BL|BILL|CONTAINER|BOOKING)$/i.test(candidate)) places.push(candidate);
    else if (/^[\u4e00-\u9fff]{2,}(?:[，,][\u4e00-\u9fffA-Za-z0-9 .-]{2,})?$/.test(candidate)) places.push(candidate);
    if (places.length >= 2) break;
  }
  return places;
}

function cmaEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const definition = cmaEventDefinition(lines[index]);
    if (!definition) continue;
    const timeText = dateNear(lines, index);
    if (!timeText) continue;
    const [location = null, facility = null] = placesNear(lines, index);
    events.push({
      label: lines[index],
      eventType: definition.eventType,
      location,
      facility,
      time: null,
      timeText,
      actual: definition.actual,
      cargoState: definition.cargoState,
      transportMode: definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' : 'terminal',
      sourceLine: lines[index],
    });
  }
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.label}|${event.timeText}|${event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

function cmaRoute(lines: string[], events: TrackingEventDetail[], destination = '') {
  const definitions: Array<{ label: RegExp; role: TrackingRouteStop['role'] }> = [
    { label: /place of receipt|origin/i, role: 'origin' },
    { label: /port of loading|\bPOL\b/i, role: 'loading' },
    { label: /transshipment|transhipment|中转港/i, role: 'transshipment' },
    { label: /port of discharge|\bPOD\b/i, role: 'discharge' },
    { label: /place of delivery|final place of delivery|destination|\bFPD\b/i, role: 'delivery' },
  ];
  const stops: TrackingRouteStop[] = [];
  for (const definition of definitions) {
    // Route labels must start the line. An event such as
    // "Actual arrival at destination 20 Aug 2026" contains the word
    // destination, but its timestamp is not a route stop.
    const location = valueAfterRouteLabel(lines, definition.label).replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (location && !stops.some((stop) => stop.name.toUpperCase() === location.toUpperCase())) stops.push({ name: location, role: definition.role });
  }
  const chronologicalEvents = [...events].sort((left, right) => {
    const leftTime = Date.parse(left.timeText || '');
    const rightTime = Date.parse(right.timeText || '');
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return 0;
    return leftTime - rightTime;
  });
  for (const event of chronologicalEvents) {
    if (!event.location || stops.some((stop) => stop.name.toUpperCase() === event.location!.toUpperCase())) continue;
    const role = destination && sameLocation(event.location, destination)
      ? 'discharge'
      : event.eventType === 'arrival' || event.eventType === 'discharge'
        ? 'transshipment'
      : event.eventType === 'departure' || event.eventType === 'origin'
        ? 'loading'
        : 'transshipment';
    const deliveryIndex = stops.findIndex((stop) => stop.role === 'delivery');
    if (deliveryIndex >= 0) stops.splice(deliveryIndex, 0, { name: event.location, role });
    else stops.push({ name: event.location, role });
  }
  return stops;
}

export function parseCmaTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = linesOf(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/datadome|captcha-delivery|access temporarily restricted|访问暂时受限|请启用 javascript|disable any ad blocker|无法操作验证页面|security check|cloudflare|verify you are human|captcha|验证码|安全验证/i.test(compactText)) {
    throw trackingError('验证码或风控', '达飞官网仍处于安全验证或访问限制页面');
  }
  if (/no result|not found|no shipment|invalid|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `达飞官网未找到 ${queryValue}`);
  }
  const normalizedText = normalizedReference(compactText);
  if (!normalizedText.includes(normalizedReference(queryValue))) {
    throw trackingError('解析失败', `达飞页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  if (input.containerNo && !normalizedText.includes(normalizedReference(input.containerNo))) {
    throw trackingError('订单号验证失败', `达飞页面未显示输入柜号 ${input.containerNo}`);
  }
  const events = cmaEvents(lines);
  const destination = valueAfterRouteLabel(lines, /port of discharge|\bPOD\b/i);
  const isDestinationEvent = (event: TrackingEventDetail) => !destination || (event.location ? sameLocation(event.location, destination) : false);
  const destinationEvents = events.filter(isDestinationEvent);
  const actualArrival = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual)?.timeText
    || eventDate(lines, /actual(?: time of)? arrival|arrived at|vessel arrived|arrival at (?:pod|destination)/i, /estimated|expected|current eta/i);
  const estimatedArrival = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && !event.actual)?.timeText
    || eventDate(lines, /estimated(?: time of)? arrival|expected arrival|current eta|\bETA\b/i, /actual|arrived|discharg/i);
  const discharge = [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual)?.timeText
    || eventDate(lines, /discharg|unload|import\s+discharged|unloaded from vessel/i, /estimated|expected|planned/i);
  if (!actualArrival && !estimatedArrival && !discharge && !events.length) {
    throw trackingError('解析失败', '达飞官网已返回查询页面，但没有可验证的到港、卸船或运输事件');
  }
  const routeStops = cmaRoute(lines, events, destination);
  const routeText = routeStops.map((stop) => stop.name).join(' → ') || null;
  const facts = [
    ['提单号', input.originalBillNo],
    ['柜号', input.containerNo],
    ['船名/航次', valueAfterLabel(lines, /vessel(?:\s*\/\s*voyage| voyage)?|船名|航次/i)],
    ['当前状态', valueAfterLabel(lines, /current status|status|当前状态/i)],
    ['起运港', valueAfterLabel(lines, /port of loading|\bPOL\b/i)],
    ['卸货港', valueAfterLabel(lines, /port of discharge|\bPOD\b/i)],
    ['最终交付地', valueAfterLabel(lines, /place of delivery|final place of delivery|\bFPD\b/i)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  return {
    arrivalTime: null,
    arrivalTimeText: actualArrival || estimatedArrival || null,
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText: estimatedArrival || null,
    arrived: Boolean(actualArrival || discharge || destinationEvents.some((event) => event.actual && event.eventType === 'arrival')),
    discharged: Boolean(discharge || destinationEvents.some((event) => event.actual && event.eventType === 'discharge')),
    dischargeTime: null,
    dischargeTimeText: discharge || null,
    rawSummary: `达飞官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${actualArrival ? `；实际到港=${actualArrival}` : estimatedArrival ? `；预计到港=${estimatedArrival}` : ''}${discharge ? `；实际卸船=${discharge}` : '；未发现实际卸船事件'}；已解析 ${events.length} 条事件`,
    sourceUrl: CMA_TRACKING_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'CMA',
      queryType: input.queryType,
      queryValue,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText: estimatedArrival || null,
      facts,
    },
    rawPageText: compactText,
  };
}
