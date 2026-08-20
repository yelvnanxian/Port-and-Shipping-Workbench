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

test('马士基去前缀失败后自动改用完整提单号', async () => {
  const calls: string[] = [];
  const result: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '完整提单号查询成功', sourceUrl: 'https://www.maersk.com/tracking/MAEU271552824' };
  const provider: TrackingProvider = {
    async query(input) {
      calls.push(input.queryType === 'container' ? input.containerNo : input.queryBillNo);
      if (input.queryBillNo === '271552824') throw new Error('去前缀提单无结果');
      return result;
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '马士基', billNo: 'MAEU271552824', containerNo: 'CICU6040856', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.deepEqual(calls, ['271552824', 'MAEU271552824']);
  assert.match(tracked.result.rawSummary, /自动改用完整提单号 MAEU271552824/);
});

test('马士基两个提单号均失败后自动改用柜号', async () => {
  const calls: string[] = [];
  const containerResult: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '柜号查询成功', sourceUrl: 'https://www.maersk.com/tracking/CICU6040856' };
  const provider: TrackingProvider = {
    async query(input) {
      const value = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
      calls.push(value);
      if (input.queryType === 'bill') throw new Error(`${value} 无结果`);
      return containerResult;
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '马士基', billNo: 'MAEU271552824', containerNo: 'CICU6040856', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.deepEqual(calls, ['271552824', 'MAEU271552824', 'CICU6040856']);
  assert.match(tracked.result.rawSummary, /自动改用柜号 CICU6040856/);
});

test('森罗官网查询固定移除 SMLM 四位前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'SMLMNJBD6A755700', carrierHint: '森罗' });
  assert.equal(rule.code, 'SMLINE');
  assert.equal(rule.queryMode, 'bill-or-container');
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
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.ok(calls.includes('bill'));
  assert.ok(calls.includes('container'));
  assert.match(tracked.result.rawSummary, /OR 规则采用成功结果/);
});

test('万海提单和柜号均失败时保留两次失败原因', async () => {
  const provider: TrackingProvider = {
    async query(input) {
      throw new Error(input.queryType === 'bill' ? '提单无记录' : '柜号查询被风控');
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  await assert.rejects(() => trackRecord(record, provider), /提单号与柜号查询均失败/);
});

test('万海两路都成功且数据一致时精简合并备注', async () => {
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '万海查询成功', sourceUrl: 'https://cn.wanhai.com' };
  const provider: TrackingProvider = { async query() { return result; } };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.match(tracked.result.rawSummary, /OR 双查核验一致/);
});

test('森罗按 OR 规则采用任一路成功结果', async () => {
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '柜号查询成功', sourceUrl: 'https://esvc.smlines.com' };
  const provider: TrackingProvider = {
    async query(input) {
      if (input.queryType === 'bill') throw new Error('提单查询无数据');
      return result;
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '森罗', billNo: 'SMLMNJBD6A755700', containerNo: 'SMCU1312616', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.equal(tracked.result.arrivalTime?.toISOString(), '2026-08-20T09:00:00.000Z');
  assert.match(tracked.result.rawSummary, /OR 规则采用成功结果/);
});

test('森罗两路返回相同结果时精简合并备注', async () => {
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '森罗查询成功', sourceUrl: 'https://esvc.smlines.com' };
  const provider: TrackingProvider = { async query() { return result; } };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '森罗', billNo: 'SMLMNJBD6A755700', containerNo: 'SMCU1312616', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.match(tracked.result.rawSummary, /OR 双查核验一致/);
  assert.equal(tracked.result.rawSummary.match(/森罗查询成功/g)?.length, 1);
});
