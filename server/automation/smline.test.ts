import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSmLineTrackingResponses } from './smline.js';

const search = {
  TRANS_RESULT_KEY: 'S',
  count: '1',
  list: [{ blNo: 'NJBD6A755700', cntrNo: 'SMCU1312616', bkgNo: 'NJBD6A755700', copNo: 'CNBO6706770811' }],
};

const route = {
  TRANS_RESULT_KEY: 'S',
  count: '1',
  list: [{ eta: '2026-08-20 17:00', etaFlag: 'C', vslEngNm: 'SM KWANGYANG', skdVoyNo: '2605', skdDirCd: 'E' }],
};

test('森罗只把实际事件写成到港或卸船', () => {
  const events = {
    TRANS_RESULT_KEY: 'S',
    count: '2',
    list: [
      { eventDt: '2026-08-20 17:00', actTpCd: 'E', statusNm: 'Arrival at Port of Discharging' },
      { eventDt: '2026-08-22 08:30', actTpCd: 'E', statusNm: 'Unloaded at Port of Discharging' },
    ],
  };
  const result = parseSmLineTrackingResponses(search, route, events, 'SMCU1312616');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTime, null);
  assert.match(result.rawSummary, /预计卸船 2026-08-22 08:30/);
});

test('森罗发现实际卸船事件后标记为已卸船', () => {
  const events = {
    TRANS_RESULT_KEY: 'S',
    count: '2',
    list: [
      { eventDt: '2026-08-20 17:10', actTpCd: 'A', statusNm: 'Arrival at Port of Discharging' },
      { eventDt: '2026-08-20 21:30', actTpCd: 'A', statusNm: 'Unloaded at Port of Discharging' },
    ],
  };
  const result = parseSmLineTrackingResponses(search, route, events, 'SMCU1312616');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrived, true);
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-20T13:30:00.000Z');
});

test('森罗柜号不一致时明确归为订单验证失败', () => {
  assert.throws(
    () => parseSmLineTrackingResponses(search, route, { TRANS_RESULT_KEY: 'S', list: [] }, 'WRONG1234567'),
    /柜号与输入不一致/,
  );
});
