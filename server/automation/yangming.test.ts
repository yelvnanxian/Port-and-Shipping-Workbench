import assert from 'node:assert/strict';
import test from 'node:test';
import { YangmingTrackingProvider, parseYangmingTrackingResponse } from './yangming.js';

const payload = {
  successCnt: 1,
  blList: [{
    queryTrackNo: 'YMJAW239076615',
    returnTrackNo: 'W239076615',
    bkgRef: 'W239076615',
    routingInfo: { routingSchedule: [{ picQlfr: 'DESTINATION', dateTime: '2026/07/20 01:47', dateQlfr: 'Actual' }] },
    containerInfo: [{ ctnrNo: 'YMLU3562849', moveDate: '2026/07/22 00:11', lastEvent: 'Discharged' }],
  }],
};

test('阳明官方接口解析实际到港和卸船时间', () => {
  const result = parseYangmingTrackingResponse(payload, 'YMJAW239076615', 'YMLU3562849');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-07-19T17:47:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-21T16:11:00.000Z');
  assert.equal(result.arrived, true);
});

test('阳明 Provider 调用公开 CargoTracking 接口', async () => {
  let called = '';
  const provider = new YangmingTrackingProvider(async (input) => {
    called = String(input);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule: { prefix: 'YMJA', code: 'YANGMING', name: '阳明', removePrefix: false, queryMode: 'bill', url: 'https://www.yangming.com/en/esolution/cargo_tracking', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'YMJAW239076615', queryBillNo: 'YMJAW239076615', containerNo: 'YMLU3562849', queryType: 'bill',
  });
  assert.match(called, /api\/CargoTracking\/GetTracking\?paramTrackNo=YMJAW239076615/);
  assert.equal(result.dischargeTime !== null, true);
});
