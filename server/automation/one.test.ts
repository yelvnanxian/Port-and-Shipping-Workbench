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

test('ONE 解析官方到港事件并忽略预计卸船', () => {
  const result = parseOneTrackingResponse(payload, 'SZPGD2137604', 'ONEU1925399');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-06T09:58:00.000Z');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrived, true);
});

test('ONE Provider 使用官网公开搜索接口和去前缀提单号', async () => {
  let request = '';
  const provider = new OneTrackingProvider(async (input, init) => {
    request = `${input}\n${init?.body}`;
    return new Response(JSON.stringify(payload), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule: { prefix: 'ONEY', code: 'ONE', name: '海洋网联', removePrefix: true, queryMode: 'bill', url: 'https://x', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'ONEY SZPGD2137604', queryBillNo: 'SZPGD2137604', containerNo: 'ONEU1925399', queryType: 'bill',
  });
  assert.match(request, /track-and-trace\/search/);
  assert.match(request, /SZPGD2137604/);
  assert.equal(result.arrivalTime !== null, true);
});
