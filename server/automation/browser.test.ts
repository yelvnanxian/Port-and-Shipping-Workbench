import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRenderedTrackingText } from './browser.js';
import { classifyTrackingError } from './errors.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'MAEU', code: 'MAERSK', name: '马士基', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'limited', integrationMessage: '' },
  originalBillNo: 'MAEU271552824',
  queryBillNo: '271552824',
  containerNo: 'CICU6040856',
  queryType: 'bill',
};

test('浏览器结果必须包含对应订单号才允许写入', () => {
  assert.throws(() => parseRenderedTrackingText('ETA\n20 Aug 2026 09:00', query), /未显示对应的提单号或柜号/);
});

test('浏览器结果解析明确的 ETA 和实际卸船时间', () => {
  const result = parseRenderedTrackingText('MAEU271552824\nETA\n20 Aug 2026 09:00\nContainer discharged\n22 Aug 2026 08:30', query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-20T01:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-22T00:30:00.000Z');
  assert.equal(result.arrived, true);
});

test('预计卸船不能被浏览器解析器写成实际卸船', () => {
  const result = parseRenderedTrackingText('MAEU271552824\nETA\n20 Aug 2026 09:00\nEstimated discharge\n22 Aug 2026 08:30', query);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrived, false);
});

test('浏览器安全检查仍归类为验证码或风控', () => {
  let captured: unknown;
  try {
    parseRenderedTrackingText('MAEU271552824\nSecurity Check\nVerify you are human', query);
  } catch (error) {
    captured = error;
  }
  const failure = classifyTrackingError(captured);
  assert.equal(failure.category, '验证码或风控');
});

test('浏览器网关错误归类为官网接口异常', () => {
  let captured: unknown;
  try {
    parseRenderedTrackingText('502 Bad Gateway\nMicrosoft-Azure-Application-Gateway/v2', query);
  } catch (error) {
    captured = error;
  }
  assert.equal(classifyTrackingError(captured).category, '官网接口异常');
});

test('中远多港口轨迹取最后一个目的港到港时间', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310',
    '中转港 Ningbo',
    '实际到港',
    '2026-07-03 09:23:25',
    '目的港 Houston',
    '实际到港',
    '2026-08-06 11:07:44',
  ].join('\n'), coscoQuery);
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-06T03:07:44.000Z');
});
