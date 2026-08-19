import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { ArrivalKind, TrackingQuery, TrackingResult } from './types.js';

const ONE_ENDPOINT = 'https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace/search';
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
    case 'E087': return 'Vessel Arrival at Port of Discharge';
    case 'E089': return 'Vessel Berthing at Port of Discharge';
    case 'E090': return 'Unloaded from Vessel at Port of Discharging';
    default: return '';
  }
}

function eventDate(event: JsonObject) {
  // The API's date field is an explicit UTC instant. localPortDate is a
  // display value and is not used to avoid applying a second timezone shift.
  return date(event.date) || date(event.eventDate) || date(event.eventLocalPortDate);
}

function isActual(event: JsonObject) {
  return /actual/i.test(text(event.trigger) || text(event.triggerType));
}

function isDestinationArrival(name: string) {
  return /(vessel\s+arrival|vessel\s+berthing).*(port\s+of\s+discharge|pod)/i.test(name)
    || /到港|靠泊/i.test(name);
}

function isDischarge(name: string) {
  return /(unload|discharg).*(vessel|port\s+of\s+discharg)/i.test(name)
    || /卸船|卸载/i.test(name);
}

export function parseOneTrackingResponse(payload: unknown, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
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

  const events = Array.isArray(row.cargoEvents) ? row.cargoEvents.map(object) : [];
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
  return {
    arrivalTime,
    arrivalKind,
    arrived: Boolean(actualArrival || discharge),
    dischargeTime: discharge,
    rawSummary: `海洋网联官方公开接口解析成功；提单=${returnedBill || expectedBillNo}；柜号=${returnedContainer || expectedContainerNo || '未提供'}${discharge ? '；已发现实际卸船事件' : '；未发现实际卸船事件'}`,
    sourceUrl: ONE_SOURCE,
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
      return parseOneTrackingResponse(payload, input.queryType === 'bill' ? input.queryBillNo : '', input.containerNo || (input.queryType === 'container' ? queryValue : ''));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '海洋网联官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
