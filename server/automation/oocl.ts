import type { TrackingProvider } from './tracker.js';
import { trackingError } from './errors.js';
import { requestContext } from './official-http.js';
import type { ArrivalKind, TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const OOCL_TRACKING_ENDPOINT = 'https://moc.oocl.com/appleapp/rest/ctLite/getCTDetails';
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

interface OoclResponse {
  result?: {
    responseCode?: string;
    exceptionCode?: string;
    searchResultRecord?: unknown;
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(object: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = textValue(object[key]);
    if (value) return value;
  }
  return '';
}

/**
 * OOCL Lite returns dates without a timezone in several formats. Those values
 * are local port times; this workbench normalizes timezone-less values as
 * Asia/Shanghai (UTC+8), while preserving explicit offsets from ISO strings.
 */
export function parseOoclDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const source = textValue(value);
  if (!source || /^(?:n\/?a|null|undefined|-)$/i.test(source)) return null;

  // Strings carrying Z or an explicit offset are absolute instants.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)) {
    const absolute = new Date(source);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }

  let parts: RegExpMatchArray | null;
  if ((parts = source.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/))) {
    return beijingDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
  }
  if ((parts = source.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)(?:[ T]([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    return beijingDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  if ((parts = source.match(/^([0-3]?\d)[-/]([01]?\d)[-/](\d{4})(?:[ T]([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    return beijingDate(Number(parts[3]), Number(parts[2]), Number(parts[1]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  if ((parts = source.match(/^([0-3]?\d)\s+([A-Za-z]{3,9})\s+(\d{4})(?:\s+([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    const month = monthNumber(parts[2]);
    if (month) return beijingDate(Number(parts[3]), month, Number(parts[1]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  return null;
}

function beijingDate(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  if (
    month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
  ) return null;
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function monthNumber(value: string) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const index = months.indexOf(value.slice(0, 3).toLowerCase());
  return index < 0 ? 0 : index + 1;
}

function parseOoclControlTowerDate(value: string) {
  const matched = value.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+([A-Z]{2,5})$/);
  if (!matched) return parseOoclDate(value);
  const month = monthNumber(matched[2]);
  const offsets: Record<string, number> = {
    CST: 8 * 60,
    PDT: -7 * 60,
    PST: -8 * 60,
    UTC: 0,
    GMT: 0,
  };
  const offset = offsets[matched[6]];
  if (!month || offset === undefined) return null;
  return new Date(Date.UTC(
    Number(matched[3]),
    month - 1,
    Number(matched[1]),
    Number(matched[4]),
    Number(matched[5]) - offset,
  ));
}

function ooclEventDefinition(label: string): { eventType: TrackingEventType; cargoState: TrackingCargoState } {
  if (/卸货|discharg|unload/i.test(label)) return { eventType: 'discharge', cargoState: 'laden' };
  if (/^预计到达$|^预计抵达$|estimated\s+(?:vessel\s+)?arrival|expected\s+arrival|\bETA\b/i.test(label)) return { eventType: 'arrival', cargoState: 'laden' };
  if (/^到达$|arrival|arrived/i.test(label)) return { eventType: 'arrival', cargoState: 'laden' };
  if (/^离港$|departure|departed/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/^装船$|loaded on vessel|load of laden/i.test(label)) return { eventType: 'departure', cargoState: 'laden' };
  if (/重箱进场|gate in.*laden/i.test(label)) return { eventType: 'origin', cargoState: 'laden' };
  if (/提空箱|empty.*(?:release|pickup)|gate out.*empty/i.test(label)) return { eventType: 'origin', cargoState: 'empty' };
  if (/还空箱|empty.*return/i.test(label)) return { eventType: 'empty-return', cargoState: 'empty' };
  if (/提货|gate out.*laden|delivery/i.test(label)) return { eventType: 'pickup', cargoState: 'laden' };
  return { eventType: 'other', cargoState: 'unknown' };
}

function ooclTimelineEvents(lines: string[]) {
  const eventNameSource = '目的港预计卸货|预计卸货|目的港预计到达|预计船舶到达|预计到达|预计抵达|ETA|目的港卸货|卸货|到达|离港|装船|重箱进场|提空箱|还空箱|提货|Estimated Discharge|Estimated Vessel Arrival|Estimated Arrival|Discharge|Arrival|Departure|Loaded on Vessel|Gate In|Gate Out';
  const eventLabel = new RegExp(`^(?:${eventNameSource})$`, 'i');
  const inlineEvent = new RegExp(`^(${eventNameSource})\\s+(\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4}\\s+\\d{1,2}:\\d{2}\\s+[A-Z]{2,5})(?:\\s+(.+))?$`, 'i');
  const header = lines.findIndex((line, index) => /^动态$/i.test(line) && lines.slice(index, index + 6).some((item) => /^时间$/i.test(item)));
  const end = lines.findIndex((line, index) => index > header && /^提单信息$/i.test(line));
  const timeline = header >= 0 ? lines.slice(header + 1, end >= 0 ? end : lines.length) : lines;
  const ignoredLocation = /^(?:时间|位置|阶段|运输方式|Ocean|Outbound|Inbound|Terminal|Vessel|Truck|Rail|Merchant)$/i;
  const events: TrackingEventDetail[] = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const inline = timeline[index].match(inlineEvent);
    const label = inline?.[1] || timeline[index];
    if (!inline && !eventLabel.test(label)) continue;
    const timeIndex = inline
      ? index
      : [index + 1, index + 2, index + 3].find((candidate) => candidate < timeline.length && parseOoclControlTowerDate(timeline[candidate]));
    if (timeIndex === undefined) continue;
    const nextEvent = timeline.findIndex((line, candidate) => candidate > timeIndex && (eventLabel.test(line) || inlineEvent.test(line)));
    const blockEnd = nextEvent >= 0 ? nextEvent : timeline.length;
    const rawCandidates = inline
      ? [inline[3] || ''].filter(Boolean)
      : timeline.slice(timeIndex + 1, blockEnd)
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = rawCandidates.filter((line) => !ignoredLocation.test(line) && !/^\d+$/.test(line));
    const facility = candidates[0] || null;
    const location = candidates.find((candidate, candidateIndex) => candidateIndex > 0 && candidate.length <= 80) || facility;
    const definition = ooclEventDefinition(label);
    const rawTime = inline?.[2] || timeline[timeIndex];
    const parsed = parseOoclControlTowerDate(rawTime);
    events.push({
      label,
      eventType: definition.eventType,
      location,
      facility: facility && facility !== location ? facility : null,
      time: parsed?.toISOString() || null,
      timeText: `${rawTime}（官网当地时间）`,
      actual: !/预计|预估|estimated|expected|planned|\bETA\b/i.test(label),
      cargoState: definition.cargoState,
      transportMode: rawCandidates.some((candidate) => /^Truck$/i.test(candidate))
        ? 'truck'
        : rawCandidates.some((candidate) => /^Rail$/i.test(candidate))
          ? 'rail'
          : rawCandidates.some((candidate) => /^Vessel$/i.test(candidate))
            ? 'ocean'
            : 'terminal',
      sourceLine: [label, rawTime, facility, location].filter(Boolean).join(' · '),
    });
  }
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.label}|${event.time || event.timeText}|${event.facility || event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => (left.time ? new Date(left.time).getTime() : 0) - (right.time ? new Date(right.time).getTime() : 0));
}

function normalizedPort(value: string | null | undefined) {
  return (value || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
}

function samePort(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedPort(left);
  const b = normalizedPort(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function ooclRouteStops(events: TrackingEventDetail[], destination = ''): TrackingRouteStop[] {
  const stops: TrackingRouteStop[] = [];
  for (const event of events) {
    const name = event.facility || event.location;
    if (!name) continue;
    const key = name.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
    if (stops.some((stop) => stop.name.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '') === key)) continue;
    const role: TrackingRouteStop['role'] = destination && samePort(name, destination)
      ? 'discharge'
      : event.eventType === 'pickup' || event.eventType === 'empty-return'
        ? 'delivery'
        : stops.length === 0
          ? 'origin'
          : 'transshipment';
    stops.push({ name, role });
  }
  return stops;
}

function ooclFact(lines: string[], label: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(new RegExp(`${label.source}\\s*[:：]?\\s*(.+)$`, label.flags))?.[1]?.trim();
    if (inline) return inline;
    if (label.test(lines[index]) && lines[index + 1]) return lines[index + 1];
  }
  return '';
}

export function parseOoclControlTowerText(pageText: string, input: TrackingQuery): TrackingResult {
  const normalizedPageText = pageText.replace(/\u00a0/g, ' ');
  const compactText = normalizedPageText.replace(/[ \t]+/g, ' ').trim();
  // Control Tower 的事件表在不同 Chrome/窗口宽度下，innerText 有时用换行
  // 分隔单元格，有时用制表符分隔同一行。先同时按二者拆成单元格，避免
  // “卸货\t21 Aug ...” 被压成一整行而漏掉真实到港、卸货事件。
  const lines = normalizedPageText
    .split(/[\r\n\t]+/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
  const expectedBill = input.originalBillNo.trim().toUpperCase();
  const shortBill = expectedBill.replace(/^OOLU/, '');
  const expectedContainer = input.containerNo.trim().toUpperCase();
  const normalizedText = compactText.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalizedText.includes(shortBill)) {
    throw trackingError('解析失败', `东方海外结果页未显示对应提单号 ${expectedBill}`);
  }
  if (expectedContainer && !normalizedText.includes(expectedContainer)) {
    throw trackingError('解析失败', `东方海外结果页未显示对应柜号 ${expectedContainer}`);
  }
  const events = ooclTimelineEvents(lines);
  const arrival = [...events].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const estimatedArrival = [...events].reverse().find((event) => event.eventType === 'arrival' && !event.actual);
  const discharge = [...events].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  if (!arrival && !estimatedArrival && !discharge) throw trackingError('解析失败', '东方海外结果页没有可核验的实际到港、预计到达或卸货事件');
  // Control Tower 未单独返回 POD 字段时，优先使用预计到达港，其次使用
  // 最新实际到港/卸货港作为线路终点；中间事件只标为中转港。
  const estimatedArrivalPort = estimatedArrival?.location || arrival?.location || discharge?.location || null;
  const routeStops = ooclRouteStops(events, estimatedArrivalPort || '');
  const currentPort = [...events].filter((event) => event.actual && event.location).at(-1)?.location || null;
  const estimatedArrivalTimeText = estimatedArrival?.timeText || null;
  const vesselVoyage = lines.find((line) => /^[A-Z][A-Z0-9 .'-]{2,}\s*\/\s*[A-Z0-9-]{2,}$/i.test(line)) || '';
  const facts = [
    ['提单号', expectedBill],
    ['柜号', expectedContainer],
    ['柜型', lines.find((line) => /^\d{2}(?:HQ|GP|RF|HC)$/i.test(line)) || ''],
    ['船舶/航次', vesselVoyage],
    ['包装', ooclFact(lines, /包装/i)],
    ['毛重', ooclFact(lines, /毛重/i)],
    ['验证毛重', ooclFact(lines, /验证毛重/i)],
    ['货物可用时间', ooclFact(lines, /Cargo Available/i)],
    ['海关清关状态', ooclFact(lines, /海关清关状态/i)],
    ['预配舱单状态', ooclFact(lines, /预配舱单状态/i)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  const routeText = routeStops.map((stop) => stop.name).join(' → ');
  return {
    arrivalTime: (arrival || estimatedArrival)?.time ? new Date((arrival || estimatedArrival)!.time!) : null,
    arrivalTimeText: arrival?.timeText || estimatedArrival?.timeText || null,
    arrivalKind: arrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText,
    arrived: Boolean(arrival || discharge),
    discharged: Boolean(discharge),
    dischargeTime: discharge?.time ? new Date(discharge.time) : null,
    dischargeTimeText: discharge?.timeText || null,
    rawSummary: `东方海外 Control Tower 解析成功；已核验 ${events.length} 条货柜事件${discharge ? '；已发现实际卸货事件' : '；未发现实际卸货事件'}`,
    sourceUrl: 'https://pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking',
    routeText,
    trackingDetail: {
      carrierCode: 'OOCL',
      queryType: input.queryType,
      queryValue: input.queryType === 'container' ? input.containerNo : input.originalBillNo,
      capturedAt: new Date().toISOString(),
      routeStops,
      events,
      currentPort,
      estimatedArrivalPort,
      estimatedArrivalTimeText,
      facts,
    },
    rawPageText: compactText,
  };
}

function allObjects(value: unknown): JsonObject[] {
  const result: JsonObject[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isObject(item)) return;
    result.push(item);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return result;
}

function eventName(object: JsonObject) {
  return firstText(object, ['event', 'eventName', 'eventDescription', 'description', 'status', 'activity']);
}

function eventTime(object: JsonObject) {
  return parseOoclDate(firstText(object, ['time', 'eventTime', 'eventDateTime', 'dateTime', 'eventDate', 'activityDate']));
}

function isDischargeEvent(value: string) {
  return /\b(?:discharg(?:e|ed|ing)|unload(?:ed|ing)?|container\s+discharge)\b/i.test(value) || /卸船|卸载/.test(value);
}

function indicationIsActual(value: string) {
  return /actual|ata|arrived/i.test(value) && !/estimated|estimate|eta/i.test(value);
}

function findArrival(record: unknown): { time: Date | null; kind: ArrivalKind } {
  const objects = allObjects(record);
  const actualKeys = ['ata', 'actualArrivalTime', 'actualArrivalDate', 'arrivalActualTime'];
  const estimateKeys = ['eta', 'estimatedArrivalTime', 'estimatedArrivalDate', 'arrivalEstimatedTime'];

  for (const object of objects) {
    const lastPodTime = parseOoclDate(firstText(object, ['lastPODTime', 'lastPodTime']));
    const indicator = firstText(object, ['lastPODTimeIndicator', 'lastPodTimeIndicator']);
    if (lastPodTime && indicationIsActual(indicator)) return { time: lastPodTime, kind: 'ATA' };
  }
  for (const object of objects) {
    const date = parseOoclDate(firstText(object, actualKeys));
    if (date) return { time: date, kind: 'ATA' };
  }
  for (const object of objects) {
    const lastPodTime = parseOoclDate(firstText(object, ['lastPODTime', 'lastPodTime']));
    if (lastPodTime) return { time: lastPodTime, kind: 'ETA' };
  }
  for (const object of objects) {
    const date = parseOoclDate(firstText(object, estimateKeys));
    if (date) return { time: date, kind: 'ETA' };
  }
  return { time: null, kind: null };
}

function findDischarge(record: unknown) {
  return allObjects(record)
    .map((object) => ({ object, name: eventName(object), time: eventTime(object) }))
    .filter((candidate) => candidate.name && isDischargeEvent(candidate.name) && candidate.time)
    .sort((a, b) => b.time!.getTime() - a.time!.getTime())[0] || null;
}

function containerNumbers(record: unknown) {
  return [...new Set(allObjects(record)
    .map((object) => firstText(object, ['containerNumber', 'containerNo']))
    .filter(Boolean))];
}

function matchingContainer(record: unknown, expectedContainerNo: string) {
  if (!expectedContainerNo) return null;
  return allObjects(record).find((object) => {
    const number = firstText(object, ['containerNumber', 'containerNo']);
    return number.toUpperCase() === expectedContainerNo;
  }) || null;
}

export function parseOoclTrackingResponse(payload: unknown, expectedContainerNo = ''): TrackingResult {
  if (!isObject(payload)) throw new Error('OOCL 返回了无法识别的数据格式');
  const response = payload as OoclResponse;
  const result = response.result;
  if (!result || result.responseCode !== 'SVC_OK_001') {
    const responseCode = result?.responseCode || '缺少业务响应码';
    const exceptionCode = result?.exceptionCode ? `；exceptionCode=${result.exceptionCode}` : '';
    throw new Error(`OOCL 官方查询暂不可用（responseCode=${responseCode}${exceptionCode}）`);
  }
  const record = result.searchResultRecord;
  if (!record) throw new Error('OOCL 未返回该提单的追踪记录');

  const containers = containerNumbers(record);
  const expected = expectedContainerNo.trim().toUpperCase();
  if (expected && containers.length && !containers.some((value) => value.toUpperCase() === expected)) {
    throw new Error(`OOCL 返回的柜号与输入不一致（输入 ${expected}，官网返回 ${containers.join('、')}）`);
  }

  const selectedContainer = matchingContainer(record, expected);
  const scopedRecord = selectedContainer || record;
  const scopedArrival = findArrival(scopedRecord);
  const arrival = scopedArrival.time ? scopedArrival : findArrival(record);
  const discharge = findDischarge(scopedRecord);
  const matchedContainer = selectedContainer ? `；柜号=${expected}` : '';
  const dischargeSummary = discharge ? `；卸船事件=${discharge.name}` : '；未发现卸船完成事件';
  return {
    arrivalTime: arrival.time,
    arrivalKind: arrival.kind,
    arrived: arrival.kind === 'ATA' || Boolean(discharge),
    dischargeTime: discharge?.time || null,
    rawSummary: `OOCL 官方追踪解析成功${matchedContainer}${dischargeSummary}`,
    sourceUrl: 'https://www.oocl.com/schi/Pages/default.aspx',
  };
}

export class OoclTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'OOCL') throw trackingError('解析失败', `OOCL 解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') {
      // OOCL Lite only exposes the bill-number endpoint. Container fallback,
      // when enabled, is handled by the Patchright Control Tower provider.
      throw trackingError('解析失败', 'OOCL 官方 Lite 接口仅支持提单号查询，柜号请使用网页查询通道');
    }
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^OOLU[A-Z0-9]{6,}$/.test(billNo)) throw trackingError('订单号验证失败', `OOCL 提单号格式不正确：${billNo || '空'}`);

    const url = new URL(OOCL_TRACKING_ENDPOINT);
    url.searchParams.set('paramString', `blNumber=${billNo}`);
    const request = requestContext(this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { accept: 'application/json' },
        signal: request.signal,
      });
      if (!response.ok) {
        const category = response.status === 401
          ? '官网拒绝访问'
          : response.status === 403 || response.status === 412
            ? '验证码或风控'
            : '官网接口异常';
        throw trackingError(category, `OOCL 官方接口 HTTP ${response.status}`);
      }
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        const challenge = /<html|challenge|cloudflare/i.test(body);
        throw trackingError(
          challenge ? '验证码或风控' : '解析失败',
          challenge ? 'OOCL 官网返回了验证页面，暂时无法自动查询' : 'OOCL 返回了无法识别的数据格式',
        );
      }
      return parseOoclTrackingResponse(payload, input.containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', 'OOCL 官方查询超时，请稍后重试');
      throw error;
    } finally {
      request.dispose();
    }
  }
}
