import { trackingError } from './errors.js';
import { requestContext } from './official-http.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingFact, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const SMLINE_ENDPOINT = 'https://esvc.smlines.com/smline/CUP_HOM_3301GS.do';
const SMLINE_SOURCE = 'https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=zh';
const DEFAULT_TIMEOUT_MS = 15_000;

interface SmLinePayload {
  Exception?: string;
  TRANS_RESULT_KEY?: string;
  count?: string;
  list?: Array<Record<string, unknown>>;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function officialTime(value: unknown) {
  const matched = text(value).match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/)?.[0] || '';
  return matched ? `${matched}（官网当地时间）` : null;
}

function payloadList(payload: unknown, label: string) {
  if (!payload || typeof payload !== 'object') throw trackingError('解析失败', `森罗官网${label}返回了无法识别的数据格式`);
  const typed = payload as SmLinePayload;
  if (typed.TRANS_RESULT_KEY && typed.TRANS_RESULT_KEY !== 'S') {
    throw trackingError('官网接口异常', `森罗官网${label}失败：${typed.Exception || `TRANS_RESULT_KEY=${typed.TRANS_RESULT_KEY}`}`);
  }
  return Array.isArray(typed.list) ? typed.list : [];
}

function isArrivalEvent(event: Record<string, unknown>) {
  return /arrival at port of discharg/i.test(statusName(event));
}

function isDischargeEvent(event: Record<string, unknown>) {
  return /unloaded|discharged/i.test(statusName(event));
}

function statusName(event: Record<string, unknown>) {
  return text(event.statusNm).replace(/<br\s*\/?>/gi, ' / ').replace(/\s+/g, ' ').trim();
}

function eventDefinition(event: Record<string, unknown>): { eventType: TrackingEventType; cargoState: TrackingCargoState; transportMode: TrackingEventDetail['transportMode'] } {
  const status = statusName(event);
  if (/empty container returned|empty.*(?:return|gate.?in)/i.test(status)) return { eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/empty container release/i.test(status)) return { eventType: 'pickup', cargoState: 'empty', transportMode: 'truck' };
  if (/unloaded|discharged/i.test(status)) return { eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  if (/arrival at port of discharg|berthing destination/i.test(status)) return { eventType: 'arrival', cargoState: 'laden', transportMode: 'ocean' };
  if (/loaded on .*port of loading|departure from port of loading/i.test(status)) return { eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/gate in to outbound terminal/i.test(status)) return { eventType: 'origin', cargoState: 'laden', transportMode: 'terminal' };
  if (/gate out from inbound|shuttled to/i.test(status)) return { eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  if (/transship|relay/i.test(status)) return { eventType: 'transshipment', cargoState: 'laden', transportMode: 'ocean' };
  return { eventType: 'other', cargoState: 'unknown', transportMode: 'unknown' };
}

function structuredEvents(events: Array<Record<string, unknown>>) {
  return events.map((event): TrackingEventDetail => {
    const definition = eventDefinition(event);
    const voyage = [text(event.skdVoyNo), text(event.skdDirCd)].filter(Boolean).join('');
    return {
      label: statusName(event) || text(event.statusCd) || '官网未命名事件',
      eventType: definition.eventType,
      location: text(event.placeNm) || null,
      facility: text(event.yardNm) || null,
      time: null,
      timeText: officialTime(event.eventDt),
      actual: text(event.actTpCd).toUpperCase() === 'A',
      cargoState: definition.cargoState,
      vesselName: text(event.vslEngNm) || null,
      voyageNo: voyage || null,
      transportMode: definition.transportMode,
      sourceLine: [text(event.no), text(event.eventDt), text(event.placeNm), statusName(event), text(event.vslEngNm), voyage, text(event.yardNm), text(event.actTpCd)].filter(Boolean).join(' | '),
    };
  }).sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
}

function normalizedLocation(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedLocation(left || '');
  const b = normalizedLocation(right || '');
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function routeStopsFromOfficial(routes: Array<Record<string, unknown>>, events: TrackingEventDetail[]) {
  const orderedRoutes = [...routes].sort((left, right) => Number(text(left.rn) || text(left.vslSeq) || 0) - Number(text(right.rn) || text(right.vslSeq) || 0));
  const stops: TrackingRouteStop[] = [];
  const append = (name: string, role: TrackingRouteStop['role']) => {
    if (!name) return;
    const previous = stops.at(-1);
    if (previous && normalizedLocation(previous.name) === normalizedLocation(name)) {
      if (role === 'loading' || role === 'discharge') previous.role = role;
      return;
    }
    stops.push({ name, role });
  };
  orderedRoutes.forEach((route, index) => {
    const loading = text(route.porNm) || text(route.placeOfReceiptNm) || text(route.receiptNm) || text(route.polNm) || text(route.portOfLoadingNm);
    const discharge = text(route.podNm) || text(route.portOfDischargeNm) || text(route.pldNm) || text(route.placeOfDeliveryNm) || text(route.deliveryNm);
    append(loading, index === 0 ? 'loading' : 'transshipment');
    append(discharge, index === orderedRoutes.length - 1 ? 'discharge' : 'transshipment');
  });
  // 官方航段接口有时只返回起运港和最终目的港，中转港只出现在事件接口。
  // 无论已有多少航段，都要把事件中的新地点补进线路，并严格把它标记为中转港，
  // 不能因为事件类型是 arrival/discharge 就误标成最终目的港。
  const destination = stops.findLast((stop) => stop.role === 'discharge')?.name || '';
  for (const event of events) {
    if (!event.location || stops.some((stop) => normalizedLocation(stop.name) === normalizedLocation(event.location!))) continue;
    if (destination && sameLocation(event.location, destination)) {
      append(event.location, 'discharge');
      continue;
    }
    append(event.location, stops.length ? 'transshipment' : 'loading');
  }
  return stops;
}

function routeFacts(routes: Array<Record<string, unknown>>) {
  return routes.flatMap((route, index): TrackingFact[] => {
    const leg = `航段 ${index + 1}`;
    const loading = text(route.polNm) || text(route.portOfLoadingNm);
    const discharge = text(route.podNm) || text(route.portOfDischargeNm);
    const vessel = text(route.vslEngNm);
    const voyage = [text(route.skdVoyNo), text(route.skdDirCd)].filter(Boolean).join('');
    return [
      ...(loading || discharge ? [{ label: `${leg} · 线路`, value: [loading, discharge].filter(Boolean).join(' → ') }] : []),
      ...(vessel || voyage ? [{ label: `${leg} · 船舶/航次`, value: [vessel, voyage].filter(Boolean).join(' / ') }] : []),
      ...(text(route.etd) ? [{ label: `${leg} · 开航`, value: `${text(route.etd)}（${text(route.etdFlag).toUpperCase() === 'A' ? '实际' : '预计'}，官网当地时间）` }] : []),
      ...(text(route.eta) ? [{ label: `${leg} · 到港`, value: `${text(route.eta)}（${text(route.etaFlag).toUpperCase() === 'A' ? '实际' : '预计'}，官网当地时间）` }] : []),
    ];
  });
}

export function parseSmLineTrackingResponses(
  searchPayload: unknown,
  routePayload: unknown,
  eventPayload: unknown,
  expectedContainerNo = '',
  expectedBillNo = '',
  queryType: TrackingQuery['queryType'] = 'bill',
): TrackingResult {
  const shipments = payloadList(searchPayload, '号码查询');
  if (!shipments.length) throw trackingError('订单号验证失败', '森罗官网未找到对应的提单号或柜号');
  const expected = expectedContainerNo.trim().toUpperCase();
  const billNo = expectedBillNo.trim().toUpperCase().replace(/^SMLM/, '');
  const matchedShipments = queryType === 'container'
    ? shipments.filter((item) => text(item.cntrNo).toUpperCase() === expected)
    : billNo
      ? shipments.filter((item) => [text(item.blNo), text(item.bkgNo)].some((value) => value.toUpperCase() === billNo))
      : shipments;
  if (!matchedShipments.length) {
    if (queryType === 'container') {
      const returnedContainers = [...new Set(shipments.map((item) => text(item.cntrNo).toUpperCase()).filter(Boolean))];
      throw trackingError('订单号验证失败', `森罗官网返回的柜号与查询号不一致（查询 ${expected}，官网返回 ${returnedContainers.join('、') || '空'}）`);
    }
    const returnedBills = [...new Set(shipments.flatMap((item) => [text(item.blNo), text(item.bkgNo)]).filter(Boolean))];
    throw trackingError('订单号验证失败', `森罗官网返回的提单号与查询号不一致（查询 ${billNo}，官网返回 ${returnedBills.join('、') || '空'}）`);
  }

  const selected = queryType === 'container'
    ? matchedShipments.find((item) => [text(item.blNo), text(item.bkgNo)].some((value) => value.toUpperCase() === billNo)) || matchedShipments[0]
    : matchedShipments.find((item) => text(item.cntrNo).toUpperCase() === expected) || matchedShipments[0];
  if (queryType === 'bill' && expected && text(selected.cntrNo).toUpperCase() !== expected) {
    throw trackingError('订单号验证失败', `森罗提单查询未返回输入柜号 ${expected}，将改用柜号查询核验`);
  }
  const bookingNo = (text(selected.bkgNo) || text(selected.blNo)).toUpperCase();
  const copNo = text(selected.copNo).toUpperCase();
  const containerNo = text(selected.cntrNo).toUpperCase();
  const routes = payloadList(routePayload, '航线查询').filter((item) => !text(item.bkgNo) || text(item.bkgNo).toUpperCase() === bookingNo);
  const events = payloadList(eventPayload, '货柜事件查询').filter((item) => {
    if (text(item.bkgNo) && text(item.bkgNo).toUpperCase() !== bookingNo) return false;
    if (text(item.copNo) && copNo && text(item.copNo).toUpperCase() !== copNo) return false;
    if (text(item.cntrNo) && containerNo && text(item.cntrNo).toUpperCase() !== containerNo) return false;
    return true;
  });
  const route = routes.at(-1) || {};
  const destination = text(route.podNm) || text(route.portOfDischargeNm) || text(route.pldNm) || text(route.placeOfDeliveryNm) || '';
  const isDestinationEvent = (event: Record<string, unknown>) => {
    const location = text(event.placeNm);
    if (!destination) return true;
    if (location) return sameLocation(location, destination);
    return /port of discharg|destination|final/i.test(statusName(event));
  };
  const destinationEvents = events.filter(isDestinationEvent);
  const actualArrivalEvent = [...destinationEvents].reverse().find((event) => text(event.actTpCd).toUpperCase() === 'A' && isArrivalEvent(event));
  const estimatedArrivalEvent = [...destinationEvents].reverse().find((event) => text(event.actTpCd).toUpperCase() !== 'A' && isArrivalEvent(event));
  const actualDischargeEvent = [...destinationEvents].reverse().find((event) => text(event.actTpCd).toUpperCase() === 'A' && isDischargeEvent(event));
  const estimatedDischargeEvent = [...destinationEvents].reverse().find((event) => text(event.actTpCd).toUpperCase() !== 'A' && isDischargeEvent(event));
  const routeArrivalText = officialTime(route.eta);
  const actualArrivalText = officialTime(actualArrivalEvent?.eventDt);
  const estimatedArrivalText = officialTime(estimatedArrivalEvent?.eventDt);
  const dischargeTimeText = officialTime(actualDischargeEvent?.eventDt);
  const routeMarkedActual = text(route.etaFlag).toUpperCase() === 'A';
  const arrivalTimeText = actualArrivalText || routeArrivalText || estimatedArrivalText;
  const arrivalKind = actualArrivalText || (routeMarkedActual && routeArrivalText) ? 'ATA' : arrivalTimeText ? 'ETA' : null;
  const estimatedDischarge = text(estimatedDischargeEvent?.eventDt);
  const vessel = text(route.vslEngNm) || text(selected.vslEngNm) || '未提供';
  const voyage = [text(route.skdVoyNo), text(route.skdDirCd)].filter(Boolean).join('') || '未提供';
  const trackingEvents = structuredEvents(events);
  const routeStops = routeStopsFromOfficial(routes, trackingEvents);
  const routeText = routeStops.map((stop) => stop.name).join(' → ') || null;
  const facts: TrackingFact[] = [
    ['官网提单号', bookingNo],
    ['官网柜号', containerNo],
    ['追踪流水号', copNo],
    ['箱型', text(selected.cntrTpszNm) || text(selected.cntrTpszCd)],
    ['重量', text(selected.weight)],
    ['封号', text(selected.sealNo)],
    ['最新动态', statusName(selected)],
    ['最新动态时间', text(selected.eventDt)],
    ['最新动态地点', text(selected.placeNm)],
    ['最新作业区', text(selected.yardNm)],
    ...routeFacts(routes).map((fact) => [fact.label, fact.value] as [string, string]),
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
  const estimateNote = !dischargeTimeText && estimatedDischarge
    ? `；官网另有预计卸船 ${estimatedDischarge}，该事件标记为预计，未写成实际卸船`
    : '';
  return {
    arrivalTime: null,
    arrivalTimeText,
    arrivalKind,
    estimatedArrivalTimeText: estimatedArrivalText || routeArrivalText || null,
    arrived: Boolean(actualArrivalText || dischargeTimeText || (routeMarkedActual && routeArrivalText)),
    discharged: Boolean(dischargeTimeText),
    dischargeTime: null,
    dischargeTimeText,
    rawSummary: `森罗官方三段追踪解析成功；本次官网校验=${queryType === 'container' ? `柜号 ${expected}` : `提单号 ${billNo || bookingNo}`}；关联提单号=${bookingNo || '未提供'}；柜号=${text(selected.cntrNo) || expected || '未提供'}；船名=${vessel}；航次=${voyage}${dischargeTimeText ? '；已发现实际卸船事件' : '；未发现实际卸船事件'}；已解析 ${trackingEvents.length} 条事件和 ${routes.length} 个官方航段${routeText ? `；运行线路=${routeText}` : ''}${estimateNote}`,
    sourceUrl: SMLINE_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'SMLINE',
      queryType,
      queryValue: queryType === 'container' ? expected : billNo,
      capturedAt: new Date().toISOString(),
      routeStops,
      events: trackingEvents,
      currentPort: [...trackingEvents].reverse().find((event) => event.actual && event.location)?.location || text(selected.placeNm) || null,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText: estimatedArrivalText || routeArrivalText || null,
      facts,
    },
    rawPageText: JSON.stringify({ searchPayload, routePayload, eventPayload }, null, 2),
  };
}

async function readJson(response: Response, label: string) {
  const body = await response.text();
  if (!response.ok) {
    const category = response.status === 403 || response.status === 412 ? '验证码或风控' : '官网接口异常';
    throw trackingError(category, `森罗官网${label} HTTP ${response.status}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw trackingError(/cloudflare|captcha|验证/i.test(body) ? '验证码或风控' : '解析失败', `森罗官网${label}返回了非 JSON 内容`);
  }
}

export class SmLineTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async post(params: Record<string, string>, label: string, signal: AbortSignal) {
    const response = await this.fetcher(SMLINE_ENDPOINT, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal,
    });
    return readJson(response, label);
  }

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'SMLINE') throw trackingError('解析失败', `森罗解析器不能查询 ${input.rule.name}`);
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (input.queryType === 'bill' && !/^[A-Z0-9]{8,}$/.test(billNo)) {
      throw trackingError('订单号验证失败', `森罗提单号格式不正确：${billNo || '空'}`);
    }
    const expected = input.containerNo.trim().toUpperCase();
    if (input.queryType === 'container' && !/^[A-Z]{4}\d{7}$/.test(expected)) {
      throw trackingError('订单号验证失败', `森罗柜号格式不正确：${expected || '空'}`);
    }
    const queryValue = input.queryType === 'container' ? expected : billNo;
    const searchType = input.queryType === 'container' ? 'C' : 'B';
    const queryLabel = input.queryType === 'container' ? '柜号查询' : '提单查询';
    const request = requestContext(this.timeoutMs);
    try {
      const searchPayload = await this.post({ f_cmd: '121', search_type: searchType, search_name: queryValue }, queryLabel, request.signal);
      const shipments = payloadList(searchPayload, queryLabel);
      if (!shipments.length) throw trackingError('订单号验证失败', `森罗官网未找到${input.queryType === 'container' ? `柜号 ${expected}` : `提单 ${input.originalBillNo}`}`);
      const exactSelected = shipments.find((item) => {
        const returnedContainer = text(item.cntrNo).toUpperCase();
        const returnedBills = [text(item.blNo), text(item.bkgNo)].map((value) => value.toUpperCase());
        return input.queryType === 'container'
          ? returnedContainer === expected && returnedBills.includes(billNo)
          : returnedBills.includes(billNo) && returnedContainer === expected;
      });
      const referenceSelected = shipments.find((item) => {
        const returnedContainer = text(item.cntrNo).toUpperCase();
        const returnedBills = [text(item.blNo), text(item.bkgNo)].map((value) => value.toUpperCase());
        return input.queryType === 'container' ? returnedContainer === expected : returnedBills.includes(billNo);
      });
      if (input.queryType === 'bill' && expected && !exactSelected && referenceSelected) {
        throw trackingError('订单号验证失败', `森罗提单 ${billNo} 的结果未包含输入柜号 ${expected}，将改用柜号查询核验`);
      }
      const selected = exactSelected || referenceSelected;
      if (!selected) {
        throw trackingError('订单号验证失败', `森罗官网${queryLabel}返回结果与查询的${input.queryType === 'container' ? `柜号 ${expected}` : `提单号 ${billNo}`}不一致`);
      }
      const containerNo = text(selected.cntrNo);
      const bookingNo = text(selected.bkgNo) || billNo;
      const copNo = text(selected.copNo);
      if (!containerNo || !copNo) throw trackingError('解析失败', `森罗官网${queryLabel}结果缺少柜号或追踪流水号`);
      const [routePayload, eventPayload] = await Promise.all([
        this.post({ f_cmd: '124', bkg_no: bookingNo }, '航线查询', request.signal),
        this.post({ f_cmd: '125', cntr_no: containerNo, bkg_no: bookingNo, cop_no: copNo }, '货柜事件查询', request.signal),
      ]);
      const result = parseSmLineTrackingResponses(searchPayload, routePayload, eventPayload, expected, billNo, input.queryType);
      return {
        ...result,
        rawSummary: `${result.rawSummary}；本次通道=${input.queryType === 'container' ? `柜号 ${expected}` : `提单号 ${billNo}`}`,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '森罗官网查询超时，请稍后重试');
      throw error;
    } finally {
      request.dispose();
    }
  }
}
