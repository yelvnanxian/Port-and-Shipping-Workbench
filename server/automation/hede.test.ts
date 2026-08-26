import assert from 'node:assert/strict';
import test from 'node:test';
import { HedeTrackingProvider, parseHedeTrackingHtml } from './hede.js';
import { resolveCarrierRule } from './carriers.js';

const fixture = `
<table><tbody><tr class="read-tr">
<td>HDUJGLA26BZ04040</td><td>SEKU6633329</td><td>G. CROWN</td><td>2606E</td>
<td>2026-07-15 06:00</td><td>2026-07-29 15:54</td><td>2026-07-11 19:54</td>
<td>2026-07-12 03:53</td><td>2026-07-14 17:05</td><td>2026-07-30 01:09</td>
<td></td><td></td><td onclick="openInfo(&#39;DETAIL-ID&#39;,&#39;VOYAGE-ID&#39;,&#39;&#39;)">查看</td>
</tr></tbody></table>`;

const detailFixture = `
<table><tbody>
<tr class="input-tr"><td>订单号 </td><td><input value="HD2026071354686" /></td><td>起运港</td><td><input value="NANSHA" /><input value="CNNSA" /></td><td>订舱时间</td><td><input value="2026-07-06 17:40" /></td></tr>
<tr class="input-tr"><td>提单号 </td><td><input value="HDUJGLA26BZ04040" /></td><td>装货港</td><td><input value="NANSHA" /><input value="CNNSA" /></td><td>订舱确认时间</td><td><input value="2026-07-06 17:45" /></td></tr>
<tr class="input-tr"><td>营运人 </td><td><input value="HDW" /></td><td>卸货港</td><td><input value="LOS ANGELES,CA" /><input value="USLAX" /></td><td>提单确认时间</td><td><input value="2026-07-13 12:09" /></td></tr>
<tr class="input-tr"><td>放货时间 </td><td><input value="2026-07-30 11:00" /></td><td>目的港</td><td><input value="LOS ANGELES,CA" /><input value="USLAX" /></td></tr>
</tbody></table>
<table><thead><tr><th>航次信息</th></tr></thead><tbody><tr class="read-tr"><td>干线</td><td>G. CROWN</td><td>合耀</td><td>2606E</td><td>2026-07-15 06:00</td><td>2026-07-29 15:54</td><td>HDS3</td></tr></tbody></table>
<table><thead><tr><th>箱信息</th></tr></thead><tbody><tr class="read-tr"><td>SEKU6633329</td><td>DIS</td><td>2026-07-30 01:09</td><td>HC</td><td>40</td><td>C1372227</td><td>F</td><td>19050.0000</td></tr></tbody></table>`;

const dynamicFixture = `
<table><thead><tr><th>箱动态</th></tr></thead><tbody>
<tr class="read-tr"><td>DIS</td><td>箱子卸船</td><td>2026-07-30T01:09</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>LOS ANGELES,CA</td><td>WBCT</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>
<tr class="read-tr"><td>LOB</td><td>箱子装船</td><td>2026-07-14T17:05</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>NANSHA</td><td>南沙一期堆场</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>
<tr class="read-tr"><td>RBS</td><td>重箱进场</td><td>2026-07-12T03:53</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>NANSHA</td><td>南沙一期堆场</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>
<tr class="read-tr"><td>RBC</td><td>空箱进场</td><td>2026-06-18T12:10</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>LOS ANGELES,CA</td><td>WBCT</td><td>E</td><td>ADAMASTOS</td><td>2609E</td></tr>
</tbody></table>`;

test('合德官方时间线提取预抵和卸船时间', () => {
  const result = parseHedeTrackingHtml(fixture, 'HDUJGLA26BZ04040', 'SEKU6633329', detailFixture, dynamicFixture);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-07-29 15:54（官网未标注时区）');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-07-30 01:09（官网未标注时区）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
  assert.equal(result.routeText, 'NANSHA (CNNSA) → LOS ANGELES,CA (USLAX)');
  assert.equal(result.trackingDetail?.events.some((event) => event.vesselName === 'ADAMASTOS'), false);
  assert.equal(result.trackingDetail?.facts?.find((fact) => fact.label === '航线名称')?.value, 'HDS3');
  assert.match(result.rawPageText || '', /完整箱动态/);
  assert.match(result.rawSummary, /G\. CROWN/);
});

test('合德 Provider 发送表单并保留官方结果', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('getVBilldynamic')) return new Response(fixture);
    if (url.includes('openInfo')) return new Response(detailFixture);
    if (url.includes('getCntrDynamic')) return new Response(dynamicFixture);
    return new Response('', { status: 404 });
  };
  const rule = resolveCarrierRule({ billNo: 'HDUJGLA26BZ04040', carrierHint: '合德' });
  const result = await new HedeTrackingProvider(fetcher).query({
    rule,
    originalBillNo: 'HDUJGLA26BZ04040',
    queryBillNo: 'HDUJGLA26BZ04040',
    containerNo: 'SEKU6633329',
    queryType: 'bill',
  });
  assert.equal(requests[0].init?.method, 'POST');
  assert.match(String(requests[0].init?.body), /billno=HDUJGLA26BZ04040/);
  assert.match(requests[1].url, /openInfo/);
  assert.match(requests[2].url, /getCntrDynamic/);
  assert.equal(result.dischargeTimeText, '2026-07-30 01:09（官网未标注时区）');
});

test('合德提单无结果后的柜号查询只验证柜号并抓取完整详情', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('getVBilldynamic')) return new Response(fixture);
    if (url.includes('openInfo')) return new Response(detailFixture);
    return new Response(dynamicFixture);
  };
  const rule = resolveCarrierRule({ billNo: 'HDUJGLA26BZ04040', carrierHint: '合德' });
  const result = await new HedeTrackingProvider(fetcher).query({
    rule,
    originalBillNo: 'HDUJGLA26BZ04040',
    queryBillNo: 'HDUJGLA26BZ04040',
    containerNo: 'SEKU6633329',
    queryType: 'container',
  });
  assert.equal(result.trackingDetail?.queryType, 'container');
  assert.equal(result.trackingDetail?.queryValue, 'SEKU6633329');
});

test('合德中转港卸船事件只作为中转节点，不覆盖最终卸货港', () => {
  const transshipmentDynamic = dynamicFixture.replace(
    '<tr class="read-tr"><td>DIS</td><td>箱子卸船</td><td>2026-07-30T01:09</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>LOS ANGELES,CA</td><td>WBCT</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>',
    '<tr class="read-tr"><td>DIS</td><td>箱子卸船</td><td>2026-07-20T01:09</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>BUSAN,KR</td><td>BNCT</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>'
      + '<tr class="read-tr"><td>DIS</td><td>箱子卸船</td><td>2026-07-30T01:09</td><td>SEKU6633329</td><td>HC</td><td>40</td><td></td><td>LOS ANGELES,CA</td><td>WBCT</td><td>F</td><td>G. CROWN</td><td>2606E</td></tr>',
  );
  const result = parseHedeTrackingHtml(fixture, 'HDUJGLA26BZ04040', 'SEKU6633329', detailFixture, transshipmentDynamic);
  assert.equal(result.trackingDetail?.routeStops.find((stop) => stop.name === 'BUSAN,KR')?.role, 'transshipment');
  assert.equal(result.dischargeTimeText, '2026-07-30 01:09（官网未标注时区）');
});
