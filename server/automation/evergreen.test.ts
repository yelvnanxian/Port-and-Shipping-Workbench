import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvergreenTrackingHtml } from './evergreen.js';

const billHtml = `
  <td>EGLV 146600523956</td>
  <a href="javascript:frmCntrMoveDetail('DFSU7042655');">DFSU7042655</a>
`;

const movementHtml = `
  <table>
    <tr><td>JUN-20-2026</td><td>Loaded on vessel</td><td>XIAMEN, CHINA</td><td>EVER FAST 1272-030E</td></tr>
    <tr><td>AUG-11-2026</td><td>Discharged &#x28;FCL&#x29;</td><td>NEW YORK, NY</td><td>EVER FAST 1272-030E</td></tr>
    <tr><td>AUG-18-2026</td><td>Empty container returned</td><td>NEW YORK, NY</td><td></td></tr>
  </table>
`;

test('长荣保留官网仅提供日期的卸船精度', () => {
  const result = parseEvergreenTrackingHtml(billHtml, movementHtml, '146600523956', 'DFSU7042655');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-08-11（官网仅提供日期）');
  assert.equal(result.arrived, true);
  assert.match(result.rawSummary, /未提供具体时刻/);
});

test('长荣柜号不一致时拒绝写入其他货柜结果', () => {
  assert.throws(
    () => parseEvergreenTrackingHtml(billHtml, movementHtml, '146600523956', 'WRONG1234567'),
    /柜号与输入不一致/,
  );
});
