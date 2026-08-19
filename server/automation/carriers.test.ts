import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { mergeTrackingResults } from './tracker.js';
import type { TrackingResult } from './types.js';

test('MAEU 默认走马士基并移除前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'MAEU123456789', carrierHint: '' });
  assert.equal(rule.code, 'MAERSK');
  assert.equal(buildQueryBillNo('MAEU123456789', rule), '123456789');
});

test('MAEU 船司标注地中海时走 MSC 并保留前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'MAEU123456789', carrierHint: '地中海' });
  assert.equal(rule.code, 'MSC');
  assert.equal(buildQueryBillNo('MAEU123456789', rule), 'MAEU123456789');
});

test('ZIM 合并时优先采用带卸船时间的查询结果', () => {
  const base: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '提单', sourceUrl: 'a' };
  const container: TrackingResult = { ...base, dischargeTime: new Date('2026-08-18T08:00:00Z'), rawSummary: '柜号', sourceUrl: 'b' };
  const merged = mergeTrackingResults(base, container);
  assert.equal(merged.dischargeTime?.toISOString(), '2026-08-18T08:00:00.000Z');
  assert.match(merged.rawSummary, /合并提单号查询/);
});
