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
  if (/空柜進站|空柜进站|还空箱|還空箱|empty.*(?:return|gate.?in)/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty' };
  if (/进口重柜领出|進口重櫃領出|提货|提貨|pickup|gate.?out.*(?:full|laden)/i.test(label)) return { eventType: 'pickup', cargoState: 'laden' };
  if (/进[口入]重柜卸船|進口重櫃卸船|卸船|卸貨|卸货完成|discharg|unload/i.test(label)) return { eventType: 'discharge', cargoState: 'laden' };
  if (/已到达[A-Z]{5}|已到達[A-Z]{5}|实际到达|實際到達|实际到港|實際到港|arriv/i.test(label) && !/预计|預計|estimate|expected/i.test(label)) return { eventType: 'arrival', cargoState: 'laden' };
  if (/已开船|已開船|离港|離港|开船|開船|depart/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/装船|裝船|loaded on/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/重柜进站|重櫃進場|重櫃內陸|出口重櫃進場|网上Booking|舱单制作|gate.?in.*(?:full|laden)/i.test(label)) return { eventType: 'origin', cargoState: 'laden' };
  return null;
}

function locationFromLabel(label: string) {
  return (label.match(/已到(?:达|達)([A-Z]{5})/i)?.[1] || label.match(/([A-Z]{5})已(?:开|開)船/i)?.[1])?.toUpperCase() || null;
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
  const addStop = (name: string, role: TrackingRouteStop['role']) => {
    if (!name || stops.some((stop) => sameLocation(stop.name, name))) return;
    stops.push({ name, role });
  };

  // 万海接口通常按“最新事件在前”返回；线路不能直接沿用接口顺序，
  // 必须以 booking 的 POL/POD 为边界，保证起运港始终在前、目的港始终在后。
  if (origin) addStop(origin, 'loading');
  for (const event of events) {
    if (!event.location || (origin && sameLocation(event.location, origin)) || (destination && sameLocation(event.location, destination))) continue;
    addStop(event.location, stops.length ? 'transshipment' : 'origin');
  }
  if (destination) addStop(destination, 'discharge');

  // 没有 booking 港口字段时，退回事件实际顺序；此时仅能按官网返回的
  // 事件顺序展示，不推断不存在的起运港或目的港。
  if (!stops.length) {
    for (const event of events) {
      if (event.location) addStop(event.location, stops.length ? 'transshipment' : 'origin');
    }
  }
  return stops;
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedReference(left || '');
  const b = normalizedReference(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function valueAfterLabel(lines: string[], label: RegExp) {
  const fieldLabels = new Set(WanhaiTableFields.map((item) => normalizeFieldLabel(item)));
  const validValue = (value: string) => {
    const trimmed = value.trim();
    const normalized = normalizeFieldLabel(trimmed);
    if (!trimmed || fieldLabels.has(normalized)) return '';
    // 避免把“卸货港预计到港时间”等相邻字段标题当成港口值。
    if (/^(?:装货港|卸货港)(?:预计离港时间|预计到港时间)$/.test(normalized)) return '';
    return trimmed;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const inline = validValue(lines[index].match(new RegExp(`${label.source}\\s*[:：]?\\s*(.+)$`, label.flags.replace(/g/g, '')))?.[1] || '');
    if (inline) return inline;
    if (!label.test(lines[index])) continue;
    // 标签和值之间可能重复渲染字段名或插入占位行，最多向后查看四行。
    for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset].trim();
      if (fieldLabels.has(normalizeFieldLabel(candidate))) break;
      const value = validValue(candidate);
      if (value && !wanhaiDateText(value)) return value;
    }
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

function validWanhaiPort(value: string) {
  const normalized = normalizeFieldLabel(value);
  if (!value || /^(?:装货港|卸货港|卸货港预计到港时间|装货港预计离港时间|预计到港|ETA)$/i.test(normalized)) return '';
  if (/^(?:—|-|暂无|待更新|未提供)$/i.test(value.trim())) return '';
  return value.trim();
}

type WanhaiApiPayload = { url: string; value: Record<string, unknown> };

function extractWanhaiApiPayloads(pageText: string): WanhaiApiPayload[] {
  const payloads: WanhaiApiPayload[] = [];
  const marker = /\[WANHAI API ([^\]]+)\]\s*\n/g;
  const matches = [...pageText.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = (matches[index].index || 0) + matches[index][0].length;
    const end = matches[index + 1]?.index || pageText.length;
    const raw = pageText.slice(start, end).trim();
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object') payloads.push({ url: matches[index][1], value: value as Record<string, unknown> });
    } catch {
      // 证据文件可能包含被截断的响应；渲染文本解析仍可继续。
    }
  }
  return payloads;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function textValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function apiDateText(value: unknown) {
  const text = textValue(value);
  return wanhaiDateText(text) || text.match(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/)?.[0] || '';
}

function parseWanhaiApiDetail(pageText: string, input: TrackingQuery) {
  const payloads = extractWanhaiApiPayloads(pageText);
  const trackingPayload = payloads.find((item) => /wdcec109_m\.do/i.test(item.url));
  if (!trackingPayload) return null;
  const datas = asRecord(trackingPayload.value.datas);
  if (!datas) return null;
  const rtss = asRecords(datas.RTSS);
  const booking = asRecords(datas.bookingInfo)[0] || {};
  const dynamicRows = asRecords(datas.bookingDymc);
  const reference = normalizedReference(input.queryBillNo);
  const exactRows = payloads
    .filter((item) => /getDynamicCtnr\.do/i.test(item.url))
    .flatMap((item) => asRecords(item.value.datas));
  const matchingRows = exactRows.filter((row) => {
    const bill = normalizedReference(textValue(row.book_no));
    return !bill || !reference || bill === reference;
  });
  // 若响应中包含其他提单的记录，不能因为本单没有命中就把其他货柜的
  // 动态写入当前订单。仅保留无提单号的公共货柜行（官网有时会省略）。
  const rows = matchingRows.length
    ? matchingRows
    : exactRows.some((row) => normalizedReference(textValue(row.book_no)))
      ? exactRows.filter((row) => !normalizedReference(textValue(row.book_no)))
      : exactRows;
  const origin = validWanhaiPort(textValue(booking.pol) || textValue(booking.plr));
  const destination = validWanhaiPort(textValue(booking.pod));
  // RTSS 使用 place_code_d 表示目的港（部分旧响应才会带 pod）。
  // 必须先按 bookingInfo 的 POD 精确匹配，不能因为 destination 有值就
  // 让每一条 RTSS 都命中第一条，避免多航段时拿到错误的 ETA。
  const schedule = rtss.find((item) => {
    const itemDestination = validWanhaiPort(textValue(item.place_code_d) || textValue(item.pod));
    return destination ? Boolean(itemDestination && sameLocation(itemDestination, destination)) : Boolean(itemDestination);
  }) || rtss[0] || {};
  const etaValue = apiDateText(schedule.s_arr_datetime_d);
  const scheduleStatus = `${textValue(schedule.status_d_d)} ${textValue(schedule.status_d_a)}`;
  const scheduleActual = /\bACTUAL\b|实际|實際/i.test(scheduleStatus);
  const etaEstimated = !scheduleActual && Boolean(etaValue);
  const eventRows: TrackingEventDetail[] = rows
    .map((row): TrackingEventDetail | null => {
      const label = textValue(row.ctnr_status_desc);
      const definition = eventDefinition(label);
      if (!definition) return null;
      const timeText = apiDateText(row.ctnr_date_tpe);
      if (!timeText) return null;
      const location = validWanhaiPort(textValue(row.ctnr_place) || textValue(row.place_name));
      return {
        label,
        eventType: definition.eventType,
        location: location || null,
        time: null,
        timeText: `${timeText}（官网未标注时区）`,
        actual: !/预计|預計|estimate|expected/i.test(label),
        cargoState: definition.cargoState,
        transportMode: /進口重櫃領出|进口重柜领出|空櫃|空柜|進場|进场|轉運|转运/i.test(label) ? 'truck' as const : 'ocean' as const,
        sourceLine: label,
      };
    })
    .filter((item): item is TrackingEventDetail => Boolean(item));
  const uniqueEventRows = new Map<string, TrackingEventDetail>();
  for (const event of eventRows) {
    const key = `${event.eventType}|${event.label}|${event.location || ''}|${event.timeText || ''}`.toUpperCase();
    if (!uniqueEventRows.has(key)) uniqueEventRows.set(key, event);
  }
  const dynamicActualArrival = dynamicRows
    .map((row) => ({ label: textValue(row.remark), timeText: apiDateText(row.format_date) }))
    .find((item) => /已到(?:达|達)/i.test(item.label) && !/未到(?:达|達)/i.test(item.label));
  const apiArrivalText = dynamicActualArrival?.timeText || (scheduleActual ? etaValue : '');
  const apiActualArrival = Boolean(apiArrivalText);
  const sortedEventRows = [...uniqueEventRows.values()];
  if (apiActualArrival && !sortedEventRows.some((event) => event.eventType === 'arrival' && event.actual)) {
    const arrivalLocation = validWanhaiPort(dynamicActualArrival?.label.match(/已到(?:达|達)([A-Z]{5})/i)?.[1] || destination);
    sortedEventRows.push({
      label: dynamicActualArrival?.label || '实际到港',
      eventType: 'arrival',
      location: arrivalLocation || null,
      time: null,
      timeText: `${apiArrivalText}（官网未标注时区）`,
      actual: true,
      cargoState: 'laden',
      transportMode: 'ocean',
      sourceLine: dynamicActualArrival?.label || '实际到港',
    });
  }
  sortedEventRows.sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
  const currentEvent = sortedEventRows.at(-1);
  const apiDischarge = sortedEventRows.filter((event) => event.eventType === 'discharge' && event.actual && (!destination || !event.location || sameLocation(event.location, destination))).at(-1);
  const stops = routeStops(sortedEventRows, origin, destination);
  return {
    origin,
    destination,
    etaText: !apiActualArrival && etaEstimated ? etaValue : '',
    actualArrivalText: apiArrivalText,
    events: sortedEventRows,
    currentPort: currentEvent?.location || null,
    dischargeEvent: apiDischarge || null,
    stops,
    booking,
  };
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
  const apiDetail = parseWanhaiApiDetail(pageText, input);
  const events = apiDetail?.events.length ? apiDetail.events : parseEvents(lines);
  const origin = apiDetail?.origin || validWanhaiPort(readField('装货港', /^装货港$/i));
  const destination = apiDetail?.destination || validWanhaiPort(readField('卸货港', /^卸货港$/i));
  const isDestinationEvent = (event: TrackingEventDetail) => !destination
    || (event.location ? sameLocation(event.location, destination) : ['discharge', 'pickup', 'empty-return'].includes(event.eventType));
  const destinationEvents = events.filter(isDestinationEvent);
  const actualArrival = apiDetail?.actualArrivalText
    ? { timeText: `${apiDetail.actualArrivalText}（官网未标注时区）` }
    : [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const discharge = apiDetail?.dischargeEvent || [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  const completion = [...destinationEvents].reverse().find((event) => event.actual && (event.eventType === 'pickup' || event.eventType === 'empty-return'));
  const estimatedArrivalField = readField('卸货港预计到港时间', /^卸货港预计到港时间$/i);
  // 官方接口已明确给出 ATA/ETA 时，以接口状态为准；不能在 ATA
  // 已存在时再从旧页面摘要回填同一个日期并标成 ETA。
  const estimatedArrivalText = apiDetail
    ? apiDetail.etaText
    : wanhaiDateText(estimatedArrivalField)
      || (lines.findIndex((line) => /卸货港预计到港时间|预计到港|ETA/i.test(line)) >= 0
        ? nearestDate(lines, lines.findIndex((line) => /卸货港预计到港时间|预计到港|ETA/i.test(line)))
        : '');
  if (!actualArrival && !estimatedArrivalText && !discharge && !completion) {
    throw trackingError('解析失败', '万海结果页没有可核验的实际到港、预计到港或卸船后续事件');
  }
  // 若摘要未提供卸货港，才使用实际到达事件的真实地点补齐；不会使用
  // 字段标题或当前港口作为预计到达港口。
  const eventDestination = [...events].reverse().find((event) => event.eventType === 'arrival' && event.location)?.location || '';
  const resolvedDestination = destination || validWanhaiPort(eventDestination);
  const stops = apiDetail?.stops?.length ? apiDetail.stops : routeStops(events, origin, resolvedDestination);
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
      estimatedArrivalPort: resolvedDestination || null,
      estimatedArrivalTimeText: estimatedArrivalText ? `${estimatedArrivalText}（官网未标注时区）` : null,
      facts,
    },
    // 保留渲染文本和官方接口响应，便于证据复核以及后续解析规则升级。
    rawPageText: pageText,
  };
}
