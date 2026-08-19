import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZimTrackingText } from './zim.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'ZIMU', code: 'ZIM', name: '以星', removePrefix: false, queryMode: 'bill-and-container', url: 'https://www.zimchina.com/tools/track-a-shipment', integration: 'blocked', integrationMessage: '' },
  originalBillNo: 'ZIMUXIA8569326',
  queryBillNo: 'ZIMUXIA8569326',
  containerNo: 'JXLU6447207',
  queryType: 'bill',
};

test('以星解析 Current ETA 和柜号轨迹，保留地图页面数据', () => {
  const result = parseZimTrackingText([
    'B/L Number: ZIMUXIA8569326',
    'Container JXLU6447207',
    'Original ETA 14-Aug-2026',
    'Current ETA 24-Aug-2026',
    'Port of Discharge NEW YORK (NY), U.S.A.',
    'Arrival 24-Aug-2026',
    'Routing Details',
    'Container JXLU6447207',
    'Last Activity Carrier Release 03-Aug-2026',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '24 Aug 2026（官网当地时间）');
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTimeText, null);
});

test('以星实际卸船优先于预计到港', () => {
  const result = parseZimTrackingText([
    'B/L Number: ZIMUXIA8569326',
    'Container JXLU6447207',
    'Current ETA 24-Aug-2026',
    'Discharged from vessel 20-Aug-2026 08:30',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.dischargeTimeText, '20 Aug 2026 08:30（官网当地时间）');
  assert.equal(result.arrived, true);
});
