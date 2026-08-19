import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHapagTrackingText } from './hapag.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'HLCU', code: 'HAPAG', name: '赫伯罗特', removePrefix: true, queryMode: 'bill', url: 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-booking-solution.html', integration: 'blocked', integrationMessage: '' },
  originalBillNo: 'HLCUSHA2607BBGH4',
  queryBillNo: 'SHA2607BBGH4',
  containerNo: 'HAMU1828139',
  queryType: 'bill',
};

test('赫伯罗特结果列表解析 Arrival in 和柜号', () => {
  const result = parseHapagTrackingText([
    'Bill of Lading No. HLCUSHA2607BBGH4',
    'Container No. HAMU 1828139',
    'Status Arrival in',
    'Date 2026-08-19',
    'Place of Activity DETROIT, MI',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-08-19（官网当地时间）');
  assert.equal(result.arrived, false);
});

test('赫伯罗特 Details 轨迹解析实际到港和卸船', () => {
  const result = parseHapagTrackingText([
    'Bill of Lading No. HLCUSHA2607BBGH4',
    'Container No. HAMU1828139',
    'Actual arrival at destination 2026-08-19 09:30',
    'Discharged from vessel 2026-08-19 15:20',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-19T01:30:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-19T07:20:00.000Z');
  assert.equal(result.arrived, true);
});
