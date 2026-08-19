import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTrackingError } from './errors.js';
import { parseMaerskTrackingText } from './maersk.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'MAEU', code: 'MAERSK', name: '马士基', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'limited', integrationMessage: '' },
  originalBillNo: 'MAEU271552824',
  queryBillNo: '271552824',
  containerNo: 'CICU6040856',
  queryType: 'bill',
};

const livePageText = [
  'Skip to main content',
  'Bill of Lading number\tFrom\tTo',
  '271552824\tSHANGHAI\tMIAMI',
  'CICU6040856 | 20 Dry Standard',
  'Arrived at SOUTH FLORIDA CONTAINER TERMINAL',
  '05 Aug 2026 10:22',
  'Note: All times are given in local time, unless otherwise stated.',
  'CARTAGENA',
  'CARTAGENA - TERMINAL DE CONTENEDORES',
  'Vessel arrival (GJERTRUD MAERSK / 626E)',
  '29 Jul 2026 05:41',
  'Discharge (GJERTRUD MAERSK / 626E)',
  '29 Jul 2026 14:01',
  'MIAMI',
  'SOUTH FLORIDA CONTAINER TERM N775',
  'Vessel arrival (AS PALINA / 631N)',
  '05 Aug 2026 10:22',
  'Discharge (AS PALINA / 631N)',
  '05 Aug 2026 20:09',
  'Gate out for delivery',
  '12 Aug 2026 14:07',
  'Empty container return',
  '12 Aug 2026 14:07',
].join('\n');

test('马士基专用解析器只读取目的港事件并保留当地时间', () => {
  const result = parseMaerskTrackingText(livePageText, query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '05 Aug 2026 10:22（官网当地时间）');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '05 Aug 2026 20:09（官网当地时间）');
  assert.equal(result.arrived, true);
  assert.match(result.rawSummary, /目的港=MIAMI/);
  assert.doesNotMatch(result.rawSummary, /29 Jul 2026/);
});

test('马士基结果必须同时核验输入柜号', () => {
  let captured: unknown;
  try {
    parseMaerskTrackingText(livePageText, { ...query, containerNo: 'MSKU0000000' });
  } catch (error) {
    captured = error;
  }
  const failure = classifyTrackingError(captured);
  assert.equal(failure.category, '订单号验证失败');
  assert.match(failure.reason, /MSKU0000000/);
});

test('马士基未到港页面只把明确的预计抵达写成 ETA', () => {
  const result = parseMaerskTrackingText([
    'Bill of Lading number\tFrom\tTo',
    '271552824\tSHANGHAI\tMIAMI',
    'CICU6040856 | 20 Dry Standard',
    'MIAMI',
    'Estimated vessel arrival',
    '25 Aug 2026 09:30',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.arrivalTimeText, '25 Aug 2026 09:30（官网当地时间）');
  assert.equal(result.dischargeTimeText, null);
});
