import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const EVERGREEN_ENDPOINT = 'https://www.evergreen-shipping.cn/servlet/TDB1_CargoTracking.do';
const DEFAULT_TIMEOUT_MS = 18_000;

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hiddenValue(html: string, name: string) {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${escapeRegex(name)}["'][^>]*>`, 'i'))?.[0] || '';
  return decodeHtml(tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || '');
}

function formatEvergreenDate(value: string) {
  const match = value.trim().match(/^([A-Z]{3})-(\d{2})-(\d{4})$/i);
  if (!match) return '';
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(match[1].toUpperCase()) + 1;
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[2]}` : '';
}

function eventRows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]));
    return { date: cells[0] || '', event: cells[1] || '', location: cells[2] || '', vessel: cells[3] || '' };
  }).filter((row) => row.date && row.event);
}

export function parseEvergreenTrackingHtml(
  billHtml: string,
  movementHtml: string,
  queryBillNo: string,
  expectedContainerNo = '',
): TrackingResult {
  const bill = queryBillNo.trim().toUpperCase();
  if (!new RegExp(`EGLV\\s*${escapeRegex(bill)}`, 'i').test(billHtml)) {
    if (/not found|no result|未找到|查无/i.test(billHtml)) throw trackingError('订单号验证失败', `长荣官网未找到提单 EGLV${bill}`);
    throw trackingError('订单号验证失败', `长荣官网未确认输入提单 EGLV${bill}`);
  }
  const expected = expectedContainerNo.trim().toUpperCase();
  const returnedContainers = [...new Set([...billHtml.matchAll(/frmCntrMoveDetail\(['"]([A-Z]{4}\d{7})['"]\)/gi)].map((match) => match[1].toUpperCase()))];
  if (expected && returnedContainers.length && !returnedContainers.includes(expected)) {
    throw trackingError('订单号验证失败', `长荣官网返回的柜号与输入不一致（输入 ${expected}，官网返回 ${returnedContainers.join('、')}）`);
  }
  const rows = eventRows(movementHtml);
  if (!rows.length) throw trackingError('解析失败', '长荣官网货柜动态页没有可识别的事件记录');
  const discharge = rows.find((row) => /^discharged\b/i.test(row.event));
  const dischargeDate = discharge ? formatEvergreenDate(discharge.date) : '';
  const current = rows.at(-1);
  return {
    arrivalTime: null,
    arrivalKind: null,
    arrived: Boolean(discharge),
    dischargeTime: null,
    dischargeTimeText: dischargeDate ? `${dischargeDate}（官网仅提供日期）` : null,
    rawSummary: `长荣官方提单与货柜动态解析成功；柜号=${expected || returnedContainers[0] || '未提供'}；当前事件=${current?.event || '未提供'}${dischargeDate ? `；官网确认 ${dischargeDate} 已卸船，但未提供具体时刻` : '；未发现卸船完成事件'}`,
    sourceUrl: EVERGREEN_ENDPOINT,
  };
}

function cookiesFrom(response: Response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(/,(?=[^;,]+=)/).map((cookie) => cookie.split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

async function responseText(response: Response, label: string) {
  const body = await response.text();
  if (response.ok) return body;
  const category = response.status === 403 || response.status === 412 ? '验证码或风控' : response.status === 401 ? '官网拒绝访问' : '官网接口异常';
  throw trackingError(category, `长荣官网${label} HTTP ${response.status}`);
}

export class EvergreenTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'EVERGREEN') throw trackingError('解析失败', `长荣解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw trackingError('解析失败', '长荣解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^\d{10,14}$/.test(billNo)) throw trackingError('订单号验证失败', `长荣提单号格式不正确：EGLV${billNo || '空'}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const homeResponse = await this.fetcher(EVERGREEN_ENDPOINT, { headers: { accept: 'text/html' }, signal: controller.signal });
      await responseText(homeResponse, '首页');
      const cookie = cookiesFrom(homeResponse);
      const commonHeaders = { accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) };
      const billResponse = await this.fetcher(EVERGREEN_ENDPOINT, {
        method: 'POST',
        headers: commonHeaders,
        body: new URLSearchParams({ BL: billNo, CNTR: '', bkno: '', TYPE: 'BL', SEL: 's_bl', NO: billNo }),
        signal: controller.signal,
      });
      const billHtml = await responseText(billResponse, '提单查询');
      const expected = input.containerNo.trim().toUpperCase();
      const containerNo = expected || billHtml.match(/frmCntrMoveDetail\(['"]([A-Z]{4}\d{7})['"]\)/i)?.[1] || '';
      if (!containerNo) throw trackingError('解析失败', '长荣官网提单结果缺少货柜号');
      const params = {
        bl_no: hiddenValue(billHtml, 'bl_no') || billNo,
        cntr_no: containerNo,
        onboard_date: hiddenValue(billHtml, 'onboard_date'),
        pol: hiddenValue(billHtml, 'pol'),
        pod: hiddenValue(billHtml, 'pod'),
        podctry: hiddenValue(billHtml, 'podctry'),
        TYPE: 'CntrMove',
      };
      if (!params.onboard_date || !params.pol || !params.pod) throw trackingError('解析失败', '长荣官网提单结果缺少货柜动态查询参数');
      const movementResponse = await this.fetcher(EVERGREEN_ENDPOINT, {
        method: 'POST',
        headers: commonHeaders,
        body: new URLSearchParams(params),
        signal: controller.signal,
      });
      const movementHtml = await responseText(movementResponse, '货柜动态查询');
      return parseEvergreenTrackingHtml(billHtml, movementHtml, billNo, containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '长荣官网查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
