import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const MATSON_ENDPOINT = 'https://api.cargo.chinamatson.com/cargotrack/cargopub';
const MATSON_SOURCE = 'https://www.cargo.chinamatson.com/';
const DEFAULT_TIMEOUT_MS = 15_000;

function allObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(allObjects);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(allObjects)];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(object: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = text(object[key]);
    if (value) return value;
  }
  return '';
}

function parseDate(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizedContainer(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function apiMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const object = payload as Record<string, unknown>;
  return [text(object.errorCode) ? `errorCode=${text(object.errorCode)}` : '', text(object.errorMessage) || text(object.message)].filter(Boolean).join('；');
}

export function parseMatsonTrackingResponse(payload: unknown, expectedContainerNo = ''): TrackingResult {
  const objects = allObjects(payload);
  const error = apiMessage(payload);
  if (error) throw trackingError('官网接口异常', `美森官方接口返回错误：${error}`);
  const containers = [...new Set(objects.map((object) => firstText(object, ['containerNumber', 'containerNo'])).filter(Boolean))];
  const expected = normalizedContainer(expectedContainerNo);
  if (expected && containers.length && !containers.some((container) => normalizedContainer(container) === expected)) {
    throw trackingError('订单号验证失败', `美森官网返回的柜号与输入不一致（输入 ${expected}，官网返回 ${containers.join('、')}）`);
  }
  if (!objects.length || (!containers.length && objects.length <= 1)) throw trackingError('订单号验证失败', '美森官网未返回该提单的货物记录');
  const arrival = objects.map((object) => parseDate(firstText(object, ['actualArrivalDate', 'arrivalDate', 'eta']))).find(Boolean) || null;
  const dischargeObject = objects.find((object) => /discharg|unload/i.test(firstText(object, ['eventName', 'status', 'latestStatus', 'description'])));
  const discharge = dischargeObject ? parseDate(firstText(dischargeObject, ['eventDateTime', 'eventDate', 'statusDateTime', 'date'])) : null;
  return {
    arrivalTime: arrival,
    arrivalKind: arrival ? 'ETA' : null,
    arrived: Boolean(discharge),
    dischargeTime: discharge,
    rawSummary: `美森官方公开接口解析成功；柜号=${expectedContainerNo.trim().toUpperCase() || containers[0] || '未提供'}${discharge ? '；已发现卸船事件' : '；未发现卸船完成事件'}`,
    sourceUrl: MATSON_SOURCE,
  };
}

export class MatsonTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'MATSON') throw trackingError('解析失败', `美森解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw trackingError('解析失败', '美森解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^MATS[A-Z0-9]{6,}$/.test(billNo)) throw trackingError('订单号验证失败', `美森提单号格式不正确：${billNo || '空'}`);
    const url = new URL(MATSON_ENDPOINT);
    url.searchParams.set('cargoNumber', billNo);
    // 官网 CargoPortal 的“关单号”查询使用 bk；bl 会返回 CS.0004。
    url.searchParams.set('type', 'bk');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      const body = await response.text();
      let payload: unknown = null;
      try { payload = body ? JSON.parse(body) : null; } catch { /* 错误分类使用原始正文 */ }
      if (!response.ok) {
        const detail = apiMessage(payload) || body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || '无响应正文';
        const category = response.status === 401 ? '官网拒绝访问' : response.status === 403 || response.status === 412 ? '验证码或风控' : '官网接口异常';
        throw trackingError(category, `美森官方接口 HTTP ${response.status}：${detail}`);
      }
      if (payload === null) throw trackingError('解析失败', '美森官方接口返回了非 JSON 内容');
      return parseMatsonTrackingResponse(payload, input.containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '美森官方接口查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
