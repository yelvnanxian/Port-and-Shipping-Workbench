import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMscTrackingPayload } from './msc.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'MEDU', code: 'MSC', name: '地中海', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.msccargo.cn/en/track-a-shipment?agencyPath=hkg', integration: 'limited', integrationMessage: '' },
  originalBillNo: 'MEDUPN815212',
  queryBillNo: 'MEDUPN815212',
  containerNo: 'MSMU4939122',
  queryType: 'bill',
};

const payload = {
  IsSuccess: true,
  Data: {
    TrackingType: 'Bill Of Lading',
    TrackingResultsLabel: 'Tracking results provided by MSC on 22.08.2026 at 17:21 Central Europe Standard Time',
    BillOfLadings: [{
      BillOfLadingNumber: 'MEDUPN815212',
      NumberOfContainers: 1,
      Delivered: true,
      GeneralTrackingInfo: {
        ShippedFrom: 'PHNOM PENH, KH', PortOfLoad: 'PHNOM PENH, KH',
        Transshipments: ['VUNG TAU, VN'], PortOfDischarge: 'NEW YORK, US', ShippedTo: 'NEW YORK, US',
        PriceCalculationDate: '05/06/2026', FinalPodEtaDate: '',
      },
      ContainersInfo: [{
        ContainerNumber: 'MSMU4939122', ContainerType: "40' HIGH CUBE", LatestMove: 'NEW YORK, US', Delivered: true, PodEtaDate: '',
        Events: [
          { Order: 9, Date: '04/08/2026', Location: 'NEW YORK, US', Description: 'Empty received at CY', Detail: ['EMPTY'], EquipmentHandling: { Name: 'MARSH STREET DEPOT' }, Vessel: {} },
          { Order: 6, Date: '29/07/2026', Location: 'NEW YORK, US', Description: 'Import Discharged from Vessel', Detail: ['MSC CHIARA X', '624W'], EquipmentHandling: { Name: 'PORT NEWARK CONTAINER TERMINAL' }, Vessel: { IMO: '9198587', Built: '2000', FlagName: 'LIBERIA' } },
          { Order: 4, Date: '26/06/2026', Location: 'VUNG TAU, VN', Description: 'Full Transshipment Loaded', Detail: ['MSC CHIARA X', 'GU624W'], EquipmentHandling: { Name: 'SP-SSA INTERNATIONAL TERMINAL' }, Vessel: { IMO: '9198587' } },
          { Order: 3, Date: '15/06/2026', Location: 'VUNG TAU, VN', Description: 'Full Transshipment Discharged', Detail: ['NEWPORT CYPRESS 96', '053E'], EquipmentHandling: { Name: 'SP-SSA INTERNATIONAL TERMINAL' }, Vessel: {} },
          { Order: 2, Date: '12/06/2026', Location: 'PHNOM PENH, KH', Description: 'Export Loaded on Vessel', Detail: ['NEWPORT CYPRESS 96', '053E'], EquipmentHandling: { Name: 'PHNOM PENH TERMINAL' }, Vessel: {} },
          { Order: 0, Date: '04/06/2026', Location: 'PHNOM PENH, KH', Description: 'Empty to Shipper', Detail: ['EMPTY'], EquipmentHandling: { Name: 'BOK SENG PPSEZ DRY PORT CO., LTD' }, Vessel: {} },
        ],
      }],
    }],
  },
};

test('地中海官方 JSON 解析完整多港线路并保留官网日期原文', () => {
  const result = parseMscTrackingPayload(payload, query, 'BILL OF LADING: MEDUPN815212');
  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-07-29（官网仅提供日期，未标注具体时刻）');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.dischargeTimeText, '2026-07-29（官网仅提供日期，未标注具体时刻）');
  assert.equal(result.arrived, true);
  assert.equal(result.discharged, true);
  assert.equal(result.routeText, 'PHNOM PENH, KH → VUNG TAU, VN → NEW YORK, US');
  assert.equal(result.trackingDetail?.events.filter((event) => event.eventType === 'discharge').length, 2);
  assert.equal(result.trackingDetail?.events.find((event) => event.label === 'Full Transshipment Discharged')?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.at(-1)?.cargoState, 'empty');
  assert.equal(result.trackingDetail?.facts?.some((fact) => /IMO 9198587/.test(fact.value)), true);
  assert.match(result.rawPageText || '', /TrackingInfo 官方响应/);
});

test('地中海提单结果未包含输入柜号时拒绝误用其他柜', () => {
  assert.throws(
    () => parseMscTrackingPayload(payload, { ...query, containerNo: 'MSMU0000000' }),
    /未包含输入柜号 MSMU0000000/,
  );
});

test('地中海柜号查询可从官方结果反查关联提单', () => {
  const result = parseMscTrackingPayload(payload, { ...query, queryType: 'container' });
  assert.equal(result.trackingDetail?.queryType, 'container');
  assert.equal(result.trackingDetail?.queryValue, 'MSMU4939122');
  assert.match(result.rawSummary, /关联提单=MEDUPN815212/);
});

test('地中海柜号已周转到其他提单时拒绝覆盖旧航次', () => {
  const reusedPayload = structuredClone(payload);
  reusedPayload.Data.BillOfLadings[0].BillOfLadingNumber = 'MEDUAAL55562';
  assert.throws(
    () => parseMscTrackingPayload(reusedPayload, { ...query, queryType: 'container' }),
    /当前关联提单 MEDUAAL55562.*本条记录 MEDUPN815212 不一致/,
  );
});
