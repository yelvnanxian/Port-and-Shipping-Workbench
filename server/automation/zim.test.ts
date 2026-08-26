import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZimTrackingText } from './zim.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'ZIMU', code: 'ZIM', name: '以星', removePrefix: false, queryMode: 'bill-and-container', url: 'https://www.zimchina.com/tools/track-a-shipment', integration: 'blocked', integrationMessage: '' },
  originalBillNo: 'ZIMUXIA8569326',
  queryBillNo: 'ZIMUXIA8569326',
  containerNo: 'JXLU6447207',
  queryType: 'bill',
};

test('以星解析 Current ETA 和柜号轨迹，保留地图页面数据', () => {
  const result = parseZimTrackingText([
    'B/L Number: ZIMUXIA8569326',
    'Container JXLU6447207',
    'Original ETA 14-Aug-2026',
    'Current ETA 24-Aug-2026',
    'Port of Discharge NEW YORK (NY), U.S.A.',
    'Port of Loading (POL) XIAMEN (FJ), CHINA, PEOPLE\'S REPUBLIC',
    'Arrival 24-Aug-2026',
    'Routing Details',
    'Container JXLU6447207',
    'Last Activity Carrier Release 03-Aug-2026',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '24 Aug 2026（官网当地时间）');
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTimeText, null);
  assert.match(result.routeText || '', /XIAMEN/);
  assert.match(result.routeText || '', /NEW YORK/);
});

test('以星实际卸船优先于预计到港', () => {
  const result = parseZimTrackingText([
    'B/L Number: ZIMUXIA8569326',
    'Container JXLU6447207',
    'Current ETA 24-Aug-2026',
    'Discharged from vessel 20-Aug-2026 08:30',
  ].join('\n'), query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.dischargeTimeText, '20 Aug 2026 08:30（官网当地时间）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
});

test('以星优先解析官网 complete-result 接口的时区、路线和完整柜动态', () => {
  const payload = {
    consgListItem: [{
      referenceNo: 'ZIMUXIA8569326',
      blRouteLeg: { vpBrl: [{
        vesselName: 'ZIM MOUNT EVEREST', voyage: '14', leg: 'E',
        portNameFrom: 'XIAMEN (FJ)', countryNameFrom: "CHINA. PEOPLE'S REPUBLIC",
        portNameTo: 'NEW YORK (NY)', countryNameTo: 'U.S.A.',
        arrivalDateDt: '2026-08-24T02:00:00.000+03:00', arrivalInd: 'ETA',
      }] },
      consDetails: {
        consPol: 'CNXIA', consPolDesc: 'XIAMEN (FJ)', consPolCountryName: "CHINA. PEOPLE'S REPUBLIC",
        consPod: 'USNYC', consPodDesc: 'NEW YORK (NY)', consPodCountryName: 'U.S.A.',
        consContainers: { consContainersItem: [{
          unitPrefix: 'JXLU', unitNo: '6447207 ', cargoType: 'HC40',
          unitActivities: { unitActivitiesItem: [
            { activityCode: 'OCLE', activityDesc: 'Empty container dispatched from inland point to Customer', activityDateTz: '2026-07-06T07:47:00+08:00', placeFromDesc: 'XIAMEN (FJ)', countryFromName: "CHINA. PEOPLE'S REPUBLIC" },
            { activityCode: 'CNT_VESSEL_DEPARTURE', activityDesc: 'Vessel departure from Port of Loading to Port of Discharge', activityDateTz: '2026-07-16T04:35:23+08:00', placeFromDesc: 'XIAMEN (FJ)', countryFromName: "CHINA. PEOPLE'S REPUBLIC" },
          ] },
        }] },
      },
      finalEta: { etaPodDate: '2026-08-24T02:00:00.000+03:00' },
      agreedEta: { etaDate: '2026-08-14T15:00:00.000+03:00' },
      consCycleStatusDesc: 'Open',
    }],
  };
  const result = parseZimTrackingText(`ZIMUXIA8569326\nJXLU6447207\n[ZIM API https://apigw.zimchina.com/digital/TrackShipment/v2/complete-result?reference=ZIMUXIA8569326]\n${JSON.stringify(payload)}\n\n[ZIM API https://cn1.hcaptcha.com/checksiteconfig]\n{"pass":true}`, query);

  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026-08-24T02:00:00.000+03:00（官网返回时区）');
  assert.equal(result.routeText, "XIAMEN (FJ), CHINA. PEOPLE'S REPUBLIC → NEW YORK (NY), U.S.A.");
  assert.equal(result.trackingDetail?.events.length, 2);
  assert.equal(result.trackingDetail?.events[0].time, '2026-07-05T23:47:00.000Z');
  assert.equal(result.trackingDetail?.facts?.find((fact) => fact.label === '船舶/航次')?.value, 'ZIM MOUNT EVEREST / 14/E');
});

test('以星中转港事件不能覆盖最终目的港到港和卸船字段', () => {
  const transshipmentQuery: TrackingQuery = {
    ...query,
    originalBillNo: 'ZIMUQIN4437762',
    queryBillNo: 'ZIMUQIN4437762',
    containerNo: 'MMPU5016990',
  };
  const payload = {
    consgListItem: [{
      referenceNo: 'ZIMUQIN4437762',
      blRouteLeg: { vpBrl: [
        { portNameFrom: 'QINGDAO', countryNameFrom: 'CHINA', portNameTo: 'SHANGHAI', countryNameTo: 'CHINA', arrivalDateDt: '2026-07-14T00:00:00+08:00', arrivalInd: 'ATA' },
        { portNameFrom: 'SHANGHAI', countryNameFrom: 'CHINA', portNameTo: 'HOUSTON', countryNameTo: 'U.S.A.', arrivalDateDt: '2026-08-27T00:00:00-05:00', arrivalInd: 'ETA' },
      ] },
      consDetails: {
        consPol: 'CNTAO', consPolDesc: 'QINGDAO', consPolCountryName: 'CHINA',
        consPod: 'USHOU', consPodDesc: 'HOUSTON', consPodCountryName: 'U.S.A.',
        consContainers: { consContainersItem: [{
          unitPrefix: 'MMPU', unitNo: '5016990',
          unitActivities: { unitActivitiesItem: [
            { activityCode: 'CNT_VESSEL_ARRIVAL', activityDesc: 'Vessel arrival to Transshipment Port', activityDateTz: '2026-07-06T10:00:00+08:00', placeFromDesc: 'SHANGHAI', countryFromName: 'CHINA' },
            { activityCode: 'DISC', activityDesc: 'Container was discharged at Transshipment Port', activityDateTz: '2026-07-14T10:00:00+08:00', placeFromDesc: 'SHANGHAI', countryFromName: 'CHINA' },
            { activityCode: 'CNT_VESSEL_DEPARTURE', activityDesc: 'Vessel departure from Transshipment Port', activityDateTz: '2026-07-24T10:00:00+08:00', placeFromDesc: 'SHANGHAI', countryFromName: 'CHINA' },
            { activityCode: 'OTHER', activityDesc: 'Carrier Release', activityDateTz: '2026-08-20T10:00:00-05:00', placeFromDesc: 'HOUSTON', countryFromName: 'U.S.A.' },
          ] },
        }] },
      },
      finalEta: { etaPodDate: '2026-08-27T00:00:00-05:00' },
    }],
  };
  const result = parseZimTrackingText(`ZIMUQIN4437762\nMMPU5016990\n[ZIM API https://apigw.zimchina.com/digital/TrackShipment/v2/complete-result?reference=ZIMUQIN4437762]\n${JSON.stringify(payload)}`, transshipmentQuery);

  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026-08-27T00:00:00-05:00（官网返回时区）');
  assert.equal(result.dischargeTimeText, null);
  assert.equal(result.arrived, false);
  assert.equal(result.discharged, false);
  assert.equal(result.trackingDetail?.currentPort, 'HOUSTON, U.S.A.');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'HOUSTON, U.S.A.');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-08-27T00:00:00-05:00（官网返回时区）');
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => [stop.name, stop.role]), [
    ['QINGDAO, CHINA', 'loading'],
    ['SHANGHAI, CHINA', 'transshipment'],
    ['HOUSTON, U.S.A.', 'discharge'],
  ]);
});
