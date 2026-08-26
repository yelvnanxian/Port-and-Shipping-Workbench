import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const ZIM_SOURCE = 'https://www.zimchina.com/tools/track-a-shipment';
const DATE_PATTERN = /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}-[A-Za-z]{3,9}-\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedPort(value: string | null | undefined) {
  return (value || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
}

/**
 * 以星有时把港口写成“城市 + 国家”，有时只返回城市或港口代码。
 * 只在两边有足够的港口文本时做包含匹配，避免把中转港事件误判成最终 POD。
 */
function samePort(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedPort(left);
  const b = normalizedPort(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aHead = normalizedPort((left || '').split(',')[0]);
  const bHead = normalizedPort((right || '').split(',')[0]);
  return Boolean(aHead && bHead && (aHead === bHead || aHead.includes(bHead) || bHead.includes(aHead)));
}

function latestLocatedEvent(events: TrackingEventDetail[]) {
  const located = events.filter((event) => event.actual && event.location);
  const withTime = located.filter((event) => event.time).sort((left, right) => new Date(right.time!).getTime() - new Date(left.time!).getTime());
  return withTime[0] || located.at(-1) || null;
}

function rawEventTime(event: TrackingEventDetail | null) {
  return event?.timeText?.replace(/（官网当地时间）$/, '').trim() || '';
}

function eventAtPort(event: TrackingEventDetail, destinationPort: string) {
  if (!destinationPort) return true;
  if (event.location && samePort(event.location, destinationPort)) return true;
  return /(?:port of discharge|destination|pod|final port)/i.test(event.label);
}

function routeStopsFromEvents(
  loading: string,
  discharge: string,
  events: TrackingEventDetail[],
  routeLegs: JsonObject[] = [],
) {
  const stops: TrackingRouteStop[] = [];
  const add = (name: string, role: TrackingRouteStop['role']) => {
    const trimmed = name.trim();
    if (!trimmed || stops.some((stop) => samePort(stop.name, trimmed))) return;
    stops.push({ name: trimmed, role });
  };
  add(loading, 'loading');
  for (const leg of routeLegs) {
    const from = [textValue(leg.portNameFrom), textValue(leg.countryNameFrom)].filter(Boolean).join(', ');
    const to = [textValue(leg.portNameTo), textValue(leg.countryNameTo)].filter(Boolean).join(', ');
    if (from && !samePort(from, loading) && !samePort(from, discharge)) add(from, 'transshipment');
    if (to && !samePort(to, loading) && !samePort(to, discharge)) add(to, 'transshipment');
  }
  for (const event of events) {
    if (!event.location || samePort(event.location, loading) || samePort(event.location, discharge)) continue;
    if (['arrival', 'departure', 'discharge', 'transshipment'].includes(event.eventType)) add(event.location, 'transshipment');
  }
  add(discharge, 'discharge');
  return stops;
}

function linesOf(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/[\r\n\t]+/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
}

function normalizeDateText(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  const monthWithHyphen = compact.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})(.*)$/);
  return monthWithHyphen ? `${monthWithHyphen[1]} ${monthWithHyphen[2]} ${monthWithHyphen[3]}${monthWithHyphen[4]}` : compact;
}

function eventDate(lines: string[], event: RegExp, excluded?: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!event.test(lines[index])) continue;
    const context = lines.slice(index, index + 2).join(' ');
    if (excluded?.test(lines[index])) continue;
    const matched = context.match(DATE_PATTERN)?.[0];
    if (matched) return normalizeDateText(matched);
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

function valueAfterLabel(lines: string[], label: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(new RegExp(`${label.source}\\s*[:：]?\\s*(.+)$`, label.flags))?.[1]?.trim();
    if (inline) return inline;
    if (label.test(lines[index]) && lines[index + 1]) return lines[index + 1];
  }
  return '';
}

function zimEventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState } | null {
  if (/empty container returned|empty return/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty' };
  if (/gate out.*delivery|picked up|delivery/i.test(label) && !/empty.*dispatch/i.test(label)) return { eventType: 'pickup', cargoState: 'laden' };
  if (/discharg|unloaded from vessel/i.test(label)) return { eventType: 'discharge', cargoState: 'laden' };
  if (/vessel arrival|arrived at/i.test(label)) return { eventType: 'arrival', cargoState: 'laden' };
  if (/vessel departure|loaded at port|loaded on vessel/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/export gate-in|gate in.*loading/i.test(label)) return { eventType: 'origin', cargoState: 'laden' };
  if (/empty container dispatched/i.test(label)) return { eventType: 'origin', cargoState: 'empty' };
  if (/carrier release/i.test(label)) return { eventType: 'other', cargoState: 'laden' };
  return null;
}

function zimDateNear(lines: string[], index: number) {
  for (const offset of [0, -1, -2, -3, -4, 1, 2]) {
    const candidate = lines[index + offset];
    if (!candidate) continue;
    const date = candidate.match(DATE_PATTERN)?.[0];
    if (!date) continue;
    const time = lines[index + offset + 1]?.match(/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i)?.[0] || '';
    return normalizeDateText(`${date}${time ? ` ${time}` : ''}`);
  }
  return '';
}

function zimLocationNear(lines: string[], index: number) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || /^(?:Vessel\s*\/\s*Voyage|Date|Activity|Location|Type\s*&\s*Size)$/i.test(candidate)) continue;
    if (/\b(?:CHINA|U\.S\.A|USA|UNITED STATES|REPUBLIC|PORT|TERMINAL|XIAMEN|NEW YORK)\b/i.test(candidate)) return candidate;
  }
  return null;
}

function zimEvents(lines: string[]) {
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    // 路线摘要中的 Port of Discharge/Loading 不是柜动态，不能因为它带有
    // “discharge” 字样就被当成实际卸船事件。
    if (/^Port of (?:Loading|Discharge)\b/i.test(lines[index])) continue;
    const definition = zimEventDefinition(lines[index]);
    if (!definition) continue;
    const timeText = zimDateNear(lines, index);
    if (!timeText) continue;
    const label = lines[index];
    const parsedTime = new Date(timeText).getTime();
    events.push({
      label,
      eventType: definition.eventType,
      location: zimLocationNear(lines, index),
      time: Number.isNaN(parsedTime) ? null : new Date(parsedTime).toISOString(),
      timeText: localTime(timeText),
      actual: true,
      cargoState: definition.cargoState,
      transportMode: definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' as const : undefined,
      sourceLine: label,
    });
  }
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.label}|${event.timeText}|${event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
}

function zimRouteValues(lines: string[]) {
  const routeValue = (name: 'Loading' | 'Discharge', abbreviation: 'POL' | 'POD') => {
    const withAbbreviation = new RegExp(`^Port of ${name}\\s*\\(${abbreviation}\\)\\s*[:：]?\\s*(.+)$`, 'i');
    const plain = new RegExp(`^Port of ${name}\\s*[:：]?\\s+(.+)$`, 'i');
    const exact = new RegExp(`^Port of ${name}(?:\\s*\\(${abbreviation}\\))?\\s*[:：]?$`, 'i');
    for (let index = 0; index < lines.length; index += 1) {
      const inline = lines[index].match(withAbbreviation)?.[1]?.trim() || lines[index].match(plain)?.[1]?.trim();
      if (inline) return inline;
      if (exact.test(lines[index]) && lines[index + 1]) return lines[index + 1];
    }
    return '';
  };
  return { loading: routeValue('Loading', 'POL'), discharge: routeValue('Discharge', 'POD') };
}

function zimRoute(lines: string[], events: TrackingEventDetail[]) {
  const { loading, discharge } = zimRouteValues(lines);
  return routeStopsFromEvents(loading, discharge, events);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function objectArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function zimCompleteResult(text: string) {
  const marker = text.match(/\[ZIM API [^\]]*\/complete-result\?[^\]]*\]\n/i);
  if (!marker?.index && marker?.index !== 0) return null;
  const start = marker.index + marker[0].length;
  const remainder = text.slice(start);
  const end = remainder.search(/\n\n\[ZIM API /);
  const jsonText = (end >= 0 ? remainder.slice(0, end) : remainder).trim();
  try {
    const payload: unknown = JSON.parse(jsonText);
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function activityDefinition(code: string, description: string) {
  const known: Record<string, { eventType: TrackingEventType; cargoState: TrackingCargoState }> = {
    OCLE: { eventType: 'origin', cargoState: 'empty' },
    IEXF: { eventType: 'origin', cargoState: 'laden' },
    LODF: { eventType: 'departure', cargoState: 'laden' },
    CNT_VESSEL_DEPARTURE: { eventType: 'departure', cargoState: 'laden' },
    CNT_VESSEL_ARRIVAL: { eventType: 'arrival', cargoState: 'laden' },
    DISC: { eventType: 'discharge', cargoState: 'laden' },
  };
  return known[code] || zimEventDefinition(description) || { eventType: 'other' as const, cargoState: 'unknown' as const };
}

function parseZimCompleteResult(payload: JsonObject, input: TrackingQuery): TrackingResult | null {
  const consignments = objectArray(payload.consgListItem);
  const expectedBill = normalizedReference(input.originalBillNo);
  const expectedContainer = normalizedReference(input.containerNo);
  const consignment = consignments.find((item) => normalizedReference(textValue(item.referenceNo)) === expectedBill) || consignments[0];
  if (!consignment) return null;
  if (expectedBill && normalizedReference(textValue(consignment.referenceNo)) !== expectedBill) {
    throw trackingError('解析失败', '以星官方完整结果接口返回了其他提单号');
  }
  const details = isObject(consignment.consDetails) ? consignment.consDetails : {};
  const containers = isObject(details.consContainers) ? objectArray(details.consContainers.consContainersItem) : [];
  const container = containers.find((item) => normalizedReference(`${textValue(item.unitPrefix)}${textValue(item.unitNo)}`) === expectedContainer) || containers[0];
  if (expectedContainer && container && normalizedReference(`${textValue(container.unitPrefix)}${textValue(container.unitNo)}`) !== expectedContainer) {
    throw trackingError('订单号验证失败', `以星官方接口未返回输入柜号 ${input.containerNo}`);
  }
  const activities = container && isObject(container.unitActivities) ? objectArray(container.unitActivities.unitActivitiesItem) : [];
  const events: TrackingEventDetail[] = activities.map((activity) => {
    const description = textValue(activity.activityDesc) || textValue(activity.activityCode) || '未知动态';
    const definition = activityDefinition(textValue(activity.activityCode), description);
    const rawTime = textValue(activity.activityDateTz) || textValue(activity.activityDate);
    const locationParts = [
      textValue(activity.placeFromDesc) || textValue(activity.placeFromName) || textValue(activity.locationDesc) || textValue(activity.placeDesc),
      textValue(activity.countryFromName) || textValue(activity.countryName),
    ].filter(Boolean);
    return {
      label: description,
      eventType: definition.eventType,
      location: locationParts.join(', ') || null,
      time: rawTime && !Number.isNaN(new Date(rawTime).getTime()) ? new Date(rawTime).toISOString() : null,
      timeText: rawTime ? `${rawTime}（官网返回时区）` : null,
      actual: true,
      cargoState: definition.cargoState,
      transportMode: definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' as const : undefined,
      sourceLine: description,
    };
  }).sort((left, right) => (left.time ? new Date(left.time).getTime() : 0) - (right.time ? new Date(right.time).getTime() : 0));
  const routeLegs = objectArray(isObject(consignment.blRouteLeg) ? consignment.blRouteLeg.vpBrl : []);
  const firstRouteLeg = routeLegs[0];
  const lastRouteLeg = routeLegs.at(-1);
  const loading = [textValue(details.consPolDesc), textValue(details.consPolCountryName)].filter(Boolean).join(', ')
    || (firstRouteLeg ? [textValue(firstRouteLeg.portNameFrom), textValue(firstRouteLeg.countryNameFrom)].filter(Boolean).join(', ') : '');
  const dischargePort = [textValue(details.consPodDesc), textValue(details.consPodCountryName)].filter(Boolean).join(', ')
    || (lastRouteLeg ? [textValue(lastRouteLeg.portNameTo), textValue(lastRouteLeg.countryNameTo)].filter(Boolean).join(', ') : '');
  // vpBrl 可能包含“起运港→中转港”和“中转港→目的港”两段，不能固定取第 1 段作为最终港口。
  const destinationRouteLeg = [...routeLegs].reverse().find((leg) => {
    const legDestination = [textValue(leg.portNameTo), textValue(leg.countryNameTo)].filter(Boolean).join(', ');
    return Boolean(dischargePort && samePort(legDestination, dischargePort));
  }) || routeLegs.at(-1);
  const destinationDischargeEvent = [...events].reverse().find((event) => event.eventType === 'discharge' && event.actual && eventAtPort(event, dischargePort));
  const destinationArrivalEvent = [...events].reverse().find((event) => event.eventType === 'arrival' && event.actual && eventAtPort(event, dischargePort));
  const routeArrival = destinationRouteLeg ? textValue(destinationRouteLeg.arrivalDateDt) : '';
  const finalEta = isObject(consignment.finalEta) ? textValue(consignment.finalEta.etaPodDate) : '';
  const estimatedArrivalText = finalEta || routeArrival;
  const arrivalIndicator = destinationRouteLeg ? textValue(destinationRouteLeg.arrivalInd).toUpperCase() : '';
  const routeArrivalIsActual = /^(?:ATA|ACTUAL|A)$/i.test(arrivalIndicator);
  const arrivalText = destinationArrivalEvent?.timeText
    || (routeArrivalIsActual && routeArrival ? `${routeArrival}（官网返回时区）` : estimatedArrivalText ? `${estimatedArrivalText}（官网返回时区）` : null);
  const arrivalKind = destinationArrivalEvent || routeArrivalIsActual ? 'ATA' : arrivalText ? 'ETA' : null;
  if (!arrivalText && !destinationDischargeEvent) return null;
  const vesselVoyage = destinationRouteLeg
    ? `${textValue(destinationRouteLeg.vesselName)} / ${[textValue(destinationRouteLeg.voyage), textValue(destinationRouteLeg.leg)].filter(Boolean).join('/')}`.replace(/\s+\/\s*$/, '')
    : '';
  const routeStops = routeStopsFromEvents(loading, dischargePort, events, routeLegs);
  const currentPort = latestLocatedEvent(events)?.location || null;
  const estimatedArrivalTimeText = estimatedArrivalText ? `${estimatedArrivalText}（官网返回时区）` : null;
  const facts = [
    ['提单号', textValue(consignment.referenceNo)],
    ['柜号', container ? `${textValue(container.unitPrefix)}${textValue(container.unitNo)}`.trim() : input.containerNo],
    ['箱型', container ? textValue(container.cargoType) : ''],
    ['船舶/航次', vesselVoyage],
    ['起运港代码', textValue(details.consPol)],
    ['目的港代码', textValue(details.consPod)],
    ['Original ETA', isObject(consignment.agreedEta) ? textValue(consignment.agreedEta.etaDate) : ''],
    ['Current ETA', estimatedArrivalText],
    ['周期状态', textValue(consignment.consCycleStatusDesc)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  return {
    arrivalTime: null,
    arrivalTimeText: arrivalText,
    arrivalKind,
    estimatedArrivalTimeText,
    arrived: Boolean(destinationArrivalEvent || routeArrivalIsActual || destinationDischargeEvent),
    discharged: Boolean(destinationDischargeEvent),
    dischargeTime: null,
    dischargeTimeText: destinationDischargeEvent?.timeText || null,
    rawSummary: `以星官方完整结果接口解析成功；已核验 ${events.length} 条柜动态；最终目的港=${dischargePort || '未提供'}${destinationDischargeEvent ? '；已发现最终目的港实际卸船事件' : '；未发现最终目的港实际卸船事件'}`,
    sourceUrl: ZIM_SOURCE,
    routeText: routeStops.map((stop) => stop.name).join(' → ') || null,
    trackingDetail: {
      carrierCode: 'ZIM',
      queryType: input.queryType,
      queryValue: input.queryType === 'container' ? input.containerNo : input.queryBillNo,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      currentPort,
      estimatedArrivalPort: dischargePort || null,
      estimatedArrivalTimeText,
      facts,
    },
    rawPageText: JSON.stringify(payload),
  };
}

export function parseZimTrackingText(text: string, input: TrackingQuery): TrackingResult {
  // API 证据中可能包含 hcaptcha 配置响应；它只是后台资源，不代表当前可见
  // 页面仍停在验证码。验证/无结果判断只检查第一个 API 证据标记之前的 DOM 文本。
  const visibleText = text.split(/\n\n\[ZIM API /, 1)[0];
  const lines = linesOf(visibleText);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止/i.test(compactText)) {
    throw trackingError('验证码或风控', '以星官网仍要求安全验证或被风控拦截');
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `以星官网未找到 ${queryValue}`);
  }

  const normalizedText = normalizedReference(compactText);
  if (!normalizedText.includes(normalizedReference(queryValue))) {
    throw trackingError('解析失败', `以星页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  if (input.containerNo && !normalizedText.includes(normalizedReference(input.containerNo))) {
    throw trackingError('订单号验证失败', `以星页面未显示输入柜号 ${input.containerNo}`);
  }
  const completeResult = zimCompleteResult(text);
  if (completeResult) {
    const parsed = parseZimCompleteResult(completeResult, input);
    if (parsed) return { ...parsed, rawPageText: text };
  }

  const events = zimEvents(lines);
  const { loading, discharge: destinationPort } = zimRouteValues(lines);
  const destinationEvents = destinationPort ? events.filter((event) => eventAtPort(event, destinationPort)) : events;
  const destinationArrivalEvent = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual) || null;
  const destinationDischargeEvent = [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual) || null;
  const actualArrival = rawEventTime(destinationArrivalEvent) || (destinationPort ? '' : eventDate(
    lines,
    /actual(?: time of)? arrival|arrived at|\bATA\b|vessel arrival at (?:pod|port of discharge)/i,
    /estimated|expected|original|current|planned/i,
  ));
  const estimatedArrival = eventDate(lines, /current ETA|current estimated arrival|estimated time of arrival|\bETA\b/i, /actual|arrived|discharged/i)
    || eventDate(lines, /original ETA/i);
  const discharge = rawEventTime(destinationDischargeEvent) || (destinationPort ? '' : eventDate(lines, /(?:discharged|discharge completed|discharged from vessel|unloaded from vessel|container discharge)/i, /estimated|expected|planned|^Port of Discharge/i));
  const arrivalText = actualArrival || estimatedArrival;
  if (!arrivalText && !discharge) {
    throw trackingError('解析失败', '以星官网已返回订单结果，但没有可验证的 ATA、ETA 或实际卸船时间');
  }

  const routeStops = routeStopsFromEvents(loading, destinationPort, events);
  const routeText = routeStops.map((stop) => stop.name).join(' → ') || null;
  const currentPort = latestLocatedEvent(events)?.location || null;
  const estimatedArrivalTimeText = estimatedArrival ? localTime(estimatedArrival) : null;
  const facts = [
    ['提单号', input.originalBillNo],
    ['柜号', input.containerNo],
    ['Original ETA', eventDate(lines, /Original ETA/i)],
    ['Current ETA', eventDate(lines, /Current ETA/i)],
    ['Berth', eventDate(lines, /^Berth$/i)],
    ['Type & Size', lines.find((line) => /^(?:HC|DC|RF|GP)\d{2}$/i.test(line)) || ''],
    ['Tare Weight', valueAfterLabel(lines, /Tare Weight/i)],
    ['Last Activity', valueAfterLabel(lines, /Last Activity/i)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  return {
    arrivalTime: null,
    arrivalTimeText: localTime(arrivalText),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText,
    arrived: Boolean(actualArrival || discharge),
    discharged: Boolean(discharge),
    dischargeTime: null,
    dischargeTimeText: localTime(discharge),
    rawSummary: `以星官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${actualArrival ? `；实际到港=${actualArrival}` : estimatedArrival ? `；预计到港=${estimatedArrival}` : ''}${discharge ? `；实际卸船=${discharge}` : '；未发现实际卸船事件'}；已解析 ${events.length} 条柜动态；官网时间按当地时间原样保留`,
    sourceUrl: ZIM_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'ZIM',
      queryType: input.queryType,
      queryValue,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      currentPort,
      estimatedArrivalPort: destinationPort || null,
      estimatedArrivalTimeText,
      facts,
    },
    rawPageText: compactText,
  };
}
