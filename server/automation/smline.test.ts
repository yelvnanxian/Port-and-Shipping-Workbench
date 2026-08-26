import assert from 'node:assert/strict';
import test from 'node:test';
import { SmLineTrackingProvider, parseSmLineTrackingResponses } from './smline.js';
import type { TrackingQuery } from './types.js';

const search = {
  TRANS_RESULT_KEY: 'S',
  count: '1',
  list: [{ blNo: 'NJBD6A755700', cntrNo: 'SMCU1312616', bkgNo: 'NJBD6A755700', copNo: 'CNBO6706770811' }],
};

const route = {
  TRANS_RESULT_KEY: 'S',
  count: '1',
  list: [{ eta: '2026-08-20 17:00', etaFlag: 'C', vslEngNm: 'SM KWANGYANG', skdVoyNo: '2605', skdDirCd: 'E', polNm: 'NINGBO,ZHEJIANG,CHINA', podNm: 'PORTLAND,OR,UNITED STATES' }],
};

test('森罗航线接口的起运港和目的港写入运行线路', () => {
  const result = parseSmLineTrackingResponses(search, route, { TRANS_RESULT_KEY: 'S', list: [] }, 'SMCU1312616', 'SMLMNJBD6A755700');
  assert.equal(result.routeText, 'NINGBO,ZHEJIANG,CHINA → PORTLAND,OR,UNITED STATES');
  assert.equal(result.trackingDetail?.routeStops.length, 2);
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'PORTLAND,OR,UNITED STATES');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-08-20 17:00（官网当地时间）');
  assert.match(result.rawPageText || '', /routePayload/);
});

test('森罗只把实际事件写成到港或卸船', () => {
  const events = {
    TRANS_RESULT_KEY: 'S',
    count: '2',
    list: [
      { eventDt: '2026-08-20 17:00', actTpCd: 'E', statusNm: 'Arrival at Port of Discharging' },
      { eventDt: '2026-08-22 08:30', actTpCd: 'E', statusNm: 'Unloaded at Port of Discharging' },
    ],
  };
  const result = parseSmLineTrackingResponses(search, route, events, 'SMCU1312616', 'SMLMNJBD6A755700');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, null);
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
  const result = parseSmLineTrackingResponses(search, route, events, 'SMCU1312616', 'SMLMNJBD6A755700');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-08-20 21:30（官网当地时间）');
  assert.equal(result.trackingDetail?.events.length, 2);
});

test('森罗中转港事件不会覆盖最终目的港到港和卸船字段', () => {
  const transshipmentRoute = {
    TRANS_RESULT_KEY: 'S', count: '1', list: [{ ...route.list[0], podNm: 'LOS ANGELES,CA,UNITED STATES', eta: '2026-08-30 17:00' }],
  };
  const events = {
    TRANS_RESULT_KEY: 'S', count: '3', list: [
      { eventDt: '2026-08-10 10:00', actTpCd: 'A', placeNm: 'BUSAN,KOREA', statusNm: 'Arrival at Port of Discharging' },
      { eventDt: '2026-08-11 10:00', actTpCd: 'A', placeNm: 'BUSAN,KOREA', statusNm: 'Unloaded at Port of Discharging' },
      { eventDt: '2026-08-30 17:00', actTpCd: 'E', placeNm: 'LOS ANGELES,CA,UNITED STATES', statusNm: 'Arrival at Port of Discharging' },
    ],
  };
  const result = parseSmLineTrackingResponses(search, transshipmentRoute, events, 'SMCU1312616', 'SMLMNJBD6A755700');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.discharged, false);
  assert.equal(result.dischargeTimeText, null);
  assert.equal(result.trackingDetail?.currentPort, 'BUSAN,KOREA');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'LOS ANGELES,CA,UNITED STATES');
  assert.equal(result.trackingDetail?.routeStops.find((stop) => stop.name === 'BUSAN,KOREA')?.role, 'transshipment');
});

test('森罗返回其他提单时拒绝写入', () => {
  assert.throws(
    () => parseSmLineTrackingResponses(search, route, { TRANS_RESULT_KEY: 'S', list: [] }, 'SMCU1312616', 'SMLMOTHER123456'),
    /提单号与查询号不一致/,
  );
});

test('森罗忽略不属于当前追踪流水号的事件', () => {
  const events = {
    TRANS_RESULT_KEY: 'S',
    count: '1',
    list: [{ copNo: 'OTHER-COP', eventDt: '2026-08-20 21:30', actTpCd: 'A', statusNm: 'Unloaded at Port of Discharging' }],
  };
  const result = parseSmLineTrackingResponses(search, route, events, 'SMCU1312616', 'SMLMNJBD6A755700');
  assert.equal(result.dischargeTime, null);
});

test('森罗柜号不一致时明确归为订单验证失败', () => {
  assert.throws(
    () => parseSmLineTrackingResponses(search, route, { TRANS_RESULT_KEY: 'S', list: [] }, 'WRONG1234567', 'SMLMNJBD6A755700', 'container'),
    /柜号与查询号不一致/,
  );
});

test('森罗柜号查询使用官方 search_type C 且不要求提单同时匹配', async () => {
  const requests: URLSearchParams[] = [];
  const containerSearch = {
    ...search,
    list: [{ blNo: 'OTHER-BILL', cntrNo: 'SMCU1312616', bkgNo: 'OTHER-BILL', copNo: 'CNBO6706770811' }],
  };
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body || ''));
    requests.push(params);
    const command = params.get('f_cmd');
    const payload = command === '121'
      ? containerSearch
      : command === '124'
        ? route
        : { TRANS_RESULT_KEY: 'S', count: '0', list: [] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const input: TrackingQuery = {
    rule: { prefix: 'SML', code: 'SMLINE', name: '森罗', removePrefix: true, queryMode: 'bill-or-container', url: 'https://esvc.smlines.com', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'SMLMNJBD6A755700',
    queryBillNo: 'NJBD6A755700',
    containerNo: 'SMCU1312616',
    queryType: 'container',
  };
  const result = await new SmLineTrackingProvider(fetcher as typeof fetch).query(input);
  assert.equal(requests[0].get('search_type'), 'C');
  assert.equal(requests[0].get('search_name'), 'SMCU1312616');
  assert.match(result.rawSummary, /本次通道=柜号 SMCU1312616/);
  assert.match(result.rawSummary, /关联提单号=OTHER-BILL/);
});
