import { trackingError } from './errors.js';
import { parseOoclDate } from './oocl.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const YANGMING_ENDPOINT = 'https://www.yangming.com/api/CargoTracking/GetTracking';
const YANGMING_SOURCE = 'https://www.yangming.com/en/esolution/cargo_tracking';
const DEFAULT_TIMEOUT_MS = 15_000;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDate(value: unknown) {
  return parseOoclDate(text(value));
}

function sameReference(left: string, right: string) {
  return left.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === right.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function destinationSchedule(bl: Record<string, unknown>) {
  const routing = object(bl.routingInfo);
  const schedule = Array.isArray(routing.routingSchedule) ? routing.routingSchedule.map(object) : [];
  const destination = schedule.filter((item) => String(item.picQlfr || '').toUpperCase() === 'DESTINATION');
  return destination.at(-1) || schedule.at(-1) || {};
}

function matchingContainerInfo(bl: Record<string, unknown>, expectedContainerNo: string) {
  const expected = expectedContainerNo.trim().toUpperCase();
  const lists = [bl.containerInfo, bl.dcsaContainerInfo];
  const candidates = lists.flatMap((value) => Array.isArray(value) ? value.map(object) : []);
  if (!expected) return candidates;
  return candidates.filter((item) => sameReference(text(item.ctnrNo), expected));
}

export function parseYangmingTrackingResponse(payload: unknown, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
  const root = object(payload);
  const bills = Array.isArray(root.blList) ? root.blList.map(object) : [];
  const bookings = Array.isArray(root.bookingList) ? root.bookingList.map(object) : [];
  const containers = Array.isArray(root.containerList) ? root.containerList.map(object) : [];
  const matches = [...bills, ...bookings, ...containers].filter((item) => [item.queryTrackNo, item.returnTrackNo, item.bkgRef, item.ctnrNo]
    .some((value) => value && sameReference(text(value), expectedBillNo)));
  const result = bills.find((item) => [item.queryTrackNo, item.returnTrackNo, item.bkgRef]
    .some((value) => value && sameReference(text(value), expectedBillNo))) || bills[0];
  if (!result || (!matches.length && Number(root.successCnt || 0) < 1)) {
    const message = text(root.responeMessage) || text(root.responseMessage);
    throw trackingError('订单号验证失败', `阳明官网未找到提单号 ${expectedBillNo}${message ? `；${message}` : ''}`);
  }

  const returnedBill = text(result.queryTrackNo) || text(result.returnTrackNo) || text(result.bkgRef);
  if (returnedBill && !sameReference(returnedBill, expectedBillNo)
    && ![result.returnTrackNo, result.bkgRef].some((value) => value && sameReference(text(value), expectedBillNo))) {
    throw trackingError('订单号验证失败', `阳明官网返回提单号 ${returnedBill} 与输入 ${expectedBillNo} 不一致`);
  }

  const returnedContainers = matchingContainerInfo(result, expectedContainerNo);
  if (expectedContainerNo && !returnedContainers.length) {
    throw trackingError('订单号验证失败', `阳明官网未返回输入柜号 ${expectedContainerNo}`);
  }

  const destination = destinationSchedule(result);
  const destinationDate = parseDate(destination.dateTime);
  const actualArrival = /actual/i.test(text(destination.dateQlfr)) ? destinationDate : null;
  const estimatedArrival = !actualArrival && destinationDate ? destinationDate : null;
  const dischargeRecord = returnedContainers.find((item) => /discharg|卸船/i.test(`${text(item.lastEvent)} ${text(item.eventDesc)} ${text(item.codeActivity)}`));
  const discharge = dischargeRecord ? parseDate(dischargeRecord.moveDate || dischargeRecord.dateTime) : null;
  if (!actualArrival && !estimatedArrival && !discharge) {
    throw trackingError('解析失败', `阳明官网已返回提单 ${expectedBillNo}，但没有可验证的到港或卸船时间`);
  }

  return {
    arrivalTime: actualArrival || estimatedArrival,
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    arrived: Boolean(actualArrival || discharge),
    dischargeTime: discharge,
    rawSummary: `阳明官方公开接口解析成功；官网提单=${returnedBill || expectedBillNo}${discharge ? `；柜号 ${expectedContainerNo || text(dischargeRecord?.ctnrNo)} 已发现卸船事件` : '；未发现实际卸船事件'}`,
    sourceUrl: YANGMING_SOURCE,
  };
}

export class YangmingTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'YANGMING') throw trackingError('解析失败', `阳明解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw trackingError('解析失败', '阳明解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!billNo) throw trackingError('订单号验证失败', '阳明提单号为空');
    const url = new URL(YANGMING_ENDPOINT);
    url.searchParams.set('paramTrackNo', billNo);
    url.searchParams.set('paramTrackPosition', 'SEARCH');
    url.searchParams.set('paramRefNo', '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
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
        throw trackingError(category, `阳明官方接口 HTTP ${response.status}`);
      }
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw trackingError('解析失败', '阳明官方接口返回了非 JSON 内容'); }
      return parseYangmingTrackingResponse(payload, billNo, input.containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '阳明官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
