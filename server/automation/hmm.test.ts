import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHmmTrackingHtml } from './hmm.js';

const liveResponse = `
  <div class="route-wrap">
    <div class="location"><div>LOS ANGELES, CA</div><div>Arrival at Destination</div><div class="text-nowrap blue">2026-08-20 17:00</div></div>
  </div>
  <input type="hidden" id="thisBl" value="NBOZWS646200" />
  <input type="hidden" id="thisCntr" value="HMMU9066040" />
  <div class="table-wrap" id="shipmentProgress"><table><tbody>
    <tr class="clsMoves"><td><div>2026-08-19</div></td><td><div>02:56</div></td><td><div>LOS ANGELES, CA</div></td><td><div>Vessel Berthing at POD</div></td><td><div>HMM RAON 0025E</div></td></tr>
    <tr class="clsMoves hidden clsPreviousMoves"><td><div>2026-08-18</div></td><td><div>22:56</div></td><td><div>LOS ANGELES, CA</div></td><td><div>Vessel Arrival at POD</div></td><td><div>HMM RAON 0025E</div></td></tr>
  </tbody></table></div>
  <section><h2>Shipment Schedule</h2><table><tbody>
    <tr><th></th><th>Origin</th><th>Loading Port</th><th>Discharging Port</th><th>Destination</th></tr>
    <tr><td>Location</td><td>NINGBO, CHINA</td><td>NINGBO, CHINA</td><td>LOS ANGELES, CA</td><td>LOS ANGELES, CA</td></tr>
    <tr><td>Terminal</td><td>BEILUN PHASE 3</td><td>BEILUN PHASE 3</td><td>APM TERMINALS</td><td>APM TERMINALS</td></tr>
    <tr><td>Vessel</td><td></td><td>[PS6] HMM RAON 0025E</td><td></td><td></td></tr>
    <tr><td>Arrival(ETB)</td><td></td><td><span class="red">2026-07-18 03:35</span></td><td><span class="red">2026-08-19 03:00</span></td><td><span class="blue">2026-08-20 17:00</span></td></tr>
    <tr><td>Departure</td><td><span class="red">2026-07-15 13:20</span></td><td><span class="red">2026-07-22 18:28</span></td><td></td><td></td></tr>
  </tbody></table></section>
  <section><h2>Container Information</h2><table><tbody>
    <tr><th>Container No.</th><th>Type / Size</th><th>Weight</th><th>Seal No.</th><th>Movement</th><th>Last Movement Date</th></tr>
    <tr><td>HMMU9066040</td><td>DC/45</td><td>9014</td><td>26H0093502</td><td>Vessel Berthing at POD</td><td>2026-08-19 03:00</td></tr>
  </tbody></table></section>
  <section><h2>Customs Status</h2><table><tbody><tr><th>Nation / Item</th><th>US / AMS</th></tr><tr><td>Status(Customs Release)</td><td>Released</td></tr></tbody></table></section>
  <section><h2>Cargo Delivery Information</h2><table><tbody><tr><td>US Custom</td><td>Cleared : 2026-08-20</td></tr><tr><td>Firms Code</td><td>W185</td></tr></tbody></table></section>
  <section><h2>Empty Container Return Location</h2><table><tbody><tr><th>Empty Container Return Location</th><th>Address</th></tr><tr><td>APM TERMINALS</td><td>2500 NAVY WAY, CA</td></tr></tbody></table></section>
`;

test('韩新解析器优先使用实际到港事件且不把靠泊当作卸船', () => {
  const result = parseHmmTrackingHtml(liveResponse, 'NBOZWS646200', 'HMMU9066040');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-18 22:56（官网当地时间）');
  assert.equal(result.dischargeTimeText, null);
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, false);
  assert.equal(result.routeText, 'NINGBO, CHINA → LOS ANGELES, CA');
  assert.equal(result.trackingDetail?.facts?.some((fact) => fact.value === 'Released'), true);
  assert.match(result.rawPageText || '', /Cargo Delivery Information/);
  assert.match(result.rawSummary, /最新事件=Vessel Berthing at POD 2026-08-19 02:56/);
});

test('韩新解析器在历史到港行缺失时使用航次计划中的实际卸货港到达', () => {
  const html = liveResponse.replace(/<tr class="clsMoves hidden clsPreviousMoves">[\s\S]*?<\/tr>/, '');
  const result = parseHmmTrackingHtml(html, 'NBOZWS646200', 'HMMU9066040');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-19 03:00（官网当地时间）');
  assert.equal(result.arrived, true);
});

test('韩新解析器只接受与输入柜号一致的结果', () => {
  assert.throws(
    () => parseHmmTrackingHtml(liveResponse, 'NBOZWS646200', 'HMMU0000000'),
    /官网返回柜号 HMMU9066040.*输入柜号 HMMU0000000 不一致/,
  );
});

test('韩新解析器读取实际卸船事件', () => {
  const html = liveResponse.replace('</tbody>', '<tr class="clsMoves"><td>2026-08-19</td><td>08:10</td><td>LOS ANGELES, CA</td><td>Container Discharged from Vessel at POD</td><td>HMM RAON 0025E</td></tr></tbody>');
  const result = parseHmmTrackingHtml(html, 'NBOZWS646200', 'HMMU9066040');
  assert.equal(result.dischargeTimeText, '2026-08-19 08:10（官网当地时间）');
  assert.equal(result.discharged, true);
});
