import assert from 'node:assert/strict';
import test from 'node:test';
import { MatsonTrackingProvider, parseMatsonTrackingResponse } from './matson.js';

const payload = {
  ediBooking: [{
    ediBookingReference: 'H5KDOIFK2607071274',
    bookingNumber: '7419163',
    bookingStatus: 'APPROVED',
    vvd: 'Matson Oahu 133 E',
    arrivalDate: '17-Aug-2026 08:48 AM',
    container: [
      { containerNumber: 'MATU236280-6', latestStatus: 'AVAILABLE', location: 'SHIPPERS TRANSPORT MIDDLE ROAD, CA', statusDateTime: '18-Aug-2026 06:39 PM' },
      { containerNumber: 'MATU232991-6', latestStatus: 'OUTGATE Empty to Shanghai', location: 'SHANGHAI DONGHWA DEPOT', statusDateTime: '04-Aug-2026 12:13 PM' },
    ],
  }],
};

test('美森解析官网 bk 响应并兼容柜号连字符', () => {
  const result = parseMatsonTrackingResponse(payload, 'MATU2362806');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime?.getFullYear(), 2026);
  assert.equal(result.arrivalTime?.getMonth(), 7);
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTime, null);
});

test('美森 Provider 使用官网 bk 查询参数', async () => {
  let called = '';
  const provider = new MatsonTrackingProvider(async (input) => {
    called = String(input);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule: { prefix: 'MATS', code: 'MATSON', name: '美森', removePrefix: false, queryMode: 'bill', url: 'https://www.cargo.chinamatson.com/', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'MATS7419163000', queryBillNo: 'MATS7419163000', containerNo: 'MATU2362806', queryType: 'bill',
  });
  assert.match(called, /cargoNumber=MATS7419163000/);
  assert.match(called, /type=bk/);
  assert.equal(result.arrivalTime !== null, true);
});
