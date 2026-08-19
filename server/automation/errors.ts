import type { TrackingFailureCategory } from './types.js';

export class TrackingProviderError extends Error {
  constructor(
    readonly category: TrackingFailureCategory,
    message: string,
    readonly evidencePath?: string,
    readonly sourceUrl?: string,
  ) {
    super(message);
    this.name = 'TrackingProviderError';
  }
}

export function trackingError(category: TrackingFailureCategory, message: string, metadata: { evidencePath?: string; sourceUrl?: string } = {}) {
  return new TrackingProviderError(category, message, metadata.evidencePath, metadata.sourceUrl);
}

export function classifyTrackingError(error: unknown): { category: TrackingFailureCategory; reason: string; evidencePath?: string; sourceUrl?: string } {
  if (error instanceof TrackingProviderError) {
    return {
      category: error.category,
      reason: error.message,
      ...(error.evidencePath ? { evidencePath: error.evidencePath } : {}),
      ...(error.sourceUrl ? { sourceUrl: error.sourceUrl } : {}),
    };
  }
  const reason = error instanceof Error ? error.message : String(error || '未知抓取错误');
  if (/超时|timeout|aborted/i.test(reason)) return { category: '查询超时', reason };
  if (/cloudflare|captcha|验证码|验证页面|风控|HTTP\s*(403|412)\b/i.test(reason)) return { category: '验证码或风控', reason };
  if (/HTTP\s*401\b|拒绝访问|unauthorized|forbidden/i.test(reason)) return { category: '官网拒绝访问', reason };
  if (/格式不正确|未找到|无记录|no result|not found|invalid|不一致/i.test(reason)) {
    return { category: '订单号验证失败', reason };
  }
  if (/HTTP\s*(4\d\d|5\d\d)\b|接口|responseCode|errorCode|system error/i.test(reason)) return { category: '官网接口异常', reason };
  return { category: '解析失败', reason };
}
