import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { classifyTrackingError, isReferenceMissFailure, trackingError } from './errors.js';
import type { TrackingQuery, TrackingResult, WorkbookRecord } from './types.js';

export interface TrackingProvider {
  query(input: TrackingQuery): Promise<TrackingResult>;
  close?(): Promise<void>;
}

function queryCacheKey(input: TrackingQuery) {
  const normalize = (value: string) => value.trim().toUpperCase();
  return [
    input.rule.code,
    input.queryType,
    normalize(input.queryType === 'container' ? input.containerNo : input.queryBillNo),
    normalize(input.originalBillNo),
    normalize(input.containerNo),
  ].join('|');
}

/**
 * 单次批量任务内的查询缓存。
 * 成功结果可以安全复用；失败不缓存，避免临时网络问题阻塞后续重试。
 * 同一查询同时进入时复用 in-flight Promise，避免重复打到官网。
 */
export class CachedTrackingProvider implements TrackingProvider {
  private readonly results = new Map<string, TrackingResult>();
  private readonly referenceMisses = new Map<string, { error: unknown; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<TrackingResult>>();

  constructor(
    private readonly inner: TrackingProvider,
    private readonly referenceMissTtlMs = 5 * 60 * 1000,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const key = queryCacheKey(input);
    const cached = this.results.get(key);
    if (cached) return Promise.resolve(cached);
    const referenceMiss = this.referenceMisses.get(key);
    if (referenceMiss) {
      if (referenceMiss.expiresAt > Date.now()) return Promise.reject(referenceMiss.error);
      this.referenceMisses.delete(key);
    }
    const active = this.pending.get(key);
    if (active) return active;
    const request = this.inner.query(input)
      .then((result) => {
        this.results.set(key, result);
        return result;
      })
      .catch((error) => {
        const failure = classifyTrackingError(error);
        // 只有官网明确表示号码不存在时才缓存；验证码、限流、超时和
        // 解析异常必须允许后续记录重新尝试。
        if (failure.category === '订单号验证失败') {
          this.referenceMisses.set(key, { error, expiresAt: Date.now() + this.referenceMissTtlMs });
        }
        throw error;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }

  clear() {
    this.results.clear();
    this.referenceMisses.clear();
    this.pending.clear();
  }

  async close() {
    await this.inner.close?.();
  }
}

export class CarrierRoutingTrackingProvider implements TrackingProvider {
  constructor(
    private readonly providers: Map<string, TrackingProvider>,
    private readonly fallback?: TrackingProvider,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const provider = this.providers.get(input.rule.code) || this.fallback;
    if (!provider) throw trackingError('解析失败', `${input.rule.name} 没有可用的真实官网查询通道`);
    return provider.query(input);
  }

  async close() {
    const unique = new Set([...this.providers.values(), this.fallback].filter((provider): provider is TrackingProvider => Boolean(provider)));
    await Promise.all([...unique].map((provider) => provider.close?.()));
  }
}

export function mergeTrackingResults(primary: TrackingResult, secondary: TrackingResult): TrackingResult {
  const hasDischarge = (item: TrackingResult) => Boolean(item.dischargeTime || item.dischargeTimeText || item.discharged);
  const mergeDetail = (preferred: TrackingResult, fallback: TrackingResult) => {
    if (!preferred.trackingDetail && !fallback.trackingDetail) return undefined;
    if (!preferred.trackingDetail) return fallback.trackingDetail;
    if (!fallback.trackingDetail) return preferred.trackingDetail;
    return {
      ...fallback.trackingDetail,
      ...preferred.trackingDetail,
      // 以同一查询结果的完整轨迹为主；仅在主结果缺字段时补齐另一查询的字段。
      routeStops: preferred.trackingDetail.routeStops.length >= fallback.trackingDetail.routeStops.length
        ? preferred.trackingDetail.routeStops
        : fallback.trackingDetail.routeStops,
      events: preferred.trackingDetail.events.length >= fallback.trackingDetail.events.length
        ? preferred.trackingDetail.events
        : fallback.trackingDetail.events,
      currentPort: preferred.trackingDetail.currentPort || fallback.trackingDetail.currentPort || null,
      estimatedArrivalPort: preferred.trackingDetail.estimatedArrivalPort || fallback.trackingDetail.estimatedArrivalPort || null,
      estimatedArrivalTimeText: preferred.trackingDetail.estimatedArrivalTimeText || fallback.trackingDetail.estimatedArrivalTimeText || null,
      facts: preferred.trackingDetail.facts?.length ? preferred.trackingDetail.facts : fallback.trackingDetail.facts,
    };
  };
  const preferred = hasDischarge(primary) && !hasDischarge(secondary)
    ? primary
    : hasDischarge(secondary) && !hasDischarge(primary)
      ? secondary
      : [primary, secondary]
        .filter((item) => item.arrivalTime)
        .sort((a, b) => b.arrivalTime!.getTime() - a.arrivalTime!.getTime())[0] || primary;
  const fallback = preferred === primary ? secondary : primary;
  const mergeSuffix = preferred === primary ? '已合并柜号查询' : '已合并提单号查询';
  return {
    ...preferred,
    arrivalTimeText: preferred.arrivalTimeText || fallback.arrivalTimeText || null,
    arrivalKind: preferred.arrivalKind || fallback.arrivalKind,
    estimatedArrivalTimeText: preferred.estimatedArrivalTimeText || fallback.estimatedArrivalTimeText || null,
    dischargeTime: primary.dischargeTime || secondary.dischargeTime,
    dischargeTimeText: preferred.dischargeTimeText || fallback.dischargeTimeText || null,
    arrived: primary.arrived || secondary.arrived,
    discharged: primary.discharged || secondary.discharged || Boolean(primary.dischargeTime || secondary.dischargeTime || primary.dischargeTimeText || secondary.dischargeTimeText),
    routeText: preferred.routeText || fallback.routeText || null,
    trackingDetail: mergeDetail(preferred, fallback),
    rawSummary: `${preferred.rawSummary}；${mergeSuffix}`,
  };
}

async function queryMaerskAlternatives(
  baseQuery: Omit<TrackingQuery, 'queryType'>,
  initialError: unknown,
  provider: TrackingProvider,
) {
  const failures = [{ label: `去前缀提单号 ${baseQuery.queryBillNo}`, failure: classifyTrackingError(initialError) }];
  const alternatives: Array<{ label: string; query: TrackingQuery }> = [];
  if (baseQuery.originalBillNo !== baseQuery.queryBillNo) {
    alternatives.push({
      label: `完整提单号 ${baseQuery.originalBillNo}`,
      query: { ...baseQuery, queryBillNo: baseQuery.originalBillNo, queryType: 'bill' },
    });
  }
  if (baseQuery.containerNo) {
    alternatives.push({
      label: `柜号 ${baseQuery.containerNo}`,
      query: { ...baseQuery, queryType: 'container' },
    });
  }
  for (const alternative of alternatives) {
    try {
      const result = await provider.query(alternative.query);
      return {
        ...result,
        rawSummary: `${result.rawSummary}；马士基去前缀查询失败后已自动改用${alternative.label}`,
      };
    } catch (error) {
      failures.push({ label: alternative.label, failure: classifyTrackingError(error) });
    }
  }
  const lastFailure = failures.at(-1)!.failure;
  throw trackingError(
    lastFailure.category,
    `马士基多号码查询均失败：${failures.map(({ label, failure }) => `${label}（${failure.category}：${failure.reason}）`).join('；')}`,
    {
      evidencePath: lastFailure.evidencePath || failures.find(({ failure }) => failure.evidencePath)?.failure.evidencePath,
      sourceUrl: lastFailure.sourceUrl || failures.find(({ failure }) => failure.sourceUrl)?.failure.sourceUrl,
    },
  );
}

async function queryBillOrContainer(baseQuery: Omit<TrackingQuery, 'queryType'>, provider: TrackingProvider) {
  try {
    return await provider.query({ ...baseQuery, queryType: 'bill' });
  } catch (billError) {
    const billFailure = classifyTrackingError(billError);
    if (!isReferenceMissFailure(billFailure)) throw billError;
    if (!baseQuery.containerNo) {
      throw trackingError(billFailure.category, `${baseQuery.rule.name}提单查询未找到结果，且没有柜号可供备用查询`, billFailure);
    }
    try {
      const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
      return {
        ...containerResult,
        rawSummary: `${containerResult.rawSummary}；提单号未找到后已按 OR 规则改用柜号 ${baseQuery.containerNo}`,
      };
    } catch (containerError) {
      const containerFailure = classifyTrackingError(containerError);
      throw trackingError(
        containerFailure.category,
        `${baseQuery.rule.name}提单号与柜号查询均失败：提单号 ${baseQuery.queryBillNo}（${billFailure.category}：${billFailure.reason}）；柜号 ${baseQuery.containerNo}（${containerFailure.category}：${containerFailure.reason}）`,
        {
          evidencePath: containerFailure.evidencePath || billFailure.evidencePath,
          sourceUrl: containerFailure.sourceUrl || billFailure.sourceUrl,
        },
      );
    }
  }
}

export async function trackRecord(record: WorkbookRecord, provider: TrackingProvider) {
  const rule = resolveCarrierRule(record);
  const baseQuery = {
    rule,
    originalBillNo: record.billNo,
    queryBillNo: buildQueryBillNo(record.billNo, rule),
    containerNo: record.containerNo,
  };
  if (rule.queryMode === 'bill-or-container') {
    return { rule, result: await queryBillOrContainer(baseQuery, provider) };
  }
  let billResult: TrackingResult;
  try {
    billResult = await provider.query({ ...baseQuery, queryType: 'bill' });
  } catch (billError) {
    const billFailure = classifyTrackingError(billError);
    if (rule.code === 'MAERSK' && isReferenceMissFailure(billFailure)) {
      return { rule, result: await queryMaerskAlternatives(baseQuery, billError, provider) };
    }
    if (rule.queryMode !== 'bill-then-container' && rule.queryMode !== 'bill-and-container') throw billError;
    if (!isReferenceMissFailure(billFailure)) throw billError;
    if (!record.containerNo) throw trackingError('订单号验证失败', `${rule.name}提单查询失败，且没有柜号可供备用查询`);
    try {
      const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
      return {
        rule,
        result: {
          ...containerResult,
          rawSummary: `${containerResult.rawSummary}；提单号明确未找到后已自动改用柜号 ${record.containerNo} 查询`,
        },
      };
    } catch (containerError) {
      const containerFailure = classifyTrackingError(containerError);
      throw trackingError(
        containerFailure.category,
        `${rule.name}提单查询失败（${billFailure.category}：${billFailure.reason}）；柜号 ${record.containerNo} 备用查询也失败（${containerFailure.category}：${containerFailure.reason}）`,
        { evidencePath: containerFailure.evidencePath || billFailure.evidencePath, sourceUrl: containerFailure.sourceUrl || billFailure.sourceUrl },
      );
    }
  }
  if (rule.queryMode !== 'bill-and-container') return { rule, result: billResult };
  if (!record.containerNo) throw trackingError('订单号验证失败', `${rule.name}需要同时提供柜号进行交叉查询`);
  let containerResult: TrackingResult;
  try {
    containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
  } catch (containerError) {
    const failure = classifyTrackingError(containerError);
    throw trackingError(
      failure.category,
      `${rule.name}提单查询成功，但柜号 ${record.containerNo} 交叉查询失败（${failure.category}：${failure.reason}），拒绝写入未经双重核验的数据`,
      { evidencePath: failure.evidencePath, sourceUrl: failure.sourceUrl },
    );
  }
  return { rule, result: mergeTrackingResults(billResult, containerResult) };
}
