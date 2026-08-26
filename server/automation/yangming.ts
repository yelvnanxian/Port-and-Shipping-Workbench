import { trackingError } from './errors.js';
import { parseOoclDate } from './oocl.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingDetail, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const YANGMING_ENDPOINT = 'https://www.yangming.com/api/CargoTracking/GetTracking';
const YANGMING_SOURCE = 'https://www.yangming.com/en/esolution/cargo_tracking';
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function objects(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanHtml(value: unknown) {
  return text(value)
    .replace(/<br\s*\/?\s*>/gi, ' · ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value: unknown) {
  return parseOoclDate(text(value));
}

function localTime(value: unknown) {
  const raw = text(value);
  return raw ? `${raw}（官网当地时间）` : null;
}

function sameReference(left: string, right: string) {
  return Boolean(left && right && left.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === right.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

function selectBill(payload: unknown, expectedBillNo: string) {
  const root = object(payload);
  const bills = objects(root.blList);
  const result = bills.find((item) => [item.queryTrackNo, item.returnTrackNo, item.bkgRef]
    .some((value) => value && sameReference(text(value), expectedBillNo))) || bills[0];
  if (!result || Number(root.successCnt || 0) < 1) {
    const message = text(root.responeMessage) || text(root.responseMessage);
    throw trackingError('订单号验证失败', `阳明官网未找到提单号 ${expectedBillNo}${message ? `；${message}` : ''}`);
  }
  const returnedBill = text(result.queryTrackNo) || text(result.returnTrackNo) || text(result.bkgRef);
  if (returnedBill && !sameReference(returnedBill, expectedBillNo)
    && ![result.returnTrackNo, result.bkgRef].some((value) => value && sameReference(text(value), expectedBillNo))) {
    throw trackingError('订单号验证失败', `阳明官网返回提单号 ${returnedBill} 与输入 ${expectedBillNo} 不一致`);
  }
  return {
    root,
    bill: result,
    returnedBill: returnedBill || expectedBillNo,
    // 详情接口的 paramRefNo 不是页面展示的完整提单号。阳明当前返回的
    // bkgRef/returnTrackNo 才是可用于 BL_CT 二次请求的内部参考号。
    detailRefNo: text(result.bkgRef) || text(result.returnTrackNo) || returnedBill || expectedBillNo,
  };
}

function containerSummaries(bl: JsonObject) {
  return [bl.containerInfo, bl.dcsaContainerInfo].flatMap(objects);
}

function selectContainerSummary(bl: JsonObject, expectedContainerNo: string) {
  const candidates = containerSummaries(bl);
  const selected = candidates.find((item) => sameReference(text(item.ctnrNo), expectedContainerNo)) || (!expectedContainerNo ? candidates[0] : undefined);
  if (!selected) {
    const returned = [...new Set(candidates.map((item) => text(item.ctnrNo)).filter(Boolean))];
    throw trackingError('订单号验证失败', `阳明官网未返回输入柜号 ${expectedContainerNo}${returned.length ? `（官网返回 ${returned.join('、')}）` : ''}`);
  }
  return selected;
}

function selectContainerDetail(payload: unknown, expectedContainerNo: string) {
  const root = object(payload);
  const candidates = objects(root.containerList);
  const selected = candidates.find((item) => [item.queryTrackNo, item.returnTrackNo].some((value) => sameReference(text(value), expectedContainerNo))) || candidates[0];
  if (!selected || Number(root.successCnt || 0) < 1) {
    const message = text(root.responeMessage) || text(root.responseMessage);
    throw trackingError('订单号验证失败', `阳明官网未找到柜号 ${expectedContainerNo}${message ? `；${message}` : ''}`);
  }
  const returned = text(selected.queryTrackNo) || text(selected.returnTrackNo);
  if (returned && !sameReference(returned, expectedContainerNo)) {
    throw trackingError('订单号验证失败', `阳明官网返回柜号 ${returned} 与输入 ${expectedContainerNo} 不一致`);
  }
  return selected;
}

function destinationSchedule(bl: JsonObject) {
  const schedule = objects(object(bl.routingInfo).routingSchedule);
  const destination = schedule.filter((item) => text(item.picQlfr).toUpperCase() === 'DESTINATION');
  return destination.at(-1) || schedule.at(-1) || {};
}

function transportMode(value: string): NonNullable<TrackingEventDetail['transportMode']> {
  if (/truck/i.test(value)) return 'truck';
  if (/rail/i.test(value)) return 'rail';
  if (/vessel|barge|ship/i.test(value)) return 'ocean';
  if (/terminal|depot|yard/i.test(value)) return 'terminal';
  return 'unknown';
}

function eventDefinition(description: string): { label: string; eventType: TrackingEventType; cargoState: TrackingCargoState } {
  if (/gate out of empty|empty to shipper/i.test(description)) return { label: '空箱交给发货人', eventType: 'origin', cargoState: 'empty' };
  if (/gate in of laden|received at origin/i.test(description)) return { label: '重箱进入始发场站', eventType: 'origin', cargoState: 'laden' };
  if (/discharg/i.test(description)) return { label: '有货柜卸船', eventType: 'discharge', cargoState: 'laden' };
  if (/arrival by vessel/i.test(description)) return { label: '载货船舶抵达目的港', eventType: 'arrival', cargoState: 'laden' };
  if (/load of laden|on board/i.test(description)) return { label: '有货柜装船', eventType: 'departure', cargoState: 'laden' };
  if (/departure by vessel/i.test(description)) return { label: '载货船舶离港', eventType: 'departure', cargoState: 'laden' };
  if (/arrival by barge/i.test(description)) return { label: '驳船抵达中转港', eventType: 'transshipment', cargoState: 'laden' };
  if (/departure by barge|in transit/i.test(description)) return { label: '驳船转运离港', eventType: 'transshipment', cargoState: 'laden' };
  if (/gate out of laden|full to consignee|pick(?:ed)?\s*up/i.test(description)) return { label: '有货柜提离场站', eventType: 'pickup', cargoState: 'laden' };
  if (/empty.*return|return.*empty/i.test(description)) return { label: '还空箱', eventType: 'empty-return', cargoState: 'empty' };
  if (/deliver/i.test(description)) return { label: '货物交付', eventType: 'delivery', cargoState: 'laden' };
  if (/arrived/i.test(description)) return { label: '抵达中转节点', eventType: 'transshipment', cargoState: 'laden' };
  return { label: description || '阳明货柜事件', eventType: 'other', cargoState: 'unknown' };
}

function vesselFromMode(value: string) {
  const parts = value.split('·').map((item) => item.trim()).filter(Boolean);
  const vesselIndex = parts.findIndex((item) => /vessel/i.test(item));
  const vesselName = vesselIndex >= 0 ? parts[vesselIndex + 1] || '' : '';
  const voyageNo = vesselIndex >= 0 ? (parts[vesselIndex + 2] || '').replace(/[()]/g, '') : '';
  return { vesselName: vesselName || null, voyageNo: voyageNo || null };
}

function yangmingEvents(detail: JsonObject) {
  const dcsa = objects(detail.dcsaStatusInfo);
  const rows = dcsa.length ? dcsa : objects(detail.ctStatusInfo);
  return rows.map((entry): TrackingEventDetail => {
    const description = cleanHtml(entry.eventDesc);
    const mode = cleanHtml(entry.tsMode);
    const definition = eventDefinition(description);
    const vessel = vesselFromMode(mode);
    const rawTime = text(entry.moveDate);
    const parsed = parseDate(rawTime);
    return {
      label: definition.label,
      eventType: definition.eventType,
      location: cleanHtml(entry.atFacility) || null,
      // 阳明接口未提供事件地点时区，结构化时间仅用于排序，界面保留官网当地时间原文。
      time: parsed?.toISOString() || null,
      timeText: localTime(rawTime),
      actual: !/estimated|planned|scheduled/i.test(`${description} ${text(entry.eventClassifie)}`),
      cargoState: definition.cargoState,
      facility: cleanHtml(entry.toFacility) || null,
      vesselName: vessel.vesselName,
      voyageNo: vessel.voyageNo,
      transportMode: transportMode(`${mode} ${cleanHtml(entry.atFacility)}`),
      sourceLine: description,
    };
  }).sort((left, right) => (parseDate(left.timeText?.replace('（官网当地时间）', '') || '')?.getTime() || 0) - (parseDate(right.timeText?.replace('（官网当地时间）', '') || '')?.getTime() || 0));
}

function normalizedLocation(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedLocation(left || '');
  const b = normalizedLocation(right || '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function yangmingRouteStops(events: TrackingEventDetail[], destination = ''): TrackingRouteStop[] {
  const segments: Array<{ name: string; events: TrackingEventDetail[] }> = [];
  for (const event of events) {
    const location = event.location?.trim();
    if (!location) continue;
    const current = segments.at(-1);
    if (current && normalizedLocation(current.name) === normalizedLocation(location)) current.events.push(event);
    else segments.push({ name: location, events: [event] });
  }
  return segments.map((segment, index) => {
    const hasDischarge = segment.events.some((event) => event.eventType === 'discharge' || event.eventType === 'arrival');
    const hasDeparture = segment.events.some((event) => event.eventType === 'departure' || event.eventType === 'transshipment');
    const hasDelivery = segment.events.some((event) => ['pickup', 'delivery', 'empty-return'].includes(event.eventType));
    const role: TrackingRouteStop['role'] = destination && sameLocation(segment.name, destination)
      ? 'discharge'
      : index === 0
      ? 'origin'
      : hasDischarge && !destination
        ? 'discharge'
        : hasDeparture
          ? 'transshipment'
          : hasDelivery || index === segments.length - 1
            ? 'delivery'
            : 'unknown';
    return { name: segment.name, role };
  });
}

function additionalFacts(bl: JsonObject) {
  const facts: Array<{ label: string; value: string }> = [];
  for (const section of objects(bl.additionalInfo)) {
    for (const row of objects(section.rowList)) {
      const label = text(row.statusTitleWording);
      const value = text(row.statusValue);
      if (label && value) facts.push({ label, value });
      const latest = objects(row.tableData).flatMap((table) => objects(table.tableRowList))
        .sort((left, right) => (parseDate(right.dateTime)?.getTime() || 0) - (parseDate(left.dateTime)?.getTime() || 0))[0];
      if (latest && !facts.some((fact) => fact.label === '最新海关动态')) {
        const latestValue = [text(latest.dateTime), text(latest.codeActivity)].filter(Boolean).join(' · ');
        if (latestValue) facts.push({ label: '最新海关动态', value: latestValue });
      }
    }
  }
  return facts;
}

function yangmingFacts(bl: JsonObject | null, detail: JsonObject, expectedBillNo: string, containerNo: string) {
  const basic = object(bl?.basicInfo);
  const summary = bl ? selectContainerSummary(bl, containerNo) : {};
  const entries: Array<[string, string]> = [
    ['提单号', expectedBillNo],
    ['柜号', containerNo],
    ['柜型', [text(detail.cnSize) || text(summary.cnSize), text(detail.cnTypeDesc) || text(summary.cnType)].filter(Boolean).join(' / ')],
    ['封号', text(summary.sealNo)],
    ['收货地', text(basic.receipt)],
    ['装货港', text(basic.loading)],
    ['卸货港', text(basic.discharge)],
    ['交货地', text(basic.delivery)],
    ['船舶/航次', [text(basic.vesselName), text(basic.vesselComn)].filter(Boolean).join(' / ')],
    ['运输条款', text(basic.serviceTerm)],
    ['件数', basic.numPkg ? `${String(basic.numPkg)} ${text(basic.pkgType)}` : ''],
    ['毛重', basic.grossWgt ? `${String(basic.grossWgt)} ${text(basic.grossWgtUnit)}` : ''],
    ['体积', basic.cbm ? `${String(basic.cbm)} ${text(basic.cbmUnit)}` : ''],
    ['VGM', summary.vgm ? `${String(summary.vgm)} ${text(summary.vgmUnit)}` : ''],
  ];
  return [
    ...entries.flatMap(([label, value]) => value ? [{ label, value }] : []),
    ...(bl ? additionalFacts(bl) : []),
  ];
}

function summaryResult(payload: unknown, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
  const { bill, returnedBill } = selectBill(payload, expectedBillNo);
  const summary = selectContainerSummary(bill, expectedContainerNo);
  const destination = destinationSchedule(bill);
  const destinationDate = parseDate(destination.dateTime);
  const actualArrival = /actual/i.test(text(destination.dateQlfr)) ? destinationDate : null;
  const estimatedArrival = !actualArrival && destinationDate ? destinationDate : null;
  const dischargeRecord = containerSummaries(bill).find((item) => sameReference(text(item.ctnrNo), text(summary.ctnrNo)) && /discharg|卸船/i.test(`${text(item.lastEvent)} ${text(item.eventDesc)} ${text(item.codeActivity)}`));
  const discharge = dischargeRecord ? parseDate(dischargeRecord.moveDate || dischargeRecord.dateTime) : null;
  const postDischarge = /(?:full to consignee|gate out of laden|picked?\s*up|delivered|empty|return)/i.test(`${text(summary.lastEvent)} ${text(summary.eventDesc)} ${text(summary.codeActivity)}`);
  if (!actualArrival && !estimatedArrival && !discharge && !postDischarge) throw trackingError('解析失败', `阳明官网已返回提单 ${expectedBillNo}，但没有可验证的到港或卸船时间`);
  return {
    arrivalTime: actualArrival || estimatedArrival,
    arrivalTimeText: localTime(destination.dateTime),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText: estimatedArrival ? localTime(destination.dateTime) : null,
    arrived: Boolean(actualArrival || discharge || postDischarge),
    discharged: Boolean(discharge || postDischarge),
    dischargeTime: discharge,
    dischargeTimeText: localTime(dischargeRecord?.moveDate || dischargeRecord?.dateTime),
    rawSummary: `阳明官方公开接口摘要解析成功；官网提单=${returnedBill}${discharge ? `；柜号 ${text(summary.ctnrNo)} 已发现卸船事件` : postDischarge ? `；柜号 ${text(summary.ctnrNo)} 确认已卸船但官网当前摘要未保留精确卸船时间` : '；未发现实际卸船事件'}`,
    sourceUrl: YANGMING_SOURCE,
  };
}

export function parseYangmingTrackingResponse(payload: unknown, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
  return summaryResult(payload, expectedBillNo, expectedContainerNo);
}

export function parseYangmingTrackingResponses(
  summaryPayload: unknown | null,
  detailPayload: unknown,
  expectedBillNo: string,
  expectedContainerNo: string,
  context: { queryType: TrackingQuery['queryType']; queryValue: string },
): TrackingResult {
  const selectedBill = summaryPayload ? selectBill(summaryPayload, expectedBillNo) : null;
  const detail = selectContainerDetail(detailPayload, expectedContainerNo);
  const containerNo = text(detail.queryTrackNo) || text(detail.returnTrackNo) || expectedContainerNo;
  const events = yangmingEvents(detail);
  if (!events.length) throw trackingError('解析失败', `阳明官网已返回柜号 ${containerNo}，但完整事件接口没有可核验的轨迹记录`);
  const summaryDestination = selectedBill ? destinationSchedule(selectedBill.bill) : {};
  const basic = object(selectedBill?.bill.basicInfo);
  const destination = text(basic.discharge) || text(basic.delivery) || text(summaryDestination.placeName);
  const routeStops = yangmingRouteStops(events, destination);
  const summaryArrivalDate = parseDate(summaryDestination.dateTime);
  const summaryActualArrival = /actual/i.test(text(summaryDestination.dateQlfr)) ? summaryArrivalDate : null;
  const isDestinationEvent = (event: TrackingEventDetail) => !destination
    || [event.location, event.facility].some((location) => location && sameLocation(location, destination));
  const destinationEvents = events.filter(isDestinationEvent);
  const actualArrivalEvent = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const estimatedArrival = !summaryActualArrival && !actualArrivalEvent && summaryArrivalDate ? summaryArrivalDate : null;
  const dischargeEvent = [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  const postDischarge = destinationEvents.some((event) => ['pickup', 'delivery', 'empty-return'].includes(event.eventType));
  const actualArrival = summaryActualArrival || (actualArrivalEvent?.time ? new Date(actualArrivalEvent.time) : null);
  const arrival = actualArrival || estimatedArrival;
  const discharge = dischargeEvent?.time ? new Date(dischargeEvent.time) : null;
  const estimatedArrivalTimeText = !summaryActualArrival && summaryDestination.dateTime ? localTime(summaryDestination.dateTime) : null;
  const trackingDetail: TrackingDetail = {
    carrierCode: 'YANGMING',
    queryType: context.queryType,
    queryValue: context.queryValue,
    capturedAt: new Date().toISOString(),
    routeStops,
    events,
    currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
    estimatedArrivalPort: destination || null,
    estimatedArrivalTimeText,
    facts: yangmingFacts(selectedBill?.bill || null, detail, selectedBill?.returnedBill || expectedBillNo, containerNo),
  };
  const routeText = routeStops.map((stop) => stop.name).join(' → ');
  return {
    arrivalTime: arrival,
    arrivalTimeText: localTime((summaryActualArrival || estimatedArrival)
      ? summaryDestination.dateTime
      : actualArrivalEvent?.timeText?.replace('（官网当地时间）', '')),
    arrivalKind: summaryActualArrival || actualArrivalEvent ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText,
    // ETA 只用于显示预计到港时间，不能把船只状态提前标成已到港。
    arrived: Boolean(actualArrival || discharge || postDischarge),
    discharged: Boolean(dischargeEvent || postDischarge),
    dischargeTime: discharge,
    dischargeTimeText: dischargeEvent?.timeText || null,
    rawSummary: `阳明官方提单与货柜详情解析成功；官网提单=${selectedBill?.returnedBill || expectedBillNo || '未提供'}；柜号=${containerNo}；已核验完整轨迹 ${events.length} 条${dischargeEvent ? '；已发现实际卸船事件' : postDischarge ? '；已发现卸船后事件' : '；未发现实际卸船事件'}`,
    sourceUrl: YANGMING_SOURCE,
    routeText,
    trackingDetail,
    rawPageText: JSON.stringify({ summary: summaryPayload, detail: detailPayload }, null, 2),
  };
}

export class YangmingTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async fetchPayload(trackNo: string, position: string, refNo: string, controller: AbortController, label: string) {
    const url = new URL(YANGMING_ENDPOINT);
    url.searchParams.set('paramTrackNo', trackNo);
    url.searchParams.set('paramTrackPosition', position);
    url.searchParams.set('paramRefNo', refNo);
    const response = await this.fetcher(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        referer: YANGMING_SOURCE,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const category = response.status === 403 || response.status === 412 ? '验证码或风控' : '官网接口异常';
      throw trackingError(category, `阳明官方${label} HTTP ${response.status}`);
    }
    try { return JSON.parse(body) as unknown; } catch { throw trackingError('解析失败', `阳明官方${label}返回了非 JSON 内容`); }
  }

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'YANGMING') throw trackingError('解析失败', `阳明解析器不能查询 ${input.rule.name}`);
    const billNo = input.queryBillNo.trim().toUpperCase();
    const containerNo = input.containerNo.trim().toUpperCase();
    if (input.queryType === 'bill' && !billNo) throw trackingError('订单号验证失败', '阳明提单号为空');
    if (input.queryType === 'container' && !/^[A-Z]{4}\d{7}$/.test(containerNo)) throw trackingError('订单号验证失败', `阳明柜号格式不正确：${containerNo || '空'}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (input.queryType === 'container') {
        const detailPayload = await this.fetchPayload(containerNo, 'SEARCH', '', controller, '柜号详情接口');
        return parseYangmingTrackingResponses(null, detailPayload, input.originalBillNo, containerNo, { queryType: 'container', queryValue: containerNo });
      }
      const summaryPayload = await this.fetchPayload(billNo, 'SEARCH', '', controller, '提单摘要接口');
      const selected = selectBill(summaryPayload, billNo);
      const summary = selectContainerSummary(selected.bill, containerNo);
      const returnedContainer = text(summary.ctnrNo);
      if (!returnedContainer) throw trackingError('解析失败', '阳明提单摘要缺少柜号，无法读取完整货柜轨迹');
      const position = text(summary.trackPositionOut) || 'BL_CT';
      const detailPayload = await this.fetchPayload(returnedContainer, position, selected.detailRefNo, controller, '柜号详情接口');
      return parseYangmingTrackingResponses(summaryPayload, detailPayload, billNo, returnedContainer, { queryType: 'bill', queryValue: billNo });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '阳明官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
