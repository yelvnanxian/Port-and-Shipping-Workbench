import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCmaTrackingText } from './cma.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'CMDU', code: 'CMA', name: '达飞', removePrefix: true, queryMode: 'bill-then-container', url: 'https://www.cma-cgm.com/ebusiness/tracking', integration: 'limited', integrationMessage: '' },
  originalBillNo: 'CMDUNGP4005669',
  queryBillNo: 'NGP4005669',
  containerNo: 'TCLU1234567',
  queryType: 'bill',
};

test('达飞解析完整页面中的 ATA、实际卸船和多港路线', () => {
  const result = parseCmaTrackingText([
    'Bill of Lading CMDUNGP4005669',
    'Container TCLU1234567',
    'Port of Loading SHANGHAI, CN',
    'Port of Discharge LOS ANGELES, US',
    'Place of Delivery CHICAGO, US',
    'Vessel / Voyage CMA CGM MERMAID / 0NA2E',
    'Actual arrival at destination 20 Aug 2026 09:30',
    'LOS ANGELES, US',
    'Discharged from vessel 20 Aug 2026 15:20',
    'LOS ANGELES, US',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '20 Aug 2026 09:30');
  assert.equal(result.discharged, true);
  assert.equal(result.dischargeTimeText, '20 Aug 2026 15:20');
  assert.equal(result.routeText, 'SHANGHAI, CN → LOS ANGELES, US → CHICAGO, US');
  assert.equal(result.trackingDetail?.events.length, 2);
});

test('达飞仅提供预计到港时不伪造实际到港和卸船', () => {
  const result = parseCmaTrackingText([
    'Reference NGP4005669',
    'Container TCLU1234567',
    'Current ETA 18 Aug 2026',
    'Port of Loading SHANGHAI, CN',
    'Port of Discharge LOS ANGELES, US',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.discharged, false);
  assert.equal(result.dischargeTimeText, null);
});

test('达飞 DataDome 访问限制不能当作订单号无效', () => {
  assert.throws(
    () => parseCmaTrackingText('CMA CGM\n访问暂时受限\n请启用 JavaScript\nNGP4005669', query),
    /安全验证或访问限制/,
  );
});

test('达飞真实页面格式支持 DD-MMM-YYYY、AM/PM、POL、POD 和 FPD', () => {
  const result = parseCmaTrackingText([
    'POL',
    'NINGBO (CN)',
    'FPD',
    'SALT LAKE CITY, UT (US)',
    'Booking reference',
    'NGP4005669',
    'Container TCLU1234567',
    'ARRIVED AT POD',
    '18-AUG-2026',
    '02:35 PM',
    'LONG BEACH, CA',
    'Date',
    'Moves',
    'Location Terminal',
    'Sunday, 26-JUL-2026',
    '08:00 AM',
    "IN SHIPPER'S OWNED FULL",
    'NINGBO',
    'NINGBO MEISHAN ISLAND INTERNATIONAL',
    'Monday, 03-AUG-2026',
    '03:44 PM',
    'LOADED ON BOARD',
    'NINGBO PORT GRP BEILUN 3RD CONT TER',
  ].join('\n'), query);

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '18-AUG-2026 02:35 PM');
  assert.equal(result.arrived, true);
  assert.match(result.routeText || '', /^NINGBO/);
  assert.match(result.routeText || '', /LONG BEACH, CA/);
  assert.match(result.routeText || '', /SALT LAKE CITY, UT$/);
  assert.ok((result.trackingDetail?.events.length || 0) >= 3);
});
