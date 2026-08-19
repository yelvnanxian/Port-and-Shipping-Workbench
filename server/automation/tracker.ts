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
    if (rule.queryMode !== 'bill-then-container') throw billError;
    if (!record.containerNo) throw trackingError('订单号验证失败', `${rule.name}提单查询失败，且没有柜号可供备用查询`);
    try {
      const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
      const billFailure = classifyTrackingError(billError);
      return {
        rule,
        result: {
          ...containerResult,
          rawSummary: `${containerResult.rawSummary}；提单查询失败后已自动改用柜号查询（${billFailure.category}：${billFailure.reason}）`,
        },
      };
    } catch (containerError) {
      const billFailure = classifyTrackingError(billError);
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
