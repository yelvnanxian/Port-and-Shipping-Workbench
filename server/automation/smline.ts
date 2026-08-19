import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

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

function parseOfficialDateTime(value: unknown) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const parsed = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]) - 8, Number(match[5]), Number(match[6] || 0),
  ));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  return /arrival at port of discharg/i.test(text(event.statusNm));
}

function isDischargeEvent(event: Record<string, unknown>) {
  return /unloaded|discharged/i.test(text(event.statusNm));
}

export function parseSmLineTrackingResponses(
  searchPayload: unknown,
  routePayload: unknown,
  eventPayload: unknown,
  expectedContainerNo = '',
): TrackingResult {
  const shipments = payloadList(searchPayload, '提单查询');
  if (!shipments.length) throw trackingError('订单号验证失败', '森罗官网未找到该提单号');
  const expected = expectedContainerNo.trim().toUpperCase();
  const returnedContainers = [...new Set(shipments.map((item) => text(item.cntrNo).toUpperCase()).filter(Boolean))];
  if (expected && returnedContainers.length && !returnedContainers.includes(expected)) {
    throw trackingError('订单号验证失败', `森罗官网返回的柜号与输入不一致（输入 ${expected}，官网返回 ${returnedContainers.join('、')}）`);
  }

  const selected = shipments.find((item) => text(item.cntrNo).toUpperCase() === expected) || shipments[0];
  const routes = payloadList(routePayload, '航线查询');
  const events = payloadList(eventPayload, '货柜事件查询');
  const route = routes[0] || {};
  const actualArrivalEvent = events.find((event) => text(event.actTpCd).toUpperCase() === 'A' && isArrivalEvent(event));
  const estimatedArrivalEvent = events.find((event) => text(event.actTpCd).toUpperCase() !== 'A' && isArrivalEvent(event));
  const actualDischargeEvent = events.find((event) => text(event.actTpCd).toUpperCase() === 'A' && isDischargeEvent(event));
  const estimatedDischargeEvent = events.find((event) => text(event.actTpCd).toUpperCase() !== 'A' && isDischargeEvent(event));
  const routeArrival = parseOfficialDateTime(route.eta);
  const actualArrival = parseOfficialDateTime(actualArrivalEvent?.eventDt);
  const estimatedArrival = parseOfficialDateTime(estimatedArrivalEvent?.eventDt);
  const dischargeTime = parseOfficialDateTime(actualDischargeEvent?.eventDt);
  const routeMarkedActual = text(route.etaFlag).toUpperCase() === 'A';
  const arrivalTime = actualArrival || routeArrival || estimatedArrival;
  const arrivalKind = actualArrival || (routeMarkedActual && routeArrival) ? 'ATA' : arrivalTime ? 'ETA' : null;
  const estimatedDischarge = text(estimatedDischargeEvent?.eventDt);
  const vessel = text(route.vslEngNm) || text(selected.vslEngNm) || '未提供';
  const voyage = [text(route.skdVoyNo), text(route.skdDirCd)].filter(Boolean).join('') || '未提供';
  const estimateNote = !dischargeTime && estimatedDischarge
    ? `；官网另有预计卸船 ${estimatedDischarge}，该事件标记为预计，未写成实际卸船`
    : '';
  return {
    arrivalTime,
    arrivalKind,
    arrived: Boolean(actualArrival || dischargeTime || (routeMarkedActual && routeArrival)),
    dischargeTime,
    rawSummary: `森罗官方三段追踪解析成功；柜号=${text(selected.cntrNo) || expected || '未提供'}；船名=${vessel}；航次=${voyage}${dischargeTime ? '；已发现实际卸船事件' : '；未发现实际卸船事件'}${estimateNote}`,
    sourceUrl: SMLINE_SOURCE,
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
    if (input.queryType !== 'bill') throw trackingError('解析失败', '森罗解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,}$/.test(billNo)) throw trackingError('订单号验证失败', `森罗提单号格式不正确：${billNo || '空'}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const searchPayload = await this.post({ f_cmd: '121', search_type: 'B', search_name: billNo }, '提单查询', controller.signal);
      const shipments = payloadList(searchPayload, '提单查询');
      if (!shipments.length) throw trackingError('订单号验证失败', `森罗官网未找到提单 ${input.originalBillNo}`);
      const expected = input.containerNo.trim().toUpperCase();
      const selected = shipments.find((item) => text(item.cntrNo).toUpperCase() === expected) || shipments[0];
      const containerNo = text(selected.cntrNo);
      const bookingNo = text(selected.bkgNo) || billNo;
      const copNo = text(selected.copNo);
      if (!containerNo || !copNo) throw trackingError('解析失败', '森罗官网提单结果缺少柜号或追踪流水号');
      const [routePayload, eventPayload] = await Promise.all([
        this.post({ f_cmd: '124', bkg_no: bookingNo }, '航线查询', controller.signal),
        this.post({ f_cmd: '125', cntr_no: containerNo, bkg_no: bookingNo, cop_no: copNo }, '货柜事件查询', controller.signal),
      ]);
      return parseSmLineTrackingResponses(searchPayload, routePayload, eventPayload, expected);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '森罗官网查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
