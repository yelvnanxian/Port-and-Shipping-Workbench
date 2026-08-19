import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const HEDE_ENDPOINT = 'http://elines.hedehk.com/getVBilldynamic';
const HEDE_SOURCE = 'http://elines.hedehk.com/cargoDynamic';
const DEFAULT_TIMEOUT_MS = 15_000;

function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]) - 8, Number(match[5]), Number(match[6] || 0),
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

function cellsFromHtml(html: string) {
  const row = html.match(/<tr[^>]*class=["']read-tr["'][^>]*>([\s\S]*?)<\/tr>/i)?.[1];
  if (!row) return null;
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
}

export function parseHedeTrackingHtml(html: string, expectedBillNo = '', expectedContainerNo = ''): TrackingResult {
  const cells = cellsFromHtml(html);
  if (!cells || cells.length < 10) {
    if (/未找到|没有|无记录|not found|no result/i.test(html)) throw new Error('合德官网未找到该提单或柜号');
    throw new Error('合德官网返回了无法识别的时间线格式');
  }
  const billNo = cells[0].toUpperCase();
  const containerNo = cells[1].toUpperCase();
  if (expectedBillNo && billNo !== expectedBillNo.trim().toUpperCase()) throw new Error(`合德返回提单号不一致：${billNo}`);
  if (expectedContainerNo && containerNo !== expectedContainerNo.trim().toUpperCase()) throw new Error(`合德返回柜号不一致：${containerNo}`);

  const eta = parseDate(cells[5]);
  const discharge = parseDate(cells[9]);
  const vessel = cells[2];
  const voyage = cells[3];
  return {
    arrivalTime: eta,
    arrivalKind: eta ? 'ETA' : null,
    arrived: Boolean(discharge),
    dischargeTime: discharge,
    rawSummary: `合德官方时间线解析成功；船名=${vessel || '未提供'}；航次=${voyage || '未提供'}；${discharge ? '已发现卸船时间' : '未发现卸船时间'}`,
    sourceUrl: HEDE_SOURCE,
  };
}

export class HedeTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'HEDE') throw new Error(`合德解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw new Error('合德解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^HDUJ[A-Z0-9]{6,}$/.test(billNo)) throw new Error(`合德提单号格式不正确：${billNo || '空'}`);
    const body = new URLSearchParams({ billno: billNo, cntr: input.containerNo.trim().toUpperCase() }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(HEDE_ENDPOINT, {
        method: 'POST',
        headers: { accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`合德官网 HTTP ${response.status}`);
      return parseHedeTrackingHtml(await response.text(), billNo, input.containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('合德官网查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
