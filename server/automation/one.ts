import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { ArrivalKind, TrackingCargoState, TrackingDetail, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const ONE_ENDPOINT = 'https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace/search';
const ONE_EVENTS_ENDPOINT = 'https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace/cop-events';
const ONE_SOURCE = 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking';
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function date(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const source = text(value);
  if (!source) return null;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sameReference(left: string, right: string) {
  return left.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    === right.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function eventName(event: JsonObject) {
  const name = text(event.eventName) || text(event.name) || text(event.description);
  if (name) return name;
  // The public endpoint omits eventName in production responses and returns
  // the stable cargo-event matrix id instead. These IDs are also used by the
  // official page to render the event labels.
  switch (text(event.matrixId).toUpperCase()) {
    case 'E012': return 'Empty Container Release to Shipper';
    case 'E040': return 'Gate In to Outbound Terminal';
    case 'E058': return 'Loaded on Vessel at Port of Loading';
    case 'E061': return 'Vessel Departure from Port of Loading';
    case 'E087': return 'Vessel Arrival at Port of Discharge';
    case 'E089': return 'Vessel Berthing at Port of Discharge';
    case 'E090': return 'Unloaded from Vessel at Port of Discharging';
    case 'E109': return 'Loaded on Rail at Inbound Rail Origin';
    case 'E110': return 'Inbound Rail Departure';
    case 'E114': return 'Gate In to Inbound CY';
    case 'E117': return 'Inbound Rail Arrival';
    case 'E118': return 'Unloaded from Rail at Inbound Rail Destination';
    case 'E129': return 'Gate Out from Inbound CY for Delivery to Consignee';
    case 'E130': return 'Gate Out from Inbound CY for Delivery to Consignee';
    case 'E138': return 'Empty Container Returned from Customer';
    default: return '';
  }
}

function eventDate(event: JsonObject) {
  // The API's date field is an explicit UTC instant. localPortDate is a
  // display value and is not used to avoid applying a second timezone shift.
  return date(event.eventDate) || date(event.date) || date(event.eventLocalPortDate) || date(event.localPortDate);
}

function isActual(event: JsonObject) {
  return /^(?:actual|a|y)$/i.test(text(event.triggerType) || text(event.trigger) || text(event.actualYn));
}

function localEventTime(event: JsonObject) {
  const source = localEventTimeText(event);
  return source ? `${source}（官网当地时间）` : null;
}

function localEventTimeText(event: JsonObject) {
  const source = text(event.eventLocalPortDate) || text(event.localPortDate);
  const matched = source.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)/);
  return matched ? `${matched[1]} ${matched[2]}` : null;
}

function eventLocation(event: JsonObject) {
  const location = object(event.location);
  return text(location.locationName) || text(event.locationName);
}

function routeFromEvents(events: JsonObject[]) {
  const sorted = [...events].sort((left, right) => {
    const leftSequence = Number(left.copSequence);
    const rightSequence = Number(right.copSequence);
    if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) return leftSequence - rightSequence;
    return (eventDate(left)?.getTime() || 0) - (eventDate(right)?.getTime() || 0);
  });
  const locations: string[] = [];
  for (const event of sorted) {
    const location = eventLocation(event);
    if (location && locations.at(-1) !== location) locations.push(location);
  }
  return locations.length > 1 ? locations.join(' → ') : null;
}

function oneCargoState(name: string): TrackingCargoState {
  if (/empty container/i.test(name)) return 'empty';
  if (/loaded on vessel|unloaded from vessel|loaded on rail|unloaded from rail|inbound rail (?:departure|arrival)|gate in to (?:outbound|inbound)|delivery to consignee/i.test(name)) return 'laden';
  return 'unknown';
}

function oneEventLabel(name: string) {
  if (/empty container release/i.test(name)) return '空箱放给发货人';
  if (/gate in to outbound terminal/i.test(name)) return '重箱进入出口码头';
  if (/loaded on vessel/i.test(name)) return '有货柜装船';
  if (/vessel departure/i.test(name)) return '船舶实际离港';
  if (/vessel arrival|vessel berthing/i.test(name)) return '船舶实际到港';
  if (/unloaded from vessel/i.test(name)) return '有货柜卸船';
  if (/loaded on rail/i.test(name)) return '有货柜装上铁路';
  if (/inbound rail departure/i.test(name)) return '铁路转运离站';
  if (/inbound rail arrival/i.test(name)) return '铁路转运到站';
  if (/unloaded from rail/i.test(name)) return '有货柜从铁路卸下';
  if (/gate out.*delivery|delivery to consignee/i.test(name)) return '有货柜出场配送';
  if (/gate in to inbound CY/i.test(name)) return '有货柜进入进口堆场';
  if (/empty container returned/i.test(name)) return '还空箱';
  return name;
}

function oneEventType(name: string): TrackingEventType {
  if (/empty container returned/i.test(name)) return 'empty-return';
  if (/vessel arrival|vessel berthing/i.test(name)) return 'arrival';
  if (/unloaded from vessel|discharged from vessel|discharge completed/i.test(name)) return 'discharge';
  if (/vessel departure|loaded on vessel/i.test(name)) return 'departure';
  if (/rail/i.test(name)) return 'transshipment';
  if (/gate out.*delivery|delivery to consignee/i.test(name)) return 'pickup';
  if (/empty container release|gate in to outbound/i.test(name)) return 'origin';
  if (/gate in to inbound/i.test(name)) return 'delivery';
  return 'other';
}

function oneTransportMode(name: string): NonNullable<TrackingEventDetail['transportMode']> {
  if (/vessel|port of loading|port of discharg/i.test(name)) return 'ocean';
  if (/rail/i.test(name)) return 'rail';
  if (/delivery to consignee/i.test(name)) return 'truck';
  if (/terminal|\bCY\b|container release|container returned/i.test(name)) return 'terminal';
  return 'unknown';
}

function oneFacility(event: JsonObject) {
  const yard = object(event.yard);
  return text(yard.yardName) || text(event.yardName) || null;
}

function oneVessel(event: JsonObject) {
  const vessel = object(event.edhVessel);
  const fallback = object(event.vessel);
  return {
    name: text(vessel.name) || text(fallback.name) || null,
    voyageNo: [text(vessel.voyNo) || text(fallback.voyNo), text(vessel.dirCode) || text(fallback.dirCode)].filter(Boolean).join('') || null,
  };
}

function oneStructuredEvents(events: JsonObject[]) {
  return [...events]
    .sort((left, right) => Number(left.copSequence || 0) - Number(right.copSequence || 0))
    .map((event): TrackingEventDetail => {
      const name = eventName(event) || `ONE 事件 ${text(event.matrixId) || 'UNKNOWN'}`;
      const vessel = oneVessel(event);
      return {
        label: oneEventLabel(name),
        eventType: oneEventType(name),
        location: eventLocation(event) || null,
        time: eventDate(event)?.toISOString() || null,
        timeText: localEventTimeText(event),
        actual: isActual(event),
        cargoState: oneCargoState(name),
        facility: oneFacility(event),
        vesselName: vessel.name,
        voyageNo: vessel.voyageNo,
        transportMode: oneTransportMode(name),
        sourceLine: `${text(event.matrixId) || 'UNKNOWN'} · ${name}`,
      };
    });
}

function oneRouteStops(events: TrackingEventDetail[], row: JsonObject): TrackingRouteStop[] {
  const locations: string[] = [];
  const add = (value: string) => {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
    if (value && !locations.some((item) => item.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '') === normalized)) locations.push(value);
  };
  add(text(object(row.por).locationName));
  events.forEach((event) => add(event.location || ''));
  add(text(object(row.pod).locationName));
  return locations.map((name, index) => {
    const locationEvents = events.filter((event) => event.location === name);
    let role: TrackingRouteStop['role'] = index === 0 ? 'origin' : index === locations.length - 1 ? 'delivery' : 'transshipment';
    if (locationEvents.some((event) => event.eventType === 'discharge' || event.eventType === 'arrival')) role = 'discharge';
    return { name, role };
  });
}

function oneFacts(row: JsonObject, returnedBill: string, returnedContainer: string) {
  const vessel = object(row.vesselVoyage);
  const place = object(row.place);
  const latest = object(row.latestEvent);
  const customs = object(row.cargoReleaseCustoms);
  return [
    ['提单号', returnedBill],
    ['柜号', returnedContainer],
    ['柜型', text(row.containerTypeSize)],
    ['重量', text(row.weight)],
    ['船名', text(vessel.vesselName)],
    ['航次', [text(vessel.voyageNo), text(vessel.directionCode)].filter(Boolean).join('')],
    ['最新动态', oneEventLabel(text(latest.eventName))],
    ['当前地点', text(latest.locationName) || text(place.locationName)],
    ['当前场站', text(place.yardName)],
    ['起运地', text(object(row.por).locationName)],
    ['目的地', text(object(row.pod).locationName)],
    ['海关放行时间', text(customs.customsClearanceDate)],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
}

function isDestinationArrival(name: string) {
  return /(vessel\s+arrival|vessel\s+berthing).*(port\s+of\s+discharge|pod)/i.test(name)
    || /到港|靠泊/i.test(name);
}

function isDischarge(name: string) {
  return /(unload|discharg).*(vessel|port\s+of\s+discharg)/i.test(name)
    || /卸船|卸载/i.test(name);
}

export function parseOneTrackingResponse(
  payload: unknown,
  expectedBillNo: string,
  expectedContainerNo = '',
  eventPayload?: unknown,
  context?: { queryType: TrackingQuery['queryType']; queryValue: string },
): TrackingResult {
  const root = object(payload);
  const rows = Array.isArray(root.data) ? root.data.map(object) : [];
  if (root.code !== undefined && Number(root.code) !== 1) {
    throw trackingError('官网接口异常', `海洋网联官方接口返回错误：${text(root.message) || `code=${text(root.code)}`}`);
  }
  if (!rows.length || Number(root.total || 0) < 1) {
    throw trackingError('订单号验证失败', `海洋网联官网未找到提单号或柜号 ${expectedBillNo || expectedContainerNo}`);
  }

  const row = rows.find((item) => {
    const bill = text(item.bookingNo) || text(item.bookingNoShow);
    const container = text(item.containerNo);
    return (expectedBillNo && bill && sameReference(bill, expectedBillNo))
      || (expectedContainerNo && container && sameReference(container, expectedContainerNo));
  }) || rows[0];
  const returnedBill = text(row.bookingNo) || text(row.bookingNoShow);
  const returnedContainer = text(row.containerNo);
  if (expectedBillNo && returnedBill && !sameReference(returnedBill, expectedBillNo)
    && !(expectedContainerNo && returnedContainer && sameReference(returnedContainer, expectedContainerNo))) {
    throw trackingError('订单号验证失败', `海洋网联返回提单号 ${returnedBill} 与输入 ${expectedBillNo} 不一致`);
  }
  if (expectedContainerNo && returnedContainer && !sameReference(returnedContainer, expectedContainerNo)) {
    throw trackingError('订单号验证失败', `海洋网联返回柜号 ${returnedContainer} 与输入 ${expectedContainerNo} 不一致`);
  }

  const eventRoot = object(eventPayload);
  if (eventPayload !== undefined && eventRoot.code !== undefined && Number(eventRoot.code) !== 1) {
    throw trackingError('官网接口异常', `海洋网联完整事件接口返回错误：${text(eventRoot.message) || `code=${text(eventRoot.code)}`}`);
  }
  const fullEvents = Array.isArray(eventRoot.data) ? eventRoot.data.map(object) : [];
  if (eventPayload !== undefined && !fullEvents.length) {
    throw trackingError('解析失败', `海洋网联已找到订单 ${returnedBill || expectedBillNo}，但完整事件接口没有返回可核验的运行节点`);
  }
  const events = fullEvents.length ? fullEvents : Array.isArray(row.cargoEvents) ? row.cargoEvents.map(object) : [];
  const destinationEvents = events.filter((event) => isDestinationArrival(eventName(event)) && eventDate(event));
  const actualArrivalEvent = destinationEvents.filter(isActual).sort((a, b) => eventDate(b)!.getTime() - eventDate(a)!.getTime())[0];
  const estimatedArrivalEvent = destinationEvents.sort((a, b) => eventDate(b)!.getTime() - eventDate(a)!.getTime())[0];
  const dischargeEvent = events.filter((event) => isDischarge(eventName(event)) && isActual(event) && eventDate(event))
    .sort((a, b) => eventDate(b)!.getTime() - eventDate(a)!.getTime())[0];
  const actualArrival = actualArrivalEvent ? eventDate(actualArrivalEvent) : null;
  const estimatedArrival = !actualArrival && estimatedArrivalEvent ? eventDate(estimatedArrivalEvent) : null;
  const discharge = dischargeEvent ? eventDate(dischargeEvent) : null;
  if (!actualArrival && !estimatedArrival && !discharge) {
    throw trackingError('解析失败', `海洋网联已返回订单 ${returnedBill || expectedBillNo}，但没有可验证的到港或卸船事件`);
  }
  const arrivalTime = actualArrival || estimatedArrival;
  const arrivalKind: ArrivalKind = actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null;
  const routeText = routeFromEvents(events);
  const structuredEvents = oneStructuredEvents(events);
  const trackingDetail: TrackingDetail = {
    carrierCode: 'ONE',
    queryType: context?.queryType || (expectedBillNo ? 'bill' : 'container'),
    queryValue: context?.queryValue || expectedBillNo || expectedContainerNo,
    capturedAt: new Date().toISOString(),
    routeStops: oneRouteStops(structuredEvents, row),
    events: structuredEvents,
    facts: oneFacts(row, returnedBill || expectedBillNo, returnedContainer || expectedContainerNo),
  };
  return {
    arrivalTime,
    arrivalTimeText: actualArrivalEvent ? localEventTime(actualArrivalEvent) : estimatedArrivalEvent ? localEventTime(estimatedArrivalEvent) : null,
    arrivalKind,
    arrived: Boolean(actualArrival || discharge),
    discharged: Boolean(discharge),
    dischargeTime: discharge,
    dischargeTimeText: dischargeEvent ? localEventTime(dischargeEvent) : null,
    rawSummary: `海洋网联官方公开接口解析成功；提单=${returnedBill || expectedBillNo}；柜号=${returnedContainer || expectedContainerNo || '未提供'}${fullEvents.length ? `；已核验官网完整事件 ${fullEvents.length} 条` : ''}${discharge ? '；已发现实际卸船事件' : '；未发现实际卸船事件'}`,
    sourceUrl: ONE_SOURCE,
    routeText,
    trackingDetail,
    rawPageText: JSON.stringify({ search: payload, events: eventPayload ?? null }, null, 2),
  };
}

export class OneTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'ONE') throw trackingError('解析失败', `海洋网联解析器不能查询 ${input.rule.name}`);
    const queryValue = (input.queryType === 'container' ? input.containerNo : input.queryBillNo).trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `海洋网联${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const searchType = input.queryType === 'container' ? 'CNTR_NO' : 'BKG_NO';
    const body = JSON.stringify({
      page: 1,
      page_length: 10,
      filters: { search_text: queryValue, search_type: searchType },
      timestamp: Date.now(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(ONE_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'content-type': 'application/json',
          origin: 'https://ecomm.one-line.com',
          referer: ONE_SOURCE,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw trackingError('解析失败', '海洋网联官方接口返回了非 JSON 内容'); }
      if (!response.ok) {
        const root = object(payload);
        const detail = text(root.message) || `HTTP ${response.status}`;
        const category = response.status === 403 || response.status === 412 ? '验证码或风控' : '官网接口异常';
        throw trackingError(category, `海洋网联官方接口 ${detail}`);
      }
      const root = object(payload);
      const rows = Array.isArray(root.data) ? root.data.map(object) : [];
      const row = rows.find((item) => {
        const bill = text(item.bookingNo) || text(item.bookingNoShow);
        const container = text(item.containerNo);
        return (input.queryType === 'bill' && bill && sameReference(bill, input.queryBillNo))
          || (input.containerNo && container && sameReference(container, input.containerNo));
      }) || rows[0];
      const returnedBill = text(row?.bookingNo) || text(row?.bookingNoShow);
      const returnedContainer = text(row?.containerNo);
      if (!returnedBill || !returnedContainer) {
        return parseOneTrackingResponse(
          payload,
          input.queryType === 'bill' ? input.queryBillNo : '',
          input.containerNo || (input.queryType === 'container' ? queryValue : ''),
          undefined,
          { queryType: input.queryType, queryValue },
        );
      }
      const eventsUrl = new URL(ONE_EVENTS_ENDPOINT);
      eventsUrl.searchParams.set('booking_no', returnedBill);
      eventsUrl.searchParams.set('container_no', returnedContainer);
      const eventsResponse = await this.fetcher(eventsUrl, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          origin: 'https://ecomm.one-line.com',
          referer: ONE_SOURCE,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        },
        signal: controller.signal,
      });
      const eventsRaw = await eventsResponse.text();
      let eventPayload: unknown;
      try { eventPayload = JSON.parse(eventsRaw); } catch { throw trackingError('解析失败', '海洋网联完整事件接口返回了非 JSON 内容'); }
      if (!eventsResponse.ok) {
        const eventRoot = object(eventPayload);
        const detail = text(eventRoot.message) || `HTTP ${eventsResponse.status}`;
        const category = eventsResponse.status === 403 || eventsResponse.status === 412 ? '验证码或风控' : '官网接口异常';
        throw trackingError(category, `海洋网联完整事件接口 ${detail}`);
      }
      return parseOneTrackingResponse(
        payload,
        input.queryType === 'bill' ? input.queryBillNo : returnedBill,
        input.containerNo || returnedContainer,
        eventPayload,
        { queryType: input.queryType, queryValue },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '海洋网联官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
