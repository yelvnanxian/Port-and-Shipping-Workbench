import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export function probeUrl(input: TrackingQuery) {
  const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
  const url = new URL(input.rule.url);
  switch (input.rule.code) {
    case 'ONE': url.searchParams.set('trackingNo', queryValue); break;
    case 'MAERSK': return new URL(encodeURIComponent(queryValue), url.toString().endsWith('/') ? url : `${url}/`);
    case 'MSC': url.searchParams.set('match', queryValue); break;
    case 'ZIM': url.searchParams.set('consnumber', queryValue); break;
    case 'YANGMING': url.searchParams.set('No', queryValue); break;
    case 'CMA': url.searchParams.set('SearchBy', 'BL'); url.searchParams.set('Reference', queryValue); break;
    case 'COSCO': url.searchParams.set('number', queryValue); break;
    case 'HAPAG': url.searchParams.set('blno', queryValue); break;
    case 'HMM': url.searchParams.set('type', 'B'); url.searchParams.set('num', queryValue); break;
    case 'WANHAI': return new URL(input.rule.url);
    default: url.searchParams.set('query', queryValue);
  }
  return url;
}

function pageTitle(body: string) {
  return body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '';
}

function responseDetail(body: string) {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return [payload.errorCode ? `errorCode=${String(payload.errorCode)}` : '', payload.errorMessage || payload.message || payload.error]
      .filter(Boolean).join('；').slice(0, 220);
  } catch {
    return body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  }
}

export class OfficialSiteProbeProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `${input.rule.name}${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const url = probeUrl(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = await response.text();
      const detail = responseDetail(body);
      if (response.status === 403 || response.status === 412 || /cloudflare|cf-chl|captcha|access denied|verify you are human|验证码/i.test(body)) {
        throw trackingError('验证码或风控', `${input.rule.name}官网请求 ${queryValue} 被风控拦截（HTTP ${response.status}${detail ? `；${detail}` : ''}）`);
      }
      if (response.status === 401) throw trackingError('官网拒绝访问', `${input.rule.name}官网请求 ${queryValue} 返回 HTTP 401${detail ? `：${detail}` : ''}`);
      if (!response.ok) throw trackingError('官网接口异常', `${input.rule.name}官网请求 ${queryValue} 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      if (/no result|not found|invalid (booking|bill|cargo|tracking)|未找到|查无|无记录/i.test(body)) {
        throw trackingError('订单号验证失败', `${input.rule.name}官网未找到 ${queryValue}${detail ? `；官网响应：${detail}` : ''}`);
      }
      const title = pageTitle(body);
      throw trackingError('解析失败', `${input.rule.name}官网已真实请求 ${queryValue} 并返回 HTTP 200，但响应为动态页面${title ? `（${title}）` : ''}，未包含可验证的 ATA/ETA 或卸船字段`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', `${input.rule.name}官网查询 ${queryValue} 超时`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
