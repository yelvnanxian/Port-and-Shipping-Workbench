import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingDetail, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const MATSON_ENDPOINT = 'https://api.cargo.chinamatson.com/cargotrack/cargopub';
const MATSON_DETAIL_ENDPOINT = 'https://api.cargo.chinamatson.com/cargotrack/cargopub/detailpub';
const MATSON_SOURCE = 'https://www.cargo.chinamatson.com/';
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function allObjects(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(allObjects);
  if (!value || typeof value !== 'object') return [];
  const entry = value as JsonObject;
  return [entry, ...Object.values(entry).flatMap(allObjects)];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(entry: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = text(entry[key]);
    if (value) return value;
  }
  return '';
}

function parseDate(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

function normalizedReference(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameReference(left: string, right: string) {
  return Boolean(left && right && normalizedReference(left) === normalizedReference(right));
}

function apiMessage(payload: unknown) {
  const root = object(payload);
  return [text(root.errorCode) ? `errorCode=${text(root.errorCode)}` : '', text(root.errorMessage) || text(root.message)].filter(Boolean).join('；');
}

interface MatsonSummarySelection {
  booking: JsonObject;
  container: JsonObject;
  returnedContainer: string;
  bookingNumber: string;
}

function selectSummary(payload: unknown, expectedContainerNo = ''): MatsonSummarySelection {
  const root = object(payload);
  const error = apiMessage(payload);
  if (error) throw trackingError('官网接口异常', `美森官方接口返回错误：${error}`);
  const bookings = objects(root.ediBooking);
  const expected = normalizedReference(expectedContainerNo);
  const availableContainers = bookings.flatMap((booking) => objects(booking.container));
  const returnedContainers = [...new Set(availableContainers.map((entry) => firstText(entry, ['containerNumber', 'containerNo'])).filter(Boolean))];
  if (!bookings.length || !availableContainers.length) throw trackingError('订单号验证失败', '美森官网未返回该提单的货物记录');
  if (expected && returnedContainers.length && !returnedContainers.some((container) => sameReference(container, expected))) {
    throw trackingError('订单号验证失败', `美森官网返回的柜号与输入不一致（输入 ${expected}，官网返回 ${returnedContainers.join('、')}）`);
  }
  const booking = bookings.find((entry) => objects(entry.container).some((container) => {
    const returned = firstText(container, ['containerNumber', 'containerNo']);
    return !expected || sameReference(returned, expectedContainerNo);
  })) || bookings[0];
  const container = objects(booking.container).find((entry) => {
    const returned = firstText(entry, ['containerNumber', 'containerNo']);
    return !expected || sameReference(returned, expectedContainerNo);
  }) || objects(booking.container)[0];
  const returnedContainer = firstText(container, ['containerNumber', 'containerNo']);
  const bookingNumber = firstText(booking, ['bookingNumber', 'shipmentNumber']);
  if (!returnedContainer) throw trackingError('解析失败', '美森官网摘要缺少柜号，无法核验查询结果');
  return { booking, container, returnedContainer, bookingNumber };
}

function selectDetailBooking(payload: unknown, expectedBookingNo: string, expectedContainerNo: string) {
  const error = apiMessage(payload);
  if (error) throw trackingError('官网接口异常', `美森详情接口返回错误：${error}`);
  const bookings = objects(object(payload).booking);
  const booking = bookings.find((entry) => sameReference(firstText(entry, ['shipmentNumber', 'bookingNumber']), expectedBookingNo)) || bookings[0];
  if (!booking) throw trackingError('解析失败', '美森详情接口没有返回订舱详情');
  const returnedBooking = firstText(booking, ['shipmentNumber', 'bookingNumber']);
  if (returnedBooking && !sameReference(returnedBooking, expectedBookingNo)) {
    throw trackingError('订单号验证失败', `美森详情返回订舱号 ${returnedBooking}，与摘要 ${expectedBookingNo} 不一致`);
  }
  const equipments = objects(booking.equipments);
  const equipment = equipments.find((entry) => sameReference(firstText(entry, ['containerNumber', 'containerNo']), expectedContainerNo));
  if (!equipment) {
    const returned = equipments.map((entry) => firstText(entry, ['containerNumber', 'containerNo'])).filter(Boolean);
    throw trackingError('订单号验证失败', `美森详情未返回柜号 ${expectedContainerNo}${returned.length ? `（官网返回 ${returned.join('、')}）` : ''}`);
  }
  return { booking, equipment };
}

function vesselFromStatus(status: string) {
  const matched = status.match(/(?:vessel|for)\s+(.+?)\.\s*([A-Z0-9-]+)(?:\s+([A-Z]))?$/i);
  return {
    vesselName: matched?.[1]?.trim() || null,
    voyageNo: matched ? [matched[2], matched[3]].filter(Boolean).join(' ') : null,
  };
}

function eventDefinition(status: string, eventCode: string, dischargedSeen: boolean): {
  label: string;
  eventType: TrackingEventType;
  cargoState: TrackingCargoState;
  transportMode: NonNullable<TrackingEventDetail['transportMode']>;
} {
  if (/returned from consignee|empty returned/i.test(status)) return { label: '还空箱', eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/empty outgate/i.test(status)) return { label: '空箱放给发货人', eventType: 'origin', cargoState: 'empty', transportMode: 'truck' };
  if (/discharge from vessel|\bDFV\b/i.test(`${status} ${eventCode}`)) return { label: '有货柜卸船', eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  if (/load to vessel|\bLTV\b/i.test(`${status} ${eventCode}`)) return { label: '有货柜装船', eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/outgate/i.test(status)) return { label: dischargedSeen ? '有货柜出场配送' : '重箱出场转运', eventType: dischargedSeen ? 'pickup' : 'origin', cargoState: 'laden', transportMode: 'truck' };
  if (/ingate full/i.test(status)) return { label: dischargedSeen ? '有货柜进入目的地场站' : '重箱进入始发场站', eventType: dischargedSeen ? 'delivery' : 'origin', cargoState: 'laden', transportMode: 'terminal' };
  if (/available/i.test(status)) return { label: '货柜可提取', eventType: 'delivery', cargoState: 'laden', transportMode: 'terminal' };
  return { label: status || `美森事件 ${eventCode || 'UNKNOWN'}`, eventType: 'other', cargoState: 'unknown', transportMode: 'unknown' };
}

function matsonEvents(booking: JsonObject, equipment: JsonObject) {
  const rawEvents = objects(equipment.eventList)
    .sort((left, right) => (parseDate(text(left.statusDateTime))?.getTime() || 0) - (parseDate(text(right.statusDateTime))?.getTime() || 0));
  let dischargedSeen = false;
  const entries: Array<{ sortAt: number; event: TrackingEventDetail }> = [];
  for (const entry of rawEvents) {
    const status = text(entry.status);
    const eventCode = text(entry.eventType);
    const definition = eventDefinition(status, eventCode, dischargedSeen);
    const vessel = vesselFromStatus(status);
    const timeText = text(entry.statusDateTime) || null;
    entries.push({
      sortAt: parseDate(timeText || '')?.getTime() || entries.length,
      event: {
        label: definition.label,
        eventType: definition.eventType,
        location: text(entry.statusLocation) || null,
        // 美森页面不提供事件地点时区；保留官网当地时间原文，不伪造 UTC。
        time: null,
        timeText,
        actual: true,
        cargoState: definition.cargoState,
        facility: null,
        vesselName: vessel.vesselName,
        voyageNo: vessel.voyageNo,
        transportMode: text(entry.medium).toLowerCase() === 'ship' ? 'ocean' : definition.transportMode,
        sourceLine: [eventCode, status].filter(Boolean).join(' · '),
      },
    });
    if (definition.eventType === 'discharge') dischargedSeen = true;
  }

  const sailedDate = text(booking.sailedDate);
  if (sailedDate && !entries.some(({ event }) => event.eventType === 'departure' && event.label === '船舶实际离港')) {
    entries.push({
      sortAt: parseDate(sailedDate)?.getTime() || 0,
      event: {
        label: '船舶实际离港',
        eventType: 'departure',
        location: firstText(booking, ['portOfLoading', 'origin']) || null,
        time: null,
        timeText: sailedDate,
        actual: true,
        cargoState: 'unknown',
        facility: null,
        vesselName: text(booking.vessel) || null,
        voyageNo: [text(booking.voyage), text(booking.direction)].filter(Boolean).join(' ') || null,
        transportMode: 'ocean',
        sourceLine: 'sailedDate',
      },
    });
  }
  return entries.sort((left, right) => left.sortAt - right.sortAt).map(({ event }) => event);
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedReference(left || '');
  const b = normalizedReference(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function matsonRouteStops(events: TrackingEventDetail[], destination = ''): TrackingRouteStop[] {
  const segments: Array<{ name: string; events: TrackingEventDetail[] }> = [];
  for (const event of events) {
    const location = event.location?.trim();
    if (!location) continue;
    const current = segments.at(-1);
    if (current && sameReference(current.name, location)) current.events.push(event);
    else segments.push({ name: location, events: [event] });
  }
  return segments.map((segment, index) => {
    const hasDischarge = segment.events.some((event) => event.eventType === 'discharge' || event.eventType === 'arrival');
    const hasLoading = segment.events.some((event) => event.eventType === 'departure' && event.cargoState === 'laden');
    const hasDelivery = segment.events.some((event) => ['pickup', 'delivery', 'empty-return'].includes(event.eventType));
    const role: TrackingRouteStop['role'] = destination && sameLocation(segment.name, destination)
      ? 'discharge'
      : index === 0
      ? 'origin'
      : hasDischarge && !destination
        ? 'discharge'
        : hasLoading
          ? 'loading'
          : hasDelivery || index === segments.length - 1
            ? 'delivery'
            : 'transshipment';
    return { name: segment.name, role };
  });
}

function facts(booking: JsonObject, equipment: JsonObject, expectedBillNo: string) {
  const hold = objects(booking.holds)[0] || {};
  const entries: Array<[string, string]> = [
    ['提单号', expectedBillNo],
    ['订舱号', firstText(booking, ['shipmentNumber', 'bookingNumber'])],
    ['柜号', firstText(equipment, ['containerNumber', 'containerNo'])],
    ['柜型', text(equipment.typeSize)],
    ['重量', text(equipment.weight)],
    ['最新动态', text(equipment.latestStatus)],
    ['起运地', text(booking.origin)],
    ['装货港', text(booking.portOfLoading)],
    ['卸货港', text(booking.portOfDischarge)],
    ['目的地', text(booking.destination)],
    ['船舶/航次', [text(booking.vessel), text(booking.voyage), text(booking.direction)].filter(Boolean).join(' / ')],
    ['实际开航', text(booking.sailedDate)],
    ['海关扣留', text(hold.holdPlacedDate)],
    ['海关放行', text(hold.releaseDate)],
  ];
  return entries.flatMap(([label, value]) => value ? [{ label, value }] : []);
}

function detailTrackingResult(
  summary: MatsonSummarySelection,
  detailPayload: unknown,
  expectedBillNo: string,
  context?: { queryType: TrackingQuery['queryType']; queryValue: string },
): TrackingResult {
  if (!summary.bookingNumber) throw trackingError('解析失败', '美森官网摘要缺少订舱号，无法读取完整详情');
  const { booking, equipment } = selectDetailBooking(detailPayload, summary.bookingNumber, summary.returnedContainer);
  const events = matsonEvents(booking, equipment);
  if (!events.length) throw trackingError('解析失败', '美森详情已返回，但没有可核验的货柜轨迹事件');
  const destination = firstText(booking, ['portOfDischarge', 'destination']);
  const isDestinationEvent = (event: TrackingEventDetail) => !destination || sameLocation(event.location, destination);
  const routeStops = matsonRouteStops(events, destination);
  // 只有最终目的港的事件才能写入总览 ATA/卸船字段；中转港卸船仍保留在完整事件和线路中。
  const destinationEvents = events.filter(isDestinationEvent);
  const dischargeEvent = destinationEvents.find((event) => event.eventType === 'discharge' && event.actual && event.timeText);
  const actualArrivalEvent = destinationEvents.find((event) => event.eventType === 'arrival' && event.actual && event.timeText);
  const estimatedArrivalText = firstText(summary.booking, ['arrivalDate', 'eta']) || text(booking.currentVesselETA);
  const actualArrival = actualArrivalEvent ? parseDate(actualArrivalEvent.timeText || '') : null;
  const estimatedArrival = !actualArrival ? parseDate(estimatedArrivalText) : null;
  const discharge = dischargeEvent ? parseDate(dischargeEvent.timeText || '') : null;
  const trackingDetail: TrackingDetail = {
    carrierCode: 'MATSON',
    queryType: context?.queryType || 'bill',
    queryValue: context?.queryValue || expectedBillNo,
    capturedAt: new Date().toISOString(),
    routeStops,
    events,
    currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
    estimatedArrivalPort: destination || null,
    estimatedArrivalTimeText: localTime(estimatedArrivalText),
    facts: facts(booking, equipment, expectedBillNo),
  };
  const routeText = routeStops.map((stop) => stop.name).join(' → ');
  return {
    arrivalTime: actualArrival || estimatedArrival,
    arrivalTimeText: localTime(actualArrivalEvent?.timeText || estimatedArrivalText),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText: localTime(estimatedArrivalText),
    arrived: Boolean(actualArrival || discharge || events.some((event) => ['discharge', 'pickup', 'delivery', 'empty-return'].includes(event.eventType))),
    discharged: Boolean(dischargeEvent),
    dischargeTime: discharge,
    dischargeTimeText: localTime(dischargeEvent?.timeText || ''),
    rawSummary: `美森官方公开详情解析成功；柜号=${summary.returnedContainer}；已核验完整轨迹 ${events.length} 条${dischargeEvent ? '；已发现实际卸船事件' : '；未发现实际卸船事件'}`,
    sourceUrl: MATSON_SOURCE,
    routeText,
    trackingDetail,
    rawPageText: JSON.stringify({ summary: { ediBooking: [summary.booking] }, detail: detailPayload }, null, 2),
  };
}

export function parseMatsonTrackingResponse(
  payload: unknown,
  expectedContainerNo = '',
  detailPayload?: unknown,
  context?: { expectedBillNo?: string; queryType: TrackingQuery['queryType']; queryValue: string },
): TrackingResult {
  const summary = selectSummary(payload, expectedContainerNo);
  if (detailPayload !== undefined) {
    return detailTrackingResult(summary, detailPayload, context?.expectedBillNo || context?.queryValue || summary.bookingNumber, context);
  }

  // 兼容只返回摘要的旧调用；生产查询会继续请求 detailpub 获取完整时间线。
  const all = allObjects(payload);
  const actualArrival = all.map((entry) => parseDate(firstText(entry, ['actualArrivalDate', 'ata']))).find(Boolean) || null;
  const estimatedArrivalText = all.map((entry) => firstText(entry, ['arrivalDate', 'eta'])).find(Boolean) || '';
  const estimatedArrival = parseDate(estimatedArrivalText);
  const arrival = actualArrival || estimatedArrival;
  const matching = all.filter((entry) => sameReference(firstText(entry, ['containerNumber', 'containerNo']), summary.returnedContainer));
  const destinationActivity = matching.find((entry) => {
    const status = firstText(entry, ['latestStatus', 'status', 'eventName', 'description']);
    const statusTime = parseDate(firstText(entry, ['statusDateTime', 'eventDateTime', 'eventDate', 'date']));
    return /\b(?:available|outgate|delivered|picked\s*up|returned\s+from\s+consignee|empty\s+returned)\b/i.test(status)
      && Boolean(statusTime && (!arrival || statusTime.getTime() >= arrival.getTime()));
  });
  const activityStatus = destinationActivity ? firstText(destinationActivity, ['latestStatus', 'status', 'eventName', 'description']) : '';
  return {
    arrivalTime: arrival,
    arrivalTimeText: localTime(actualArrival ? firstText(summary.booking, ['actualArrivalDate', 'ata']) : estimatedArrivalText),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    arrived: Boolean(actualArrival || destinationActivity),
    dischargeTime: null,
    rawSummary: `美森官方公开接口摘要解析成功；柜号=${summary.returnedContainer}${destinationActivity ? `；已发现到港后场站活动（${activityStatus}）` : ''}；尚未读取完整详情`,
    sourceUrl: MATSON_SOURCE,
  };
}

export class MatsonTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async fetchPayload(url: URL, controller: AbortController, label: string) {
    const response = await this.fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    const body = await response.text();
    let payload: unknown = null;
    try { payload = body ? JSON.parse(body) : null; } catch { /* 错误分类使用原始正文 */ }
    if (!response.ok) {
      const detail = apiMessage(payload) || body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || '无响应正文';
      const category = response.status === 401 ? '官网拒绝访问' : response.status === 403 || response.status === 412 ? '验证码或风控' : '官网接口异常';
      throw trackingError(category, `美森${label} HTTP ${response.status}：${detail}`);
    }
    if (payload === null) throw trackingError('解析失败', `美森${label}返回了非 JSON 内容`);
    return payload;
  }

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'MATSON') throw trackingError('解析失败', `美森解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw trackingError('解析失败', '美森解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^MATS[A-Z0-9]{6,}$/.test(billNo)) throw trackingError('订单号验证失败', `美森提单号格式不正确：${billNo || '空'}`);
    const summaryUrl = new URL(MATSON_ENDPOINT);
    summaryUrl.searchParams.set('cargoNumber', billNo);
    // 官网 CargoPortal 的“关单号”查询使用 bk；bl 会返回 CS.0004。
    summaryUrl.searchParams.set('type', 'bk');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const summaryPayload = await this.fetchPayload(summaryUrl, controller, '摘要接口');
      const summary = selectSummary(summaryPayload, input.containerNo);
      if (!summary.bookingNumber) throw trackingError('解析失败', '美森官网摘要缺少订舱号，无法请求完整详情');
      const detailUrl = new URL(MATSON_DETAIL_ENDPOINT);
      detailUrl.searchParams.set('bk', summary.bookingNumber);
      detailUrl.searchParams.set('cn', summary.returnedContainer);
      // CargoPortal 未登录页面固定以 anonymousUser WebId 请求公开详情。
      detailUrl.searchParams.set('webId', 'anonymousUser');
      const detailPayload = await this.fetchPayload(detailUrl, controller, '详情接口');
      return parseMatsonTrackingResponse(summaryPayload, input.containerNo, detailPayload, {
        expectedBillNo: input.originalBillNo,
        queryType: input.queryType,
        queryValue: billNo,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '美森官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
