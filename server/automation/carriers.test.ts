import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { mergeTrackingResults, trackRecord, type TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult, WorkbookRecord } from './types.js';

test('MAEU 默认走马士基并移除前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'MAEU123456789', carrierHint: '' });
  assert.equal(rule.code, 'MAERSK');
  assert.equal(buildQueryBillNo('MAEU123456789', rule), '123456789');
});

test('MAEU 即使备注写地中海也只走马士基并移除前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'MAEU123456789', carrierHint: '地中海' });
  assert.equal(rule.code, 'MAERSK');
  assert.equal(buildQueryBillNo('MAEU123456789', rule), '123456789');
});

test('MEDU 前缀自动走 MSC 并保留完整提单号', () => {
  const rule = resolveCarrierRule({ billNo: 'MEDUPN815212', carrierHint: '地中海' });
  assert.equal(rule.code, 'MSC');
  assert.equal(buildQueryBillNo('MEDUPN815212', rule), 'MEDUPN815212');
});

test('森罗官网查询固定移除 SMLM 四位前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'SMLMNJBD6A755700', carrierHint: '森罗' });
  assert.equal(rule.code, 'SMLINE');
  assert.equal(buildQueryBillNo('SMLMNJBD6A755700', rule), 'NJBD6A755700');
});

test('示例 Excel 的 15 条提单全部能识别到对应船司规则', () => {
  const rows = [
    ['东方海外', 'OOLU2171963250', 'OOCL'],
    ['森罗', 'SMLMNJBD6A755700', 'SMLINE'],
    ['以星', 'ZIMUXIA8569326', 'ZIM'],
    ['万海', 'WHLC025G709663', 'WANHAI'],
    ['合德', 'HDUJGLA26BZ04040', 'HEDE'],
    ['海洋网联', 'ONEYSZPGD2137604', 'ONE'],
    ['美森', 'MATS7419163000', 'MATSON'],
    ['赫伯罗特', 'HLCUSHA2607BBGH4', 'HAPAG'],
    ['马士基', 'MAEU271552824', 'MAERSK'],
    ['长荣', 'EGLV146600523956', 'EVERGREEN'],
    ['COSCO', 'COSU6503130310', 'COSCO'],
    ['达飞', 'CMDUNGP4005669', 'CMA'],
    ['地中海', 'MEDUPN815212', 'MSC'],
    ['阳明', 'YMJAW239076615', 'YANGMING'],
    ['韩新海运', 'HDMUNBOZWS646200', 'HMM'],
  ] as const;
  rows.forEach(([carrierHint, billNo, code]) => assert.equal(resolveCarrierRule({ billNo, carrierHint }).code, code, billNo));
});

test('ZIM 合并时优先采用带卸船时间的查询结果', () => {
  const base: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '提单', sourceUrl: 'a' };
  const container: TrackingResult = { ...base, dischargeTime: new Date('2026-08-18T08:00:00Z'), rawSummary: '柜号', sourceUrl: 'b' };
  const merged = mergeTrackingResults(base, container);
  assert.equal(merged.dischargeTime?.toISOString(), '2026-08-18T08:00:00.000Z');
  assert.match(merged.rawSummary, /合并提单号查询/);
});

test('万海提单查询失败后自动使用柜号查询', async () => {
  const calls: TrackingQuery['queryType'][] = [];
  const containerResult: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '柜号查询成功', sourceUrl: 'https://cn.wanhai.com' };
  const provider: TrackingProvider = {
    async query(input) {
      calls.push(input.queryType);
      if (input.queryType === 'bill') throw new Error('万海提单查询无记录');
      assert.equal(input.containerNo, 'WHSU8284656');
      return containerResult;
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.deepEqual(calls, ['bill', 'container']);
  assert.match(tracked.result.rawSummary, /提单查询失败后已自动改用柜号查询/);
});

test('万海提单和柜号均失败时保留两次失败原因', async () => {
  const provider: TrackingProvider = {
    async query(input) {
      throw new Error(input.queryType === 'bill' ? '提单无记录' : '柜号查询被风控');
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', lastUpdated: null, note: '', progress: '' };
  await assert.rejects(() => trackRecord(record, provider), /提单查询失败.*柜号 WHSU8284656 备用查询也失败/);
});
