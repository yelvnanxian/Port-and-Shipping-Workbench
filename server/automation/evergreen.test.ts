import assert from 'node:assert/strict';
import test from 'node:test';
import { EvergreenTrackingProvider, parseEvergreenTrackingHtml } from './evergreen.js';
import { resolveCarrierRule } from './carriers.js';
import type { TrackingQuery } from './types.js';

const billHtml = `
  <table>
    <tr><th>提单号码</th><td>EGLV 146600523956</td><th>提单列示之船名、航次</th><td>EVER FAST 1272-030E</td></tr>
    <tr><th>装货港</th><td>XIAMEN, CHINA (CN)</td><th>毛重</th><td>20,405.550 KGS</td></tr>
    <tr><th>卸货港</th><td>NEW YORK, NY (US)</td><th>件数</th><td>788 CARTONS</td></tr>
  </table>
  <a href="javascript:frmCntrMoveDetail('DFSU7042655');">DFSU7042655</a>
  <input type="hidden" name="bl_no" value="146600523956">
  <input type="hidden" name="onboard_date" value="20260620">
  <input type="hidden" name="pol" value="CNXSM">
  <input type="hidden" name="pod" value="USNYC">
  <input type="hidden" name="podctry" value="US">
`;

const movementHtml = `
  <table>
    <tr><td>JUN-20-2026</td><td>Loaded on vessel</td><td>XIAMEN, CHINA</td><td>EVER FAST 1272-030E</td></tr>
    <tr><td>AUG-11-2026</td><td>Discharged &#x28;FCL&#x29;</td><td>NEW YORK, NY</td><td>EVER FAST 1272-030E</td></tr>
    <tr><td>AUG-18-2026</td><td>Empty container returned</td><td>NEW YORK, NY</td><td></td></tr>
  </table>
`;

const etaBillHtml = billHtml.replace(
  '</table>',
  '<tr><td colspan="4">预计抵达目的地时间 : <font color="#9E0B0E">AUG-27-2026</font></td></tr></table>',
).replace('NEW YORK, NY (US)', 'LOS ANGELES, CA (US)');
const etaMovementHtml = `
  <table>
    <tr><td>AUG-04-2026</td><td>Loaded (FCL) on vessel</td><td>SHANGHAI, CN</td><td>EVER FAST 1272-030E</td></tr>
  </table>
`;

test('长荣从提单摘要读取预计到港时间并标记 ETA', () => {
  const result = parseEvergreenTrackingHtml(
    etaBillHtml,
    etaMovementHtml,
    '146600523956',
    'DFSU7042655',
  );
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-08-27（官网仅提供日期）');
  assert.equal(result.arrived, false);
  assert.equal(result.discharged, false);
  assert.equal(result.trackingDetail?.events.at(-1)?.actual, false);
  assert.equal(result.trackingDetail?.events.at(-1)?.timeText, '2026-08-27（官网仅提供日期）');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'LOS ANGELES, CA (US)');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-08-27（官网仅提供日期）');
  assert.match(result.routeText || '', /LOS ANGELES, CA/);
  assert.match(result.rawSummary, /预计到港=2026-08-27（官网仅提供日期）/);
});

test('长荣保留官网仅提供日期的卸船精度', () => {
  const result = parseEvergreenTrackingHtml(billHtml, movementHtml, '146600523956', 'DFSU7042655');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-08-11（官网仅提供日期）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => stop.name), ['XIAMEN, CHINA', 'NEW YORK, NY']);
  assert.equal(result.trackingDetail?.events.length, 3);
  assert.equal(result.trackingDetail?.events.find((event) => event.eventType === 'discharge')?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.at(-1)?.cargoState, 'empty');
  assert.equal(result.trackingDetail?.facts?.find((fact) => fact.label === '船舶/航次')?.value, 'EVER FAST 1272-030E');
  assert.match(result.rawPageText || '', /movementHtml/);
  assert.equal(result.routeText, 'XIAMEN, CHINA → NEW YORK, NY');
  assert.equal(result.trackingDetail?.currentPort, 'NEW YORK, NY');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'NEW YORK, NY (US)');
  assert.match(result.rawSummary, /未提供具体时刻/);
});

test('长荣已有实际卸船但没有单独到港事件时仍保留 ETA', () => {
  const result = parseEvergreenTrackingHtml(
    etaBillHtml,
    movementHtml.replaceAll('NEW YORK, NY', 'LOS ANGELES, CA'),
    '146600523956',
    'DFSU7042655',
  );
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026-08-27（官网仅提供日期）');
  assert.equal(result.dischargeTimeText, '2026-08-11（官网仅提供日期）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
});

test('长荣柜号不一致时拒绝写入其他货柜结果', () => {
  assert.throws(
    () => parseEvergreenTrackingHtml(billHtml, movementHtml, '146600523956', 'WRONG1234567'),
    /柜号与输入不一致/,
  );
});

test('长荣 Provider 支持按柜号反查提单后读取完整货柜动态', async () => {
  const requestBodies: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body || ''));
    const index = requestBodies.length;
    if (index === 1) return new Response('<html>home</html>', { status: 200, headers: { 'set-cookie': 'JSESSIONID=test; Path=/' } });
    if (index === 2) return new Response(`<html>DFSU7042655<input type="hidden" name="bl_no" value="146600523956"></html>`, { status: 200 });
    if (index === 3) return new Response(billHtml, { status: 200 });
    return new Response(movementHtml, { status: 200 });
  }) as typeof fetch;
  const record = { billNo: 'EGLV000000000000', carrierHint: '长荣' };
  const query: TrackingQuery = {
    rule: resolveCarrierRule(record),
    originalBillNo: record.billNo,
    queryBillNo: '000000000000',
    containerNo: 'DFSU7042655',
    queryType: 'container',
  };
  const result = await new EvergreenTrackingProvider(fetcher).query(query);
  assert.match(requestBodies[1], /TYPE=CNTR/);
  assert.match(requestBodies[1], /NO=DFSU7042655/);
  assert.match(requestBodies[2], /TYPE=BL/);
  assert.match(requestBodies[2], /NO=146600523956/);
  assert.equal(result.trackingDetail?.queryType, 'container');
  assert.equal(result.trackingDetail?.queryValue, 'DFSU7042655');
  assert.equal(result.dischargeTimeText, '2026-08-11（官网仅提供日期）');
});
