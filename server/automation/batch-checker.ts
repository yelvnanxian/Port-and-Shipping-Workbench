import { resolveCarrierRule } from './carriers.js';
import type { CarrierRule, WorkbookRecord } from './types.js';

/**
 * 批量查询前的船司分流结果。
 *
 * records 保留原始 Excel 行顺序；batches 按首次出现顺序排列，
 * 这样查询可以集中复用同一船司的 Provider 会话，但写回时仍使用行号，
 * 不会改变用户在工作表中看到的顺序。
 */
export interface CarrierBatch {
  key: string;
  rule: CarrierRule | null;
  records: WorkbookRecord[];
}

export interface BatchCheckResult {
  records: WorkbookRecord[];
  batches: CarrierBatch[];
  unsupported: WorkbookRecord[];
}

function batchKey(record: WorkbookRecord, rule: CarrierRule | null) {
  if (rule) return rule.code;
  // 不支持的前缀也要单独成组，避免把不同错误订单混成一个船司。
  return `UNKNOWN:${record.billNo.trim().slice(0, 8).toUpperCase() || record.rowNumber}`;
}

/**
 * 检查并按船司分流一批工作表记录。
 *
 * 该函数只做规划，不执行网络请求，也不删除重复行。重复行必须保留，
 * 后续由查询协调器决定是否复用已取得的结果。
 */
export function checkAndPlanCarrierBatches(records: WorkbookRecord[]): BatchCheckResult {
  const batches: CarrierBatch[] = [];
  const byKey = new Map<string, CarrierBatch>();
  const unsupported: WorkbookRecord[] = [];

  for (const record of records) {
    let rule: CarrierRule | null = null;
    try {
      rule = resolveCarrierRule(record);
    } catch {
      unsupported.push(record);
    }
    const key = batchKey(record, rule);
    let batch = byKey.get(key);
    if (!batch) {
      batch = { key, rule, records: [] };
      byKey.set(key, batch);
      batches.push(batch);
    }
    batch.records.push(record);
  }

  return { records: [...records], batches, unsupported };
}
