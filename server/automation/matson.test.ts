import assert from 'node:assert/strict';
import test from 'node:test';
import { MatsonTrackingProvider, parseMatsonTrackingResponse } from './matson.js';

const payload = {
  ediBooking: [{
    ediBookingReference: 'H5KDOIFK2607071274',
    bookingNumber: '7419163',
    bookingStatus: 'APPROVED',
    vvd: 'Matson Oahu 133 E',
    arrivalDate: '17-Aug-2026 08:48 AM',
    container: [
      { containerNumber: 'MATU236280-6', latestStatus: 'AVAILABLE', location: 'SHIPPERS TRANSPORT MIDDLE ROAD, CA', statusDateTime: '18-Aug-2026 06:39 PM' },
      { containerNumber: 'MATU232991-6', latestStatus: 'OUTGATE Empty to Shanghai', location: 'SHANGHAI DONGHWA DEPOT', statusDateTime: '04-Aug-2026 12:13 PM' },
    ],
  }],
};

const detailPayload = {
  booking: [{
    shipmentNumber: '7419163',
    origin: 'SHANGHAI',
    destination: 'LONG BEACH, CA',
    portOfLoading: 'SHANGHAI',
    portOfDischarge: 'LONG BEACH, CA',
    sailedDate: '06-AUG-2026 04:54 AM',
    vessel: 'MATSON OAHU',
    voyage: '133',
    direction: 'E',
    holds: [{ holdPlacedDate: '06-Aug-2026 02:51 AM', releaseDate: '18-Aug-2026 12:45 PM' }],
    equipments: [{
      typeSize: '40GP',
      weight: '17902.000 KG',
      containerNumber: 'MATU236280-6',
      latestStatus: 'Returned From Consignee, 20-Aug-2026 11:20 AM, Los Angeles,CA',
      eventList: [
        { statusDateTime: '20-Aug-2026 11:20 AM', statusLocation: 'LONG BEACH, CA', status: 'Returned From Consignee', eventType: 'REL' },
        { statusDateTime: '19-Aug-2026 12:02 PM', statusLocation: 'SHIPPERS TRANSPORT MIDDLE ROAD, CA', status: 'Outgate to Best Way Transportation Service Inc', eventType: 'OGT' },
        { statusDateTime: '18-Aug-2026 06:39 PM', statusLocation: 'SHIPPERS TRANSPORT MIDDLE ROAD, CA', status: 'Available', eventType: 'AVP' },
        { statusDateTime: '18-Aug-2026 06:39 PM', statusLocation: 'SHIPPERS TRANSPORT MIDDLE ROAD, CA', status: 'Ingate Full by Shippers Transport Express', eventType: 'IGT' },
        { statusDateTime: '18-Aug-2026 06:23 PM', statusLocation: 'LONG BEACH, CA', status: 'Outgate to Shippers Transport Express', eventType: 'OGT' },
        { statusDateTime: '18-Aug-2026 01:05 AM', statusLocation: 'LONG BEACH, CA', status: 'Discharge From Vessel Matson Oahu. 133 E', eventType: 'DFV' },
        { statusDateTime: '06-Aug-2026 04:30 AM', statusLocation: 'SHANGHAI', status: 'Load To Vessel Matson Oahu. 133 E', eventType: 'LTV', medium: 'Ship' },
        { statusDateTime: '04-Aug-2026 01:13 PM', statusLocation: 'SHANGHAI', status: 'Ingate Full for Matson Oahu. 133 E', eventType: 'IGT' },
        { statusDateTime: '02-Aug-2026 06:56 PM', statusLocation: 'SHEKOU CSL', status: 'Empty Outgate to Shipper', eventType: 'OGT' },
      ],
    }],
  }],
};

test('美森解析官网 bk 响应并兼容柜号连字符', () => {
  const result = parseMatsonTrackingResponse(payload, 'MATU2362806');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime?.getFullYear(), 2026);
  assert.equal(result.arrivalTime?.getMonth(), 7);
  assert.equal(result.arrived, true);
  assert.equal(result.dischargeTime, null);
  assert.match(result.rawSummary, /到港后场站活动/);
});

test('美森不会用其他柜号的旧状态判断当前柜号已到港', () => {
  const result = parseMatsonTrackingResponse(payload, 'MATU2329916');
  assert.equal(result.arrived, false);
  assert.equal(result.dischargeTime, null);
});

test('美森识别 RETURNED FROM CONSIGNEE 等后续场站状态为已到港', () => {
  const result = parseMatsonTrackingResponse({
    ediBooking: [{
      arrivalDate: '17-Aug-2026 08:48 AM',
      container: [{ containerNumber: 'MATU236280-6', latestStatus: 'RETURNED FROM CONSIGNEE', location: 'LONG BEACH, CA', statusDateTime: '20-Aug-2026 11:20 AM' }],
    }],
  }, 'MATU2362806');
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, true);
  assert.equal(result.dischargeTime, null);
  assert.match(result.rawSummary, /到港后场站活动/);
});

test('美森完整详情解析全部事件、多地点线路和实际卸船', () => {
  const result = parseMatsonTrackingResponse(payload, 'MATU2362806', detailPayload, {
    expectedBillNo: 'MATS7419163000',
    queryType: 'bill',
    queryValue: 'MATS7419163000',
  });
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.discharged, true);
  assert.match(result.dischargeTimeText || '', /18-Aug-2026 01:05 AM/);
  assert.equal(result.trackingDetail?.events.length, 10);
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => stop.name), [
    'SHEKOU CSL',
    'SHANGHAI',
    'LONG BEACH, CA',
    'SHIPPERS TRANSPORT MIDDLE ROAD, CA',
    'LONG BEACH, CA',
  ]);
  assert.equal(result.trackingDetail?.events.find((event) => event.eventType === 'discharge')?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.at(-1)?.cargoState, 'empty');
  assert.equal(result.trackingDetail?.facts?.find((fact) => fact.label === '海关放行')?.value, '18-Aug-2026 12:45 PM');
  assert.match(result.rawPageText || '', /Returned From Consignee/);
});

test('美森 Provider 使用官网 bk 查询参数', async () => {
  const called: string[] = [];
  const provider = new MatsonTrackingProvider(async (input) => {
    called.push(String(input));
    return new Response(JSON.stringify(String(input).includes('detailpub') ? detailPayload : payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await provider.query({
    rule: { prefix: 'MATS', code: 'MATSON', name: '美森', removePrefix: false, queryMode: 'bill', url: 'https://www.cargo.chinamatson.com/', integration: 'ready', integrationMessage: '' },
    originalBillNo: 'MATS7419163000', queryBillNo: 'MATS7419163000', containerNo: 'MATU2362806', queryType: 'bill',
  });
  assert.match(called[0], /cargoNumber=MATS7419163000/);
  assert.match(called[0], /type=bk/);
  assert.match(called[1], /detailpub\?bk=7419163/);
  assert.match(called[1], /cn=MATU236280-6/);
  assert.match(called[1], /webId=anonymousUser/);
  assert.equal(result.arrivalTime !== null, true);
  assert.equal(result.dischargeTime !== null, true);
  assert.equal(result.trackingDetail?.events.length, 10);
});
