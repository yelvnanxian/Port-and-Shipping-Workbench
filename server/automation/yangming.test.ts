import assert from 'node:assert/strict';
import test from 'node:test';
import { YangmingTrackingProvider, parseYangmingTrackingResponse, parseYangmingTrackingResponses } from './yangming.js';

const summaryPayload = {
  successCnt: 1,
  blList: [{
    queryTrackNo: 'YMJAW239076615',
    returnTrackNo: 'W239076615',
    bkgRef: 'W239076615',
    basicInfo: {
      receipt: 'LIANYUNGANG',
      loading: 'SHANGHAI',
      discharge: 'LOS ANGELES',
      delivery: 'LOS ANGELES',
      vesselName: 'YM UNIFORM',
      vesselComn: '249E',
      serviceTerm: 'CY/CY',
    },
    routingInfo: {
      routingSchedule: [{
        picQlfr: 'DESTINATION',
        placeName: 'LOS ANGELES',
        dateTime: '2026/07/20 01:47',
        dateQlfr: 'Actual',
      }],
    },
    additionalInfo: [{
      rowList: [{
        statusTitleWording: 'Customs Status',
        statusValue: 'Released',
        tableData: [{ tableRowList: [{ dateTime: '2026/07/19 09:00', codeActivity: 'ACE accepted' }] }],
      }],
    }],
    containerInfo: [{
      trackPositionOut: 'BL_CT',
      ctnrNo: 'YMLU3562849',
      cnSize: '20',
      cnType: 'DC-Dry cargo container',
      sealNo: 'YMAV827296',
      moveDate: '2026/08/20 20:00',
      lastEvent: 'Full to Consignee',
      vgm: 22494,
      vgmUnit: 'KGS',
    }],
  }],
};

const detailPayload = {
  successCnt: 1,
  containerList: [{
    queryTrackNo: 'YMLU3562849',
    returnTrackNo: 'YMLU3562849',
    cnSize: '20',
    cnTypeDesc: 'Dry cargo container',
    dcsaStatusInfo: [
      { moveDate: '2026/08/20 20:00', eventDesc: 'Gate out of Laden Equipment by Truck at Port terminal', atFacility: 'LOS ANGELES - WEST BASIN CONTAINER TERMINAL (WBCT)', toFacility: 'LOS ANGELES', tsMode: 'TRUCK', eventClassifie: 'Actual' },
      { moveDate: '2026/07/22 00:11', eventDesc: 'Discharge of Laden Equipment from Vessel at Port terminal', atFacility: 'LOS ANGELES - WEST BASIN CONTAINER TERMINAL (WBCT)', toFacility: '', tsMode: 'VESSEL', eventClassifie: 'Actual' },
      { moveDate: '2026/07/20 03:06', eventDesc: 'Arrival by Vessel at Port terminal', atFacility: 'LOS ANGELES - WEST BASIN CONTAINER TERMINAL (WBCT)', toFacility: '', tsMode: 'VESSEL', eventClassifie: 'Actual' },
      { moveDate: '2026/07/05 10:30', eventDesc: 'Load of Laden Equipment onto Vessel at Port terminal', atFacility: 'SHANGHAI - SIPG SHANGDONG CONTAINER TERMINAL (YANGSHAN PHASE 4)', toFacility: 'LOS ANGELES', tsMode: 'VESSEL<BR />YM UNIFORM<BR />(249E)', eventClassifie: 'Actual' },
      { moveDate: '2026/07/05 10:00', eventDesc: 'Departure by Vessel at Port terminal', atFacility: 'SHANGHAI - SIPG SHANGDONG CONTAINER TERMINAL (YANGSHAN PHASE 4)', toFacility: 'LOS ANGELES', tsMode: 'VESSEL<BR />YM UNIFORM<BR />(249E)', eventClassifie: 'Actual' },
      { moveDate: '2026/07/04 05:00', eventDesc: 'Arrival by Barge at Port terminal', atFacility: 'SHANGHAI - SIPG SHANGDONG CONTAINER TERMINAL (YANGSHAN PHASE 4)', toFacility: '', tsMode: 'BARGE', eventClassifie: 'Actual' },
      { moveDate: '2026/06/22 09:27', eventDesc: 'Departure by Barge at Port terminal', atFacility: 'LIANYUNGANG - LIANYUNGANG NEW ORIENTAL INTERNATIONAL CONTAINER TERMINAL', toFacility: 'SHANGHAI', tsMode: 'BARGE', eventClassifie: 'Actual' },
      { moveDate: '2026/06/17 17:30', eventDesc: 'Gate in of Laden Equipment by Truck at Port terminal', atFacility: 'LIANYUNGANG - LIANYUNGANG NEW ORIENTAL INTERNATIONAL CONTAINER TERMINAL', toFacility: '', tsMode: 'TRUCK', eventClassifie: 'Actual' },
      { moveDate: '2026/06/16 21:16', eventDesc: 'Gate out of Empty Equipment by Truck at Depot', atFacility: 'LIANYUNGANG - SINOTRANS LUQIAOFDRTAO', toFacility: '', tsMode: 'TRUCK', eventClassifie: 'Actual' },
    ],
  }],
};

const rule = {
  prefix: 'YMJA',
  code: 'YANGMING',
  name: '阳明',
  removePrefix: false,
  queryMode: 'bill' as const,
  url: 'https://www.yangming.com/en/esolution/cargo_tracking',
  integration: 'ready' as const,
  integrationMessage: '',
};

test('阳明摘要兼容解析实际到港和卸船时间', () => {
  const payload = structuredClone(summaryPayload);
  payload.blList[0].containerInfo[0].moveDate = '2026/07/22 00:11';
  payload.blList[0].containerInfo[0].lastEvent = 'Discharged';
  const result = parseYangmingTrackingResponse(payload, 'YMJAW239076615', 'YMLU3562849');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-07-19T17:47:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-21T16:11:00.000Z');
  assert.equal(result.arrived, true);
});

test('阳明完整详情区分空重箱、复原线路并提取事实', () => {
  const result = parseYangmingTrackingResponses(summaryPayload, detailPayload, 'YMJAW239076615', 'YMLU3562849', {
    queryType: 'bill',
    queryValue: 'YMJAW239076615',
  });
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026/07/20 01:47（官网当地时间）');
  assert.equal(result.dischargeTimeText, '2026/07/22 00:11（官网当地时间）');
  assert.equal(result.trackingDetail?.events.length, 9);
  assert.equal(result.trackingDetail?.events[0].cargoState, 'empty');
  assert.equal(result.trackingDetail?.events[1].cargoState, 'laden');
  assert.equal(result.trackingDetail?.events[7].eventType, 'discharge');
  assert.equal(result.trackingDetail?.events[7].cargoState, 'laden');
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => stop.name), [
    'LIANYUNGANG - SINOTRANS LUQIAOFDRTAO',
    'LIANYUNGANG - LIANYUNGANG NEW ORIENTAL INTERNATIONAL CONTAINER TERMINAL',
    'SHANGHAI - SIPG SHANGDONG CONTAINER TERMINAL (YANGSHAN PHASE 4)',
    'LOS ANGELES - WEST BASIN CONTAINER TERMINAL (WBCT)',
  ]);
  const facts = new Map((result.trackingDetail?.facts || []).map((fact) => [fact.label, fact.value]));
  assert.equal(facts.get('柜号'), 'YMLU3562849');
  assert.equal(facts.get('船舶/航次'), 'YM UNIFORM / 249E');
  assert.equal(facts.get('Customs Status'), 'Released');
  assert.match(result.rawPageText || '', /dcsaStatusInfo/);
});

test('阳明完整详情只有预计到港时不应标记为已到港', () => {
  const estimatedSummary = structuredClone(summaryPayload);
  estimatedSummary.blList[0].routingInfo.routingSchedule[0].dateQlfr = 'Estimated';
  const loadedOnlyDetail = structuredClone(detailPayload);
  loadedOnlyDetail.containerList[0].dcsaStatusInfo = [
    detailPayload.containerList[0].dcsaStatusInfo.find((event) => /Load of Laden Equipment onto Vessel/i.test(event.eventDesc))!,
  ];

  const result = parseYangmingTrackingResponses(estimatedSummary, loadedOnlyDetail, 'YMJAW239076615', 'YMLU3562849', {
    queryType: 'bill',
    queryValue: 'YMJAW239076615',
  });

  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026/07/20 01:47（官网当地时间）');
  assert.equal(result.arrived, false);
  assert.equal(result.discharged, false);
});

test('阳明 Provider 用内部参考号二次调用公开柜号详情接口', async () => {
  const calls: string[] = [];
  const provider = new YangmingTrackingProvider(async (input) => {
    const called = String(input);
    calls.push(called);
    const responsePayload = called.includes('paramTrackPosition=SEARCH') ? summaryPayload : detailPayload;
    return new Response(JSON.stringify(responsePayload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule,
    originalBillNo: 'YMJAW239076615',
    queryBillNo: 'YMJAW239076615',
    containerNo: 'YMLU3562849',
    queryType: 'bill',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /paramTrackNo=YMJAW239076615/);
  assert.match(calls[1], /paramTrackNo=YMLU3562849/);
  assert.match(calls[1], /paramTrackPosition=BL_CT/);
  assert.match(calls[1], /paramRefNo=W239076615/);
  assert.equal(result.trackingDetail?.events.length, 9);
});

test('阳明支持柜号直接查询完整轨迹', async () => {
  const provider = new YangmingTrackingProvider(async () => new Response(JSON.stringify(detailPayload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const result = await provider.query({
    rule,
    originalBillNo: 'YMJAW239076615',
    queryBillNo: 'YMJAW239076615',
    containerNo: 'YMLU3562849',
    queryType: 'container',
  });
  assert.equal(result.trackingDetail?.queryType, 'container');
  assert.equal(result.trackingDetail?.events.length, 9);
  assert.equal(result.discharged, true);
});

test('阳明摘要最新事件为提货配送时确认已卸船但不伪造卸船时间', () => {
  const result = parseYangmingTrackingResponse(summaryPayload, 'YMJAW239076615', 'YMLU3562849');
  assert.equal(result.discharged, true);
  assert.equal(result.dischargeTime, null);
  assert.match(result.rawSummary, /确认已卸船但官网当前摘要未保留精确卸船时间/);
});
