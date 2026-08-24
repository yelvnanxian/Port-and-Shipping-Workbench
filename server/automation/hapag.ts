import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

export const HAPAG_BOOKING_SOURCE = 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-booking-solution.html';
export const HAPAG_CONTAINER_SOURCE = 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-container-solution.html';
const DATE_PATTERN = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}(?:-|\s)[A-Za-z]{3,9}(?:-|\s)\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?\b/i;
const TIME_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i;
const TIME_IN_TEXT_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/i;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function linesOf(value: string) {
  return value.replace(/\u00a0/g, ' ').split(/[\r\n\t]+/).map((line) => line.replace(/ {2,}/g, ' ').trim()).filter(Boolean);
}

function eventLabel(value: string) {
  return value.replace(/^(?:Status|Moves?)\s*[:：]?\s*/i, '').trim();
}

function eventDate(lines: string[], event: RegExp, excluded?: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const label = eventLabel(lines[index]);
    if (!event.test(label)) continue;
    if (excluded?.test(label)) continue;
    const matched = dateNear(lines, index);
    if (matched) return matched;
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网未标注时区）` : null;
}

function valueAfterLabel(lines: string[], label: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(new RegExp(`${label.source}\\s*[:：]?\\s*(.+)$`, label.flags))?.[1]?.trim();
    if (inline && inline !== ':') return inline;
    if (label.test(lines[index]) && lines[index + 1]) return lines[index + 1];
  }
  return '';
}

function valueAfterRouteLabel(lines: string[], label: RegExp) {
  const flags = label.flags.replace(/g/g, '');
  const matcher = new RegExp(`^(?:${label.source})\\s*[:：]?\\s*(.*)$`, flags);
  for (let index = 0; index < lines.length; index += 1) {
    const matched = lines[index].match(matcher);
    if (!matched) continue;
    const inline = matched[1]?.trim();
    if (inline) return inline;
    if (lines[index + 1] && !DATE_PATTERN.test(lines[index + 1])) return lines[index + 1];
  }
  return '';
}

function hapagEventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState; actual: boolean } | null {
  if (/^(?:Place of Receipt|Port of Loading|Port of Discharge|Place of Delivery|Destination)\b/i.test(label)) return null;
  if (/empty.*return|returned empty|还空箱/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty', actual: true };
  if (/gate out|picked up|delivery/i.test(label)) return { eventType: 'pickup', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/discharg|unload/i.test(label)) return { eventType: 'discharge', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/actual(?: time of)? arrival|arrived at|container arrived in|arrival at (?:pod|destination)|^arrival in$/i.test(label)) return { eventType: 'arrival', cargoState: 'laden', actual: true };
  if (/estimated arrival|estimated time of arrival|\bETA\b/i.test(label)) return { eventType: 'arrival', cargoState: 'laden', actual: false };
  if (/depart|loaded on vessel|loaded at/i.test(label)) return { eventType: 'departure', cargoState: 'laden', actual: !/estimated|expected|planned/i.test(label) };
  if (/gate in|received at terminal/i.test(label)) return { eventType: 'origin', cargoState: /empty/i.test(label) ? 'empty' : 'laden', actual: true };
  return null;
}

function dateNear(lines: string[], index: number) {
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const candidate = lines[index + offset];
    if (!candidate) continue;
    const matched = candidate.match(DATE_PATTERN)?.[0];
    if (!matched) continue;
    const normalized = matched.replace(/\./g, '-').replace(/,\s+(?=\d{1,2}:)/, ' ').replace(/\s{2,}/g, ' ').trim();
    if (/\d{1,2}:\d{2}/.test(normalized)) return normalized;
    const inlineTime = candidate.match(TIME_IN_TEXT_PATTERN)?.[0];
    if (inlineTime) return `${normalized} ${inlineTime}`;
    for (const timeOffset of [1, -1]) {
      const time = lines[index + offset + timeOffset];
      if (time && TIME_PATTERN.test(time)) return `${normalized} ${time}`;
    }
    return normalized;
  }
  return '';
}

function locationNear(lines: string[], index: number) {
  for (let offset = 1; offset <= 6; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || /^(?:Date|Status|Type|Details|Customs|Place of Activity)$/i.test(candidate)) continue;
    const labeledLocation = candidate.match(/^Place of Activity\s*[:：]?\s*(.+)$/i)?.[1]?.trim();
    if (labeledLocation) return labeledLocation;
    if (/^[A-Z][A-Z .'-]+(?:,\s*[A-Z]{2,})?$/i.test(candidate) && !DATE_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

function hapagEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const label = eventLabel(lines[index]);
    const definition = hapagEventDefinition(label);
    if (!definition) continue;
    const time = dateNear(lines, index);
    if (!time) continue;
    const inlineLocation = label.match(/container arrived in\s+(.+?)\s+at\s+\d{4}/i)?.[1]?.trim() || null;
    events.push({
      label,
      eventType: definition.eventType,
      location: inlineLocation || locationNear(lines, index),
      time: null,
      timeText: localTime(time),
      actual: definition.actual,
      cargoState: definition.cargoState,
      transportMode: definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' : undefined,
      sourceLine: lines[index],
    });
  }
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.label}|${event.timeText}|${event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => {
    const leftTime = Date.parse((left.timeText || '').split('（')[0]);
    const rightTime = Date.parse((right.timeText || '').split('（')[0]);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return (left.timeText || '').localeCompare(right.timeText || '');
    return leftTime - rightTime;
  });
}

function hapagRoute(lines: string[], events: TrackingEventDetail[]) {
  const definitions: Array<{ label: RegExp; role: TrackingRouteStop['role'] }> = [
    { label: /Place of Receipt/i, role: 'origin' },
    { label: /Port of Loading/i, role: 'loading' },
    { label: /Port of Discharge/i, role: 'discharge' },
    { label: /Place of Delivery|Destination/i, role: 'delivery' },
  ];
  const stops: TrackingRouteStop[] = [];
  for (const definition of definitions) {
    const location = valueAfterRouteLabel(lines, definition.label);
    if (location && !stops.some((stop) => stop.name === location)) stops.push({ name: location, role: definition.role });
  }
  for (const event of events) {
    if (!event.location || stops.some((stop) => stop.name.toUpperCase() === event.location!.toUpperCase())) continue;
    const role = event.eventType === 'arrival' || event.eventType === 'discharge'
      ? 'discharge'
      : event.eventType === 'departure' || event.eventType === 'origin'
        ? 'loading'
        : 'transshipment';
    const deliveryIndex = stops.findIndex((stop) => stop.role === 'delivery');
    if (deliveryIndex >= 0) stops.splice(deliveryIndex, 0, { name: event.location, role });
    else stops.push({ name: event.location, role });
  }
  return stops;
}

export function parseHapagTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = linesOf(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/security check|cloudflare|verify you are human|captcha|验证码|安全验证|被阻止/i.test(compactText)) {
    throw trackingError('验证码或风控', '赫伯罗特官网仍要求人工安全验证');
  }
  if (/no result|not found|no shipment|invalid|未找到|查无|无记录/i.test(compactText)) {
    throw trackingError('订单号验证失败', `赫伯罗特官网未找到 ${queryValue}`);
  }
  const normalizedText = normalizedReference(compactText);
  if (!normalizedText.includes(normalizedReference(queryValue))) {
    throw trackingError('解析失败', `赫伯罗特页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  if (input.containerNo && !normalizedText.includes(normalizedReference(input.containerNo))) {
    throw trackingError('订单号验证失败', `赫伯罗特页面未显示输入柜号 ${input.containerNo}`);
  }

  const actualArrival = eventDate(lines, /actual(?: time of)? arrival|arrived at|container arrived in|arrival at (?:pod|destination)|^arrival in$/i, /estimated|expected/i);
  const estimatedArrival = eventDate(lines, /estimated arrival|estimated time of arrival|\bETA\b/i, /actual|arrived|discharg/i);
  const discharge = eventDate(lines, /discharg|unload/i, /estimated|expected|planned/i);
  const events = hapagEvents(lines);
  if (!actualArrival && !estimatedArrival && !discharge && !events.length) {
    throw trackingError('解析失败', '赫伯罗特官网已返回柜号结果，但没有可验证的运输事件');
  }
  const arrivalText = actualArrival || estimatedArrival;
  const routeStops = hapagRoute(lines, events);
  const routeText = routeStops.map((stop) => stop.name).join(' → ') || null;
  const facts = [
    ['提单号', input.originalBillNo],
    ['柜号', input.containerNo],
    ['箱型', valueAfterLabel(lines, /^Type$/i) || lines.find((line) => /^\d{2}(?:GP|HC|RF|DC)$/i.test(line)) || ''],
    ['当前状态', valueAfterLabel(lines, /^Status$/i)],
    ['活动地点', valueAfterLabel(lines, /Place of Activity/i)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  return {
    arrivalTime: null,
    arrivalTimeText: localTime(arrivalText),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    arrived: Boolean(actualArrival || discharge || events.some((event) => event.actual && event.eventType === 'arrival')),
    discharged: Boolean(discharge || events.some((event) => event.actual && event.eventType === 'discharge')),
    dischargeTime: null,
    dischargeTimeText: localTime(discharge),
    rawSummary: `赫伯罗特官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${actualArrival ? `；实际到港=${actualArrival}` : estimatedArrival ? `；预计到港=${estimatedArrival}` : ''}${discharge ? `；实际卸船=${discharge}` : '；未发现实际卸船事件'}；已解析 ${events.length} 条事件`,
    sourceUrl: input.queryType === 'container' ? HAPAG_CONTAINER_SOURCE : HAPAG_BOOKING_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'HAPAG',
      queryType: input.queryType,
      queryValue,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      facts,
    },
    rawPageText: compactText,
  };
}
