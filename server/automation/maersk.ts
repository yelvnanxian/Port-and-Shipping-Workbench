import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingDetail, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const MAERSK_SOURCE = 'https://www.maersk.com/tracking/';
const DATE_PATTERN = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/;
const EVENT_PATTERN = /^(?:Gate in|Load on|Vessel departure|Vessel arrival|Estimated vessel arrival|Discharge|Gate out for delivery|Empty container return)\b/i;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedLocation(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedLocation(left || '');
  const b = normalizedLocation(right || '');
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aHead = normalizedLocation((left || '').split(',')[0]);
  const bHead = normalizedLocation((right || '').split(',')[0]);
  return Boolean(aHead && bHead && (aHead === bHead || aHead.includes(bHead) || bHead.includes(aHead)));
}

function pageLines(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ ]+/g, ' ').trim())
    .filter(Boolean);
}

function destinationFromHeader(lines: string[]) {
  const headerIndex = lines.findIndex((line) => /bill of lading number/i.test(line));
  if (headerIndex < 0) return '';
  const headerEnd = Math.min(lines.length - 1, headerIndex + 12);
  for (let index = headerIndex; index < headerEnd; index += 1) {
    const headings = lines[index].split(/\t+/).map((value) => value.trim());
    const destinationColumn = headings.findIndex((value) => /^to$/i.test(value));
    if (destinationColumn >= 0) {
      const values = lines[index + 1].split(/\t+/).map((value) => value.trim());
      if (values[destinationColumn]) return values[destinationColumn];
    }

    if (/^to$/i.test(lines[index])) return lines[index + 1];
    const inline = lines[index].match(/(?:^|\s)To\s+([A-Z][A-Z .'-]{2,})$/i)?.[1]?.trim();
    if (inline) return inline;
  }
  return '';
}

function routeFromHeader(lines: string[]) {
  const headerIndex = lines.findIndex((line) => /bill of lading number/i.test(line));
  if (headerIndex < 0) return null;
  const headerEnd = Math.min(lines.length - 1, headerIndex + 12);
  for (let index = headerIndex; index < headerEnd; index += 1) {
    const headings = lines[index].split(/\t+/).map((value) => value.trim().toLowerCase());
    const fromColumn = headings.findIndex((value) => value === 'from');
    const toColumn = headings.findIndex((value) => value === 'to');
    if (fromColumn >= 0 && toColumn >= 0 && lines[index + 1]) {
      const values = lines[index + 1].split(/\t+/).map((value) => value.trim());
      const from = values[fromColumn] || '';
      const to = values[toColumn] || '';
      return from && to ? `${from} → ${to}` : null;
    }
  }
  const route: string[] = [];
  for (let index = headerIndex; index < headerEnd; index += 1) {
    if (/^from$/i.test(lines[index]) && lines[index + 1]) route.push(lines[index + 1]);
    if (/^to$/i.test(lines[index]) && lines[index + 1]) route.push(lines[index + 1]);
  }
  return route.length >= 2 ? route.join(' → ') : null;
}

function destinationTimeline(lines: string[], destination: string) {
  const expected = normalizedLocation(destination);
  if (!expected) return lines;
  let destinationIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const columns = lines[index].split(/\t+/).map((value) => normalizedLocation(value));
    if (columns.some((value) => value === expected)) destinationIndex = index;
  }
  return destinationIndex >= 0 ? lines.slice(destinationIndex) : lines;
}

function eventDate(lines: string[], event: RegExp, excluded = /estimated|expected|planned|scheduled/i) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!event.test(lines[index])) continue;
    const forwardContext = lines.slice(index, index + 3).join(' ');
    if (excluded.test(forwardContext)) continue;
    const matched = forwardContext.match(DATE_PATTERN)?.[0]
      || lines.slice(Math.max(0, index - 2), index + 1).join(' ').match(DATE_PATTERN)?.[0];
    if (matched) return matched;
  }
  return '';
}

function estimatedArrivalDate(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/\bETA\b|estimated(?: vessel)? arrival|expected arrival/i.test(lines[index])) continue;
    const matched = lines.slice(Math.max(0, index - 1), index + 3).join(' ').match(DATE_PATTERN)?.[0];
    if (matched) return matched;
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

function timelineTokens(lines: string[]) {
  const noteIndex = lines.findIndex((line) => /all times are given in local time/i.test(line));
  const source = noteIndex >= 0 ? lines.slice(noteIndex + 1) : lines;
  const endIndex = source.findIndex((line) => /expecting to see more containers|go to shipment details|^plan & book$/i.test(line));
  return (endIndex >= 0 ? source.slice(0, endIndex) : source)
    .flatMap((line) => line.split(/\t+/).map((value) => value.trim()).filter(Boolean));
}

function headingCandidate(value: string) {
  if (!value || value.length > 120 || EVENT_PATTERN.test(value) || DATE_PATTERN.test(value)) return false;
  if (!/[A-Z]/.test(value) || value !== value.toUpperCase()) return false;
  return !/^(?:ACTUAL|ESTIMATED|PLANNED|LATEST EVENT|FROM|TO|BILL OF LADING NUMBER)$/i.test(value);
}

function eventDefinition(source: string): {
  label: string;
  eventType: TrackingEventType;
  cargoState: TrackingCargoState;
  transportMode: NonNullable<TrackingEventDetail['transportMode']>;
} {
  if (/^Empty container return/i.test(source)) return { label: '还空箱', eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/^Gate out for delivery/i.test(source)) return { label: '有货柜出场配送', eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  if (/^Gate in/i.test(source)) return { label: '重箱进入码头', eventType: 'origin', cargoState: 'laden', transportMode: 'terminal' };
  if (/^Load on/i.test(source)) return { label: '有货柜装船', eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/^Vessel departure/i.test(source)) return { label: '船舶实际离港', eventType: 'departure', cargoState: 'unknown', transportMode: 'ocean' };
  if (/^Estimated vessel arrival/i.test(source)) return { label: '船舶预计到港', eventType: 'arrival', cargoState: 'unknown', transportMode: 'ocean' };
  if (/^Vessel arrival/i.test(source)) return { label: '船舶实际到港', eventType: 'arrival', cargoState: 'unknown', transportMode: 'ocean' };
  return { label: '有货柜卸船', eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
}

function eventVessel(source: string) {
  const matched = source.match(/^(?:Load on|Vessel departure|Vessel arrival|Estimated vessel arrival|Discharge)\s*\(?(.+?)\s*\/\s*([A-Z0-9-]+)\)?$/i);
  return {
    vesselName: matched?.[1]?.trim() || null,
    voyageNo: matched?.[2]?.trim() || null,
  };
}

function maerskEvents(lines: string[]) {
  const tokens = timelineTokens(lines);
  const events: TrackingEventDetail[] = [];
  let currentLocation = '';
  let currentFacility = '';
  let pendingHeadings: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const source = tokens[index];
    if (headingCandidate(source)) {
      pendingHeadings.push(source);
      continue;
    }
    if (!EVENT_PATTERN.test(source)) continue;
    if (pendingHeadings.length) {
      currentLocation = pendingHeadings[0];
      currentFacility = pendingHeadings.slice(1).join(' · ');
      pendingHeadings = [];
    }
    const definition = eventDefinition(source);
    const vessel = eventVessel(source);
    const timeText = tokens.slice(index, index + 4).join(' ').match(DATE_PATTERN)?.[0] || null;
    events.push({
      label: definition.label,
      eventType: definition.eventType,
      location: currentLocation || null,
      // 马士基明确说明页面时间为各地点当地时间；无时区时不伪造 UTC 时间。
      time: null,
      timeText,
      actual: !/estimated|expected|planned|scheduled/i.test(source),
      cargoState: definition.cargoState,
      facility: currentFacility || null,
      vesselName: vessel.vesselName,
      voyageNo: vessel.voyageNo,
      transportMode: definition.transportMode,
      sourceLine: source,
    });
  }
  return events;
}

function maerskRouteStops(events: TrackingEventDetail[], headerRoute: string | null, destination: string) {
  const locations: string[] = [];
  const add = (value: string) => {
    const key = normalizedLocation(value);
    if (value && key && !locations.some((item) => normalizedLocation(item) === key)) locations.push(value);
  };
  const headerLocations = (headerRoute || '').split('→').map((value) => value.trim()).filter(Boolean);
  add(headerLocations[0] || '');
  events.forEach((event) => add(event.location || ''));
  add(headerLocations.at(-1) || destination);
  return locations.map((name, index): TrackingRouteStop => ({
    name,
    role: index === 0
      ? 'origin'
      : sameLocation(name, destination) || index === locations.length - 1
        ? 'discharge'
        : 'transshipment',
  }));
}

function fact(label: string, value: string | null | undefined) {
  return value ? [{ label, value }] : [];
}

function relevantPageText(lines: string[]) {
  const start = lines.findIndex((line) => /shipment & container tracking/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /go to shipment details|^plan & book$/i.test(line));
  return lines.slice(start >= 0 ? start : 0, end >= 0 ? end + 1 : lines.length).join('\n');
}

function maerskTrackingDetail(lines: string[], input: TrackingQuery, destination: string, headerRoute: string | null): TrackingDetail {
  const events = maerskEvents(lines);
  const routeStops = maerskRouteStops(events, headerRoute, destination);
  const expectedContainer = normalizedReference(input.containerNo);
  const containerIndex = lines.findIndex((line) => expectedContainer && normalizedReference(line).includes(expectedContainer));
  const containerLine = containerIndex >= 0 ? lines[containerIndex] : '';
  const inlineContainerType = containerLine.split('|').slice(1).join('|').trim();
  const containerType = inlineContainerType || (containerIndex >= 0
    ? lines.slice(containerIndex + 1, containerIndex + 5).find((line) => /\b\d{2}'?\s+.*(?:Standard|High|Reefer|Open Top|Flat Rack)\b/i.test(line)) || ''
    : '');
  const statusIndex = lines.findIndex((line) => /^Arrived at\b|^Departed from\b|^In transit\b/i.test(line));
  const status = statusIndex >= 0 ? lines[statusIndex] : '';
  const statusTime = statusIndex >= 0 ? lines.slice(statusIndex, statusIndex + 3).join(' ').match(DATE_PATTERN)?.[0] || '' : '';
  const lastUpdated = lines.find((line) => /last updated\s*:/i.test(line))?.replace(/^.*?last updated\s*:\s*/i, '') || '';
  const latest = events.at(-1);
  const vesselVoyages = [...new Set(events.flatMap((event) => event.vesselName
    ? [`${event.vesselName}${event.voyageNo ? ` / ${event.voyageNo}` : ''}`]
    : []))].join('、');
  return {
    carrierCode: 'MAERSK',
    queryType: input.queryType,
    queryValue: input.queryType === 'container' ? input.containerNo : input.queryBillNo,
    capturedAt: new Date().toISOString(),
    routeStops,
    events,
    facts: [
      ...fact('提单号', input.originalBillNo),
      ...fact('柜号', input.containerNo),
      ...fact('柜型', containerType),
      ...fact('起运地', routeStops[0]?.name),
      ...fact('目的地', destination || routeStops.at(-1)?.name),
      ...fact('当前状态', status),
      ...fact('当前状态时间', statusTime),
      ...fact('最新动态', latest?.label),
      ...fact('当前地点', latest?.location),
      ...fact('当前场站', latest?.facility),
      ...fact('船舶/航次', vesselVoyages),
      ...fact('官网最后更新', lastUpdated),
    ],
  };
}

export function parseMaerskTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = pageLines(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|enable javascript and cookies/i.test(compactText)) {
    throw trackingError('验证码或风控', '马士基浏览器页面仍要求安全验证或被风控拦截');
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `马士基官网未找到 ${queryValue}`);
  }

  const normalizedText = normalizedReference(compactText);
  const expectedQuery = normalizedReference(queryValue);
  if (!expectedQuery || !normalizedText.includes(expectedQuery)) {
    throw trackingError('解析失败', `马士基页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  const expectedContainer = normalizedReference(input.containerNo);
  if (expectedContainer && !normalizedText.includes(expectedContainer)) {
    throw trackingError('订单号验证失败', `马士基页面返回的轨迹未包含输入柜号 ${input.containerNo}`);
  }

  const destination = destinationFromHeader(lines);
  const headerRoute = routeFromHeader(lines);
  const trackingDetail = maerskTrackingDetail(lines, input, destination, headerRoute);
  const routeText = trackingDetail.routeStops.length >= 2
    ? trackingDetail.routeStops.map((stop) => stop.name).join(' → ')
    : headerRoute;
  const destinationLines = destinationTimeline(lines, destination);
  const destinationEvents = trackingDetail.events.filter((event) => !destination || sameLocation(event.location, destination));
  const structuredDischarge = [...destinationEvents].reverse().find((event) => event.actual && event.eventType === 'discharge' && event.cargoState === 'laden' && event.timeText);
  const structuredArrival = [...destinationEvents].reverse().find((event) => event.actual && event.eventType === 'arrival' && event.timeText);
  const structuredEta = [...destinationEvents].reverse().find((event) => !event.actual && event.eventType === 'arrival' && event.timeText);
  const dischargeTime = structuredDischarge?.timeText || eventDate(destinationLines, /^discharge\b|container discharged|discharged from vessel/i);
  const vesselArrivalTime = structuredArrival?.timeText || eventDate(destinationLines, /^vessel arrival\b|actual(?: time of)? arrival|\bATA\b/i);
  const pageConfirmsArrival = lines.some((line) => /^arrived at\b/i.test(line));
  const actualArrivalTime = pageConfirmsArrival || dischargeTime ? vesselArrivalTime : '';
  const etaTime = actualArrivalTime ? '' : structuredEta?.timeText || estimatedArrivalDate(destinationLines) || estimatedArrivalDate(lines);

  if (!actualArrivalTime && !etaTime && !dischargeTime) {
    throw trackingError('解析失败', '马士基官网已返回对应提单和柜号，但目的港区段没有可验证的 ATA、ETA 或实际卸船时间');
  }

  const arrivalKind = actualArrivalTime ? 'ATA' as const : etaTime ? 'ETA' as const : null;
  const arrivalTimeText = localTime(actualArrivalTime || etaTime);
  const dischargeTimeText = localTime(dischargeTime);
  const currentPort = [...trackingDetail.events].reverse().find((event) => event.actual && event.location)?.location || null;
  const estimatedArrivalPort = destination || trackingDetail.routeStops.find((stop) => stop.role === 'discharge')?.name || null;
  const estimatedArrivalTimeText = etaTime ? localTime(etaTime) : null;
  trackingDetail.currentPort = currentPort;
  trackingDetail.estimatedArrivalPort = estimatedArrivalPort;
  trackingDetail.estimatedArrivalTimeText = estimatedArrivalTimeText;
  return {
    arrivalTime: null,
    arrivalTimeText,
    arrivalKind,
    estimatedArrivalTimeText,
    arrived: Boolean(actualArrivalTime || dischargeTime),
    discharged: Boolean(dischargeTime),
    dischargeTime: null,
    dischargeTimeText,
    rawSummary: `马士基官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${destination ? `；目的港=${destination}` : ''}${actualArrivalTime ? `；目的港实际到港=${actualArrivalTime}` : etaTime ? `；目的港预计到港=${etaTime}` : ''}${dischargeTime ? `；目的港实际卸船=${dischargeTime}` : '；未发现目的港实际卸船事件'}；已解析 ${trackingDetail.events.length} 条完整线路事件；官网明确所有时间均为当地时间`,
    sourceUrl: MAERSK_SOURCE,
    routeText,
    trackingDetail,
    rawPageText: relevantPageText(lines),
  };
}
