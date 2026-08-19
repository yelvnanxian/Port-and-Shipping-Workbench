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
`;

test('韩新解析器优先使用实际到港事件且不把靠泊当作卸船', () => {
  const result = parseHmmTrackingHtml(liveResponse, 'NBOZWS646200', 'HMMU9066040');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-18 22:56（官网当地时间）');
  assert.equal(result.dischargeTimeText, null);
  assert.equal(result.arrived, true);
  assert.match(result.rawSummary, /最新事件=Vessel Berthing at POD 2026-08-19 02:56/);
});

test('韩新解析器在尚未到港时保留官网 ETA', () => {
  const html = liveResponse.replace(/<tr class="clsMoves hidden clsPreviousMoves">[\s\S]*?<\/tr>/, '');
  const result = parseHmmTrackingHtml(html, 'NBOZWS646200', 'HMMU9066040');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026-08-20 17:00（官网当地时间）');
  assert.equal(result.arrived, false);
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
});
