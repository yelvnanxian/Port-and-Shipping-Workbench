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
  'CICU6040856',
  '|',
  "20' Dry Standard",
  'Arrived at SOUTH FLORIDA CONTAINER TERMINAL',
  '05 Aug 2026 10:22',
  'Last updated: 6 days ago',
  'Note: All times are given in local time, unless otherwise stated.',
  'SHANGHAI',
  'YANGSHAN SGH GUANGDONG TERMINAL',
  'Gate in',
  '02 Jul 2026 15:40',
  'Load on GJERTRUD MAERSK / 626E',
  '02 Jul 2026 16:50',
  'Vessel departure (GJERTRUD MAERSK / 626E)',
  '03 Jul 2026 05:47',
  'CARTAGENA',
  'CARTAGENA - TERMINAL DE CONTENEDORES',
  'Vessel arrival (GJERTRUD MAERSK / 626E)',
  '29 Jul 2026 05:41',
  'Discharge (GJERTRUD MAERSK / 626E)',
  '29 Jul 2026 14:01',
  'Load on AS PALINA / 631N',
  '31 Jul 2026 18:30',
  'Vessel departure (AS PALINA / 631N)',
  '01 Aug 2026 07:43',
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
  assert.equal(result.discharged, true);
  assert.equal(result.trackingDetail?.currentPort, 'MIAMI');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'MIAMI');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, null);
  assert.equal(result.routeText, 'SHANGHAI → CARTAGENA → MIAMI');
  assert.equal(result.trackingDetail?.events.length, 11);
  assert.equal(result.trackingDetail?.events.filter((event) => event.eventType === 'discharge').length, 2);
  assert.equal(result.trackingDetail?.events.find((event) => event.label === '有货柜卸船')?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.at(-1)?.cargoState, 'empty');
  assert.equal(result.trackingDetail?.events.at(-2)?.transportMode, 'truck');
  assert.equal(result.trackingDetail?.facts?.find((item) => item.label === '柜型')?.value, "20' Dry Standard");
  assert.equal(result.trackingDetail?.facts?.find((item) => item.label === '船舶/航次')?.value, 'GJERTRUD MAERSK / 626E、AS PALINA / 631N');
  assert.equal(result.trackingDetail?.facts?.find((item) => item.label === '官网最后更新')?.value, '6 days ago');
  assert.match(result.rawPageText || '', /GJERTRUD MAERSK/);
  assert.doesNotMatch(result.rawPageText || '', /Plan & Book/);
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
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'MIAMI');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '25 Aug 2026 09:30（官网当地时间）');
});
