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

test('赫伯罗特结果列表将 Arrival in 识别为实际移动事件', () => {
  const result = parseHapagTrackingText([
    'Bill of Lading No. HLCUSHA2607BBGH4',
    'Container No. HAMU 1828139',
    'Status Arrival in',
    'Date 2026-08-19',
    'Place of Activity DETROIT, MI',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-08-19（官网未标注时区）');
  assert.equal(result.arrived, true);
  assert.equal(result.trackingDetail?.events[0].actual, true);
});

test('赫伯罗特 Details 轨迹解析实际到港和卸船', () => {
  const result = parseHapagTrackingText([
    'Bill of Lading No. HLCUSHA2607BBGH4',
    'Container No. HAMU1828139',
    'Port of Loading SHANGHAI, CN',
    'Port of Discharge DETROIT, MI',
    'Actual arrival at destination 2026-08-19 09:30',
    'DETROIT, MI',
    'Discharged from vessel 2026-08-19 15:20',
    'DETROIT, MI',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-08-19 09:30（官网未标注时区）');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-08-19 15:20（官网未标注时区）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
  assert.equal(result.routeText, 'SHANGHAI, CN → DETROIT, MI');
  assert.equal(result.trackingDetail?.events.length, 2);
});

test('赫伯罗特英文月份日期也能解析', () => {
  const result = parseHapagTrackingText([
    'Bill of Lading No. HLCUSHA2607BBGH4',
    'Container No. HAMU1828139',
    'Status Arrival in',
    'Date 19 Aug 2026',
    'Place of Activity DETROIT, MI',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '19 Aug 2026（官网未标注时区）');
});

test('赫伯罗特使用带空格显示的完整柜号并解析 DD-MMM-YYYY 事件', () => {
  const containerQuery: TrackingQuery = { ...query, queryType: 'container' };
  const result = parseHapagTrackingText([
    'Tracking by Container',
    'Container No.',
    'HAMU 1828139',
    'Container Information',
    'Type',
    '45GP',
    'Status',
    'Discharged from vessel',
    'Date',
    '18-AUG-2026',
    '02:35 PM',
    'Place of Activity',
    'HAMBURG, DE',
  ].join('\n'), containerQuery);

  assert.equal(result.discharged, true);
  assert.equal(result.dischargeTimeText, '18-AUG-2026 02:35 PM（官网未标注时区）');
  assert.equal(result.trackingDetail?.queryType, 'container');
  assert.equal(result.trackingDetail?.queryValue, 'HAMU1828139');
  assert.equal(result.routeText, 'HAMBURG, DE');
});

test('赫伯罗特真实 Last Movement 摘要和事件表解析目的地实际到达', () => {
  const containerQuery: TrackingQuery = { ...query, queryType: 'container' };
  const result = parseHapagTrackingText([
    'Tracking by Container',
    'Container No.',
    'HAMU 1828139',
    'Container Information',
    'Type 45GP',
    'Last Movement',
    'The container arrived in DETROIT, MI at 2026-08-21.',
    'Status',
    'Place of Activity',
    'Date',
    'Time',
    'Transport',
    'Voyage No.',
    'Gate out empty',
    'SHANGHAI',
    '2026-07-10',
    '17:46',
    'Truck',
    'Arrival in',
    'SHANGHAI',
    '2026-07-16',
    '14:15',
    'Truck',
    'Arrival in',
    'DETROIT, MI',
    '2026-08-21',
    '09:25',
    'Rail',
  ].join('\n'), containerQuery);

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-21 09:25（官网未标注时区）');
  assert.equal(result.arrived, true);
  assert.match(result.routeText || '', /SHANGHAI/);
  assert.match(result.routeText || '', /DETROIT, MI/);
  assert.ok((result.trackingDetail?.events.length || 0) >= 3);
});

test('赫伯罗特中转港卸船不能覆盖最终目的港到港，也不能提前标记已卸船', () => {
  const containerQuery: TrackingQuery = { ...query, queryType: 'container' };
  const result = parseHapagTrackingText([
    'Tracking by Container',
    'Container No.',
    'HAMU 1828139',
    'Last Movement',
    'The container arrived in DETROIT, MI at 2026-08-21.',
    'Status',
    'Place of Activity',
    'Date',
    'Time',
    'Transport',
    'Vessel arrived',
    'VANCOUVER, BC',
    '2026-08-02',
    '18:30',
    'Discharged',
    'VANCOUVER, BC',
    '2026-08-03',
    '21:13',
    'Arrival in',
    'DETROIT, MI',
    '2026-08-19',
    '03:51',
    'Gate in empty',
    'DETROIT, MI',
    '2026-08-21',
    '09:13',
  ].join('\n'), containerQuery);

  assert.equal(result.arrivalTimeText, '2026-08-21（官网未标注时区）');
  assert.equal(result.discharged, false);
  assert.equal(result.dischargeTimeText, null);
  assert.match(result.routeText || '', /VANCOUVER, BC/);
  assert.match(result.routeText || '', /DETROIT, MI/);
  const vancouver = result.trackingDetail?.routeStops.find((stop) => stop.name === 'VANCOUVER, BC');
  assert.equal(vancouver?.role, 'transshipment');
});
