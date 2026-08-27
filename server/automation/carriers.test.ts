import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryBillNo, CARRIER_RULES, resolveCarrierRule } from './carriers.js';
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

test('马士基完整提单号遇到风控时不会继续查询柜号', async () => {
  const calls: string[] = [];
  const provider: TrackingProvider = {
    async query(input) {
      const value = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
      calls.push(value);
      if (value === '271552824') throw new Error('去前缀提单无结果');
      throw new Error('Cloudflare 验证页面');
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '马士基', billNo: 'MAEU271552824', containerNo: 'CICU6040856', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  await assert.rejects(() => trackRecord(record, provider), /Cloudflare 验证页面/);
  assert.deepEqual(calls, ['271552824', 'MAEU271552824']);
});

test('森罗官网查询固定移除 SMLM 四位前缀', () => {
  const rule = resolveCarrierRule({ billNo: 'SMLMNJBD6A755700', carrierHint: '森罗' });
  assert.equal(rule.code, 'SMLINE');
  assert.equal(rule.queryMode, 'bill-then-container');
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

test('内置规则统一使用提单优先的规范查询模式', () => {
  assert.ok(CARRIER_RULES.every((rule) => rule.queryMode === 'bill' || rule.queryMode === 'bill-then-container'));
  assert.equal(CARRIER_RULES.find((rule) => rule.code === 'MAERSK')?.queryMode, 'bill');
  assert.ok(CARRIER_RULES.filter((rule) => rule.code !== 'MAERSK').every((rule) => rule.queryMode === 'bill-then-container'));
});

test('ZIM 合并时优先采用带卸船时间的查询结果', () => {
  const base: TrackingResult = { arrivalTime: new Date('2026-08-18T01:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '提单', sourceUrl: 'a' };
  const container: TrackingResult = { ...base, dischargeTime: new Date('2026-08-18T08:00:00Z'), rawSummary: '柜号', sourceUrl: 'b' };
  const merged = mergeTrackingResults(base, container);
  assert.equal(merged.dischargeTime?.toISOString(), '2026-08-18T08:00:00.000Z');
  assert.match(merged.rawSummary, /合并提单号查询/);
});

test('万海提单明确无结果后自动使用柜号查询', async () => {
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
  assert.match(tracked.result.rawSummary, /明确无结果后已自动改用柜号/);
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

test('万海提单成功时不再执行不必要的柜号查询', async () => {
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '万海查询成功', sourceUrl: 'https://cn.wanhai.com' };
  const calls: TrackingQuery['queryType'][] = [];
  const provider: TrackingProvider = { async query(input) { calls.push(input.queryType); return result; } };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '万海', billNo: 'WHLC025G709663', containerNo: 'WHSU8284656', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.equal(tracked.result.rawSummary, '万海查询成功');
  assert.deepEqual(calls, ['bill']);
});

test('森罗提单明确无结果后采用柜号结果', async () => {
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
  assert.match(tracked.result.rawSummary, /明确无结果后已自动改用柜号/);
});

test('森罗提单成功时直接采用该结果', async () => {
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ETA', arrived: false, dischargeTime: null, rawSummary: '森罗查询成功', sourceUrl: 'https://esvc.smlines.com' };
  const calls: TrackingQuery['queryType'][] = [];
  const provider: TrackingProvider = { async query(input) { calls.push(input.queryType); return result; } };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '森罗', billNo: 'SMLMNJBD6A755700', containerNo: 'SMCU1312616', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.equal(tracked.result.rawSummary, '森罗查询成功');
  assert.deepEqual(calls, ['bill']);
});

test('所有非特殊船司都配置了提单未找到后的柜号回退', () => {
  const exempt = new Set(['MAERSK']);
  const records = [
    ['MEDUPN815212', 'MSC'], ['EGLV146600523956', 'EVERGREEN'], ['OOLU2171963250', 'OOCL'],
    ['MATS7419163000', 'MATSON'], ['YMJAW239076615', 'YANGMING'], ['CMDUNGP4005669', 'CMA'],
    ['COSU6503130310', 'COSCO'], ['HLCUSHA2607BBGH4', 'HAPAG'], ['HDUJGLA26BZ04040', 'HEDE'],
    ['HDMUNBOZWS646200', 'HMM'],
  ] as const;
  records.forEach(([billNo, code]) => {
    assert.equal(exempt.has(code), false);
    assert.equal(resolveCarrierRule({ billNo, carrierHint: '' }).queryMode, 'bill-then-container', code);
  });
});

test('验证码、网络和非无结果错误不能触发柜号回退', async () => {
  for (const reason of ['Cloudflare 验证页面', '官网查询 timeout', '页面未显示查询号码，拒绝写入无法核验的数据', '官网返回柜号与输入不一致']) {
    const calls: TrackingQuery['queryType'][] = [];
    const provider: TrackingProvider = {
      async query(input) {
        calls.push(input.queryType);
        throw new Error(reason);
      },
    };
    const record: WorkbookRecord = { rowNumber: 2, carrierHint: '长荣', billNo: 'EGLV146600523956', containerNo: 'DFSU7042655', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
    await assert.rejects(() => trackRecord(record, provider));
    assert.deepEqual(calls, ['bill']);
  }
});

test('以星提单明确未找到时允许单独采用柜号结果', async () => {
  const calls: TrackingQuery['queryType'][] = [];
  const result: TrackingResult = { arrivalTime: new Date('2026-08-20T09:00:00Z'), arrivalKind: 'ATA', arrived: true, dischargeTime: null, rawSummary: '以星柜号查询成功', sourceUrl: 'https://www.zimchina.com' };
  const provider: TrackingProvider = {
    async query(input) {
      calls.push(input.queryType);
      if (input.queryType === 'bill') throw new Error('提单未找到');
      return result;
    },
  };
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '以星', billNo: 'ZIMUXIA8569326', containerNo: 'ZCSU7648508', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const tracked = await trackRecord(record, provider);
  assert.deepEqual(calls, ['bill', 'container']);
  assert.match(tracked.result.rawSummary, /明确无结果后已自动改用柜号/);
});

test('以星提单查询成功时不再重复查询柜号', async () => {
  const calls: TrackingQuery['queryType'][] = [];
  const result: TrackingResult = {
    arrivalTime: new Date('2026-08-20T09:00:00Z'),
    arrivalKind: 'ATA',
    arrived: true,
    dischargeTime: null,
    rawSummary: '以星提单查询成功',
    sourceUrl: 'https://www.zimchina.com',
  };
  const provider: TrackingProvider = {
    async query(input) {
      calls.push(input.queryType);
      return result;
    },
  };
  const record: WorkbookRecord = {
    rowNumber: 2,
    carrierHint: '以星',
    billNo: 'ZIMUXIA8569326',
    containerNo: 'ZCSU7648508',
    arrivalTime: null,
    dischargeTime: null,
    vesselState: '',
    manualMark: '',
    lastUpdated: null,
    note: '',
    progress: '',
  };
  const tracked = await trackRecord(record, provider);
  assert.deepEqual(calls, ['bill']);
  assert.equal(tracked.result.rawSummary, '以星提单查询成功');
  assert.equal(resolveCarrierRule(record).queryMode, 'bill-then-container');
});
