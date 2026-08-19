import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { classifyTrackingError, trackingError } from './errors.js';
import type { TrackingQuery, TrackingResult, WorkbookRecord } from './types.js';

export interface TrackingProvider {
  query(input: TrackingQuery): Promise<TrackingResult>;
  close?(): Promise<void>;
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
  if (primary.dischargeTime && !secondary.dischargeTime) return { ...primary, rawSummary: `${primary.rawSummary}；已合并柜号查询` };
  if (secondary.dischargeTime && !primary.dischargeTime) return { ...secondary, rawSummary: `${secondary.rawSummary}；已合并提单号查询` };
  const moreRecentArrival = [primary, secondary]
    .filter((item) => item.arrivalTime)
    .sort((a, b) => b.arrivalTime!.getTime() - a.arrivalTime!.getTime())[0];
  return {
    ...(moreRecentArrival || primary),
    dischargeTime: primary.dischargeTime || secondary.dischargeTime,
    arrived: primary.arrived || secondary.arrived,
    rawSummary: `${primary.rawSummary}；${secondary.rawSummary}；提单号与柜号结果已合并`,
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

export async function trackRecord(record: WorkbookRecord, provider: TrackingProvider) {
  const rule = resolveCarrierRule(record);
  const baseQuery = {
    rule,
    originalBillNo: record.billNo,
    queryBillNo: buildQueryBillNo(record.billNo, rule),
    containerNo: record.containerNo,
  };
  let billResult: TrackingResult;
  try {
    billResult = await provider.query({ ...baseQuery, queryType: 'bill' });
  } catch (billError) {
    const billFailure = classifyTrackingError(billError);
    if (rule.code === 'MAERSK' && (billFailure.category === '订单号验证失败' || billFailure.category === '解析失败')) {
      return { rule, result: await queryMaerskAlternatives(baseQuery, billError, provider) };
    }
    if (rule.queryMode !== 'bill-then-container') throw billError;
    if (!record.containerNo) throw trackingError('订单号验证失败', `${rule.name}提单查询失败，且没有柜号可供备用查询`);
    try {
      const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
      return {
        rule,
        result: {
          ...containerResult,
          rawSummary: `${containerResult.rawSummary}；提单查询失败后已自动改用柜号查询（${billFailure.category}：${billFailure.reason}）`,
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
  if (!record.containerNo) throw new Error('以星提单需要同时提供柜号');
  const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
  return { rule, result: mergeTrackingResults(billResult, containerResult) };
}
