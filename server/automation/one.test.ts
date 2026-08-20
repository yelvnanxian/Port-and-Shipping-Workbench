import assert from 'node:assert/strict';
import test from 'node:test';
import { OneTrackingProvider, parseOneTrackingResponse } from './one.js';

const payload = {
  status: 200,
  code: 1,
  total: 1,
  data: [{
    bookingNo: 'SZPGD2137604',
    containerNo: 'ONEU1925399',
    cargoEvents: [
      { matrixId: 'E089', date: '2026-08-06T09:58:00.000Z', trigger: 'ACTUAL' },
      { matrixId: 'E090', date: '2026-08-06T20:30:00.000Z', trigger: 'ESTIMATED' },
    ],
  }],
};

const eventPayload = {
  status: 200,
  code: 1,
  data: [
    { matrixId: 'E061', eventName: 'Vessel Departure from Port of Loading', eventDate: '2026-07-08T09:46:00.000Z', eventLocalPortDate: '2026-07-08T17:46:00.000Z', triggerType: 'ACTUAL', copSequence: 4033, location: { locationName: 'YANTIAN, GUANGDONG' } },
    { matrixId: 'E089', eventName: 'Vessel Arrival at Port of Discharge', eventDate: '2026-08-06T09:58:00.000Z', eventLocalPortDate: '2026-08-06T02:58:00.000Z', triggerType: 'ACTUAL', copSequence: 4052, location: { locationName: 'LOS ANGELES, CA' } },
    { matrixId: 'E090', eventName: 'Unloaded from Vessel at Port of Discharging', eventDate: '2026-08-07T16:33:00.000Z', eventLocalPortDate: '2026-08-07T09:33:00.000Z', triggerType: 'ACTUAL', copSequence: 6053, location: { locationName: 'LOS ANGELES, CA' } },
    { matrixId: 'E117', eventName: 'Inbound Rail Arrival', eventDate: '2026-08-15T19:12:00.000Z', eventLocalPortDate: '2026-08-15T14:12:00.000Z', triggerType: 'ACTUAL', copSequence: 6071, location: { locationName: 'MEMPHIS, TN' } },
    { matrixId: 'E114', eventName: 'Gate In to Inbound CY', eventDate: '2026-08-19T13:51:00.000Z', eventLocalPortDate: '2026-08-19T08:51:00.000Z', triggerType: 'ACTUAL', copSequence: 6091, location: { locationName: 'NASHVILLE, TN' } },
  ],
};

test('ONE 解析官方到港事件并忽略预计卸船', () => {
  const result = parseOneTrackingResponse(payload, 'SZPGD2137604', 'ONEU1925399');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-06T09:58:00.000Z');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrived, true);
});

test('ONE 通过官网完整事件接口识别卸船并生成多式联运线路', () => {
  const result = parseOneTrackingResponse(payload, 'SZPGD2137604', 'ONEU1925399', eventPayload);
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-06 02:58（官网当地时间）');
  assert.equal(result.dischargeTimeText, '2026-08-07 09:33（官网当地时间）');
  assert.equal(result.arrived, true);
  assert.equal(result.routeText, 'YANTIAN, GUANGDONG → LOS ANGELES, CA → MEMPHIS, TN → NASHVILLE, TN');
});

test('ONE Provider 使用官网公开搜索接口和去前缀提单号', async () => {
  const requests: string[] = [];
  const provider = new OneTrackingProvider(async (input, init) => {
    requests.push(`${input}\n${init?.body || ''}`);
    return new Response(JSON.stringify(String(input).includes('cop-events') ? eventPayload : payload), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule: { prefix: 'ONEY', code: 'ONE', name: '海洋网联', removePrefix: true, queryMode: 'bill', url: 'https://x', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'ONEY SZPGD2137604', queryBillNo: 'SZPGD2137604', containerNo: 'ONEU1925399', queryType: 'bill',
  });
  assert.match(requests[0], /track-and-trace\/search/);
  assert.match(requests[0], /SZPGD2137604/);
  assert.match(requests[1], /cop-events/);
  assert.match(requests[1], /container_no=ONEU1925399/);
  assert.equal(result.arrivalTime !== null, true);
  assert.equal(result.dischargeTime !== null, true);
});
