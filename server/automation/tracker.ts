import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import type { TrackingQuery, TrackingResult, WorkbookRecord } from './types.js';

export interface TrackingProvider {
  query(input: TrackingQuery): Promise<TrackingResult>;
}

function hash(value: string) {
  return [...value].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 7);
}

export class DemoTrackingProvider implements TrackingProvider {
  async query(input: TrackingQuery): Promise<TrackingResult> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const seed = hash(`${input.originalBillNo}:${input.queryType}:${input.containerNo}`);
    const now = new Date();
    const arrived = seed % 4 !== 0;
    const arrivalTime = new Date(now.getTime() + (arrived ? -(seed % 72) : (seed % 60 + 4)) * 60 * 60 * 1000);
    const hasDischarged = arrived && seed % 3 === 0;
    return {
      arrivalTime,
      arrivalKind: arrived ? 'ATA' : 'ETA',
      arrived,
      dischargeTime: hasDischarged ? new Date(arrivalTime.getTime() + (4 + seed % 18) * 60 * 60 * 1000) : null,
      rawSummary: `演示结果；查询方式=${input.queryType}; 查询值=${input.queryType === 'bill' ? input.queryBillNo : input.containerNo}`,
      sourceUrl: input.rule.url,
    };
  }
}

export class PendingLiveTrackingProvider implements TrackingProvider {
  async query(input: TrackingQuery): Promise<TrackingResult> {
    throw new Error(`${input.rule.name} 官网解析器待使用真实测试单号联调`);
  }
}

export class CarrierRoutingTrackingProvider implements TrackingProvider {
  constructor(
    private readonly providers: Map<string, TrackingProvider>,
    private readonly fallback: TrackingProvider = new PendingLiveTrackingProvider(),
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    return (this.providers.get(input.rule.code) || this.fallback).query(input);
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
  const billResult = await provider.query({ ...baseQuery, queryType: 'bill' });
  if (rule.queryMode !== 'bill-and-container') return { rule, result: billResult };
  if (!record.containerNo) throw new Error('以星提单需要同时提供柜号');
  const containerResult = await provider.query({ ...baseQuery, queryType: 'container' });
  return { rule, result: mergeTrackingResults(billResult, containerResult) };
}
