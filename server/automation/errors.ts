import type { TrackingFailureCategory } from './types.js';

const REFERENCE_MISS_PATTERN = /(?:未找到|查无|无记录|无结果|无数据|没有(?:可用|对应|匹配)?(?:的)?(?:订单|提单|货物|查询)?结果|未返回(?:该|对应)?(?:订单|提单|货物记录|查询结果)|no\s+(?:result|record|shipment|data)|not\s+found|invalid\s+(?:booking|bill|cargo|tracking))/i;

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
  if (/超时|timeout|aborted|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|network request failed|fetch failed|页面被关闭|target closed|page crashed/i.test(reason)) return { category: '查询超时', reason };
  if (/cloudflare|captcha|验证码|验证页面|风控|HTTP\s*(403|412)\b/i.test(reason)) return { category: '验证码或风控', reason };
  if (/HTTP\s*401\b|拒绝访问|unauthorized|forbidden/i.test(reason)) return { category: '官网拒绝访问', reason };
  if (/格式不正确|未找到|无记录|no result|not found|invalid|不一致/i.test(reason)) {
    return { category: '订单号验证失败', reason };
  }
  if (/HTTP\s*(4\d\d|5\d\d)\b|接口|responseCode|errorCode|system error/i.test(reason)) return { category: '官网接口异常', reason };
  return { category: '解析失败', reason };
}

/**
 * 只有官网明确表示号码不存在/无结果时，才允许从提单号切换到柜号。
 * 验证码、风控、网络错误和普通页面解析失败都不能据此判断提单无效。
 */
export function isReferenceMissFailure(failure: Pick<ReturnType<typeof classifyTrackingError>, 'category' | 'reason'>) {
  const reason = failure.reason.trim();
  const explicitContainerFallback = /(?:将|已)(?:按|改用|使用).{0,12}柜号(?:查询|核验)/i.test(reason);
  // “订单号验证失败” also covers malformed input and cross-record
  // mismatches. Those are not evidence that the bill reference itself is
  // absent, so silently switching to a container query could return another
  // shipment and violate the data-authenticity guarantee.
  if (explicitContainerFallback) return true;
  if (/(?:格式不正确|为空|不能为空|不一致|未包含输入|返回.*与查询|拒绝写入|缺少.*柜号)/i.test(reason)) return false;
  if (failure.category === '订单号验证失败') {
    return REFERENCE_MISS_PATTERN.test(reason);
  }
  if (failure.category !== '解析失败') return false;
  return REFERENCE_MISS_PATTERN.test(reason);
}
