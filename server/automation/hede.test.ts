import assert from 'node:assert/strict';
import test from 'node:test';
import { HedeTrackingProvider, parseHedeTrackingHtml } from './hede.js';
import { resolveCarrierRule } from './carriers.js';

const fixture = `
<table><tbody><tr class="read-tr">
<td>HDUJGLA26BZ04040</td><td>SEKU6633329</td><td>G. CROWN</td><td>2606E</td>
<td>2026-07-15 06:00</td><td>2026-07-29 15:54</td><td>2026-07-11 19:54</td>
<td>2026-07-12 03:53</td><td>2026-07-14 17:05</td><td>2026-07-30 01:09</td>
<td></td><td></td><td>查看</td>
</tr></tbody></table>`;

test('合德官方时间线提取预抵和卸船时间', () => {
  const result = parseHedeTrackingHtml(fixture, 'HDUJGLA26BZ04040', 'SEKU6633329');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-07-29T07:54:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-29T17:09:00.000Z');
  assert.equal(result.arrived, true);
  assert.match(result.rawSummary, /G\. CROWN/);
});

test('合德 Provider 发送表单并保留官方结果', async () => {
  let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    request = init;
    return new Response(fixture, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const rule = resolveCarrierRule({ billNo: 'HDUJGLA26BZ04040', carrierHint: '合德' });
  const result = await new HedeTrackingProvider(fetcher).query({
    rule,
    originalBillNo: 'HDUJGLA26BZ04040',
    queryBillNo: 'HDUJGLA26BZ04040',
    containerNo: 'SEKU6633329',
    queryType: 'bill',
  });
  assert.equal(request?.method, 'POST');
  assert.match(String(request?.body), /billno=HDUJGLA26BZ04040/);
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-29T17:09:00.000Z');
});
