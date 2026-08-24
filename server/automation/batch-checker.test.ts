import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAndPlanCarrierBatches } from './batch-checker.js';
import type { WorkbookRecord } from './types.js';

function record(rowNumber: number, billNo: string, carrierHint = ''): WorkbookRecord {
  return {
    rowNumber,
    carrierHint,
    billNo,
    containerNo: '',
    arrivalTime: null,
    dischargeTime: null,
    vesselState: '',
    manualMark: '',
    lastUpdated: null,
    note: '',
    progress: '待查询',
  };
}

test('批量检查器按船司分组并保留首次出现顺序', () => {
  const records = [
    record(2, 'ZIMU0000001'),
    record(3, 'OOLU0000002'),
    record(4, 'ZIMU0000003'),
    record(5, 'ONEY0000004'),
    record(6, 'OOLU0000005'),
  ];
  const plan = checkAndPlanCarrierBatches(records);
  assert.deepEqual(plan.batches.map((batch) => batch.key), ['ZIM', 'OOCL', 'ONE']);
  assert.deepEqual(plan.batches[0].records.map((item) => item.rowNumber), [2, 4]);
  assert.deepEqual(plan.batches[1].records.map((item) => item.rowNumber), [3, 6]);
  assert.deepEqual(plan.batches[2].records.map((item) => item.rowNumber), [5]);
  assert.deepEqual(plan.records.map((item) => item.rowNumber), [2, 3, 4, 5, 6]);
});

test('批量检查器把不支持的前缀独立分组并保留原记录', () => {
  const records = [record(2, 'XXXX0000001'), record(3, 'HDUJ0000002'), record(4, 'XXXX0000003')];
  const plan = checkAndPlanCarrierBatches(records);
  assert.equal(plan.unsupported.length, 2);
  assert.deepEqual(plan.batches.map((batch) => batch.key), ['UNKNOWN:XXXX0000', 'HEDE']);
  assert.deepEqual(plan.batches[0].records.map((item) => item.rowNumber), [2, 4]);
});
