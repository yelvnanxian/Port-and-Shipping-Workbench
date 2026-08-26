import assert from 'node:assert/strict';
import test from 'node:test';
import { OoclTrackingProvider, parseOoclControlTowerText, parseOoclDate, parseOoclTrackingResponse } from './oocl.js';
import { resolveCarrierRule } from './carriers.js';

test('OOCL 无时区日期按北京时间解析', () => {
  assert.equal(parseOoclDate('18 Aug 2026 14:30')?.toISOString(), '2026-08-18T06:30:00.000Z');
  assert.equal(parseOoclDate('20260818143000.000')?.toISOString(), '2026-08-18T06:30:00.000Z');
});

test('OOCL 响应优先 ATA 并识别卸船事件', () => {
  const result = parseOoclTrackingResponse({
    result: {
      responseCode: 'SVC_OK_001',
      searchResultRecord: {
        billOfLadingNumber: 'OOLU2171963250',
        containers: [{
          containerNumber: 'OOCU7496887',
          latestEvent: { event: 'Container discharged from vessel', time: '18 Aug 2026 18:20', location: 'Shanghai' },
          routing: {
            lastPOD: 'Shanghai',
            lastPODTime: '18 Aug 2026 12:00',
            lastPODTimeIndicator: '(ACTUAL)',
          },
        }],
      },
    },
  }, 'OOCU7496887');

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-18T04:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-18T10:20:00.000Z');
  assert.equal(result.arrived, true);
});

test('OOCL 官方错误响应不会生成假时间', () => {
  assert.throws(
    () => parseOoclTrackingResponse({ result: { responseCode: 'SVC_ERR_001', exceptionCode: 'UPSTREAM_ERROR' } }),
    /官方查询暂不可用.*responseCode=SVC_ERR_001.*exceptionCode=UPSTREAM_ERROR/,
  );
});

test('OOCL 同一提单有多个柜时只取指定柜的卸船时间', () => {
  const result = parseOoclTrackingResponse({
    result: {
      responseCode: 'SVC_OK_001',
      searchResultRecord: {
        containers: [
          { containerNumber: 'OTHER1234567', latestEvent: { event: 'Discharged', time: '18 Aug 2026 08:00' } },
          { containerNumber: 'OOCU7496887', latestEvent: { event: 'Loaded on vessel', time: '18 Aug 2026 09:00' }, routing: { eta: '20 Aug 2026 10:00' } },
        ],
      },
    },
  }, 'OOCU7496887');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrivalKind, 'ETA');
});

test('OOCL Provider 保留 OOLU 前缀并正确编码请求', async () => {
  let requested = '';
  const fetcher: typeof fetch = async (input) => {
    requested = input.toString();
    return new Response(JSON.stringify({
      result: {
        responseCode: 'SVC_OK_001',
        searchResultRecord: {
          containers: [{ containerNumber: 'OOCU7496887', routing: { eta: '2026-08-20 09:00' } }],
        },
      },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = await new OoclTrackingProvider(fetcher).query({
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.match(decodeURIComponent(requested), /paramString=blNumber=OOLU2171963250/);
  assert.equal(result.arrivalKind, 'ETA');
});

test('OOCL Control Tower 解析完整货柜事件并保留港口当地时区', () => {
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = parseOoclControlTowerText(`
货物跟踪 : 订舱 2171963250
Ningbo
Los Angeles
40HQ * 1
提单号2171963250(B/L Ready)
EVER LOVELY / 1232E
集装箱号 : OOCU7496887
包装 : 288 Carton
毛重 : 10627.2 KG
验证毛重 : 14447.2 KG (Submitted)
动态
时间
位置
阶段
运输方式
卸货
21 Aug 2026 10:47 PDT
Everport Terminal Services - Los Angeles
Los Angeles
Ocean
Vessel
到达
20 Aug 2026 05:39 PDT
Everport Terminal Services - Los Angeles
Los Angeles
Ocean
Vessel
离港
07 Aug 2026 07:38 CST
Ningbo BeiLun No1 Cntr Trml Co Ltd
Ningbo
Ocean
Vessel
装船
06 Aug 2026 20:03 CST
Ningbo BeiLun No1 Cntr Trml Co Ltd
Ningbo
Ocean
Vessel
重箱进场
31 Jul 2026 02:55 CST
Ningbo BeiLun No1 Cntr Trml Co Ltd
Ningbo, Zhejiang, China
Outbound
Truck
提空箱
22 Jul 2026 21:03 CST
Ningbo Meishan-Island International Container Terminal Co. Ltd
Ningbo, Zhejiang, China
Outbound
Truck
提单信息
海关清关状态
Held
预配舱单状态
United States: Accepted
`, {
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-20T12:39:00.000Z');
  assert.equal(result.arrivalTimeText, '20 Aug 2026 05:39 PDT（官网当地时间）');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-21T17:47:00.000Z');
  assert.equal(result.dischargeTimeText, '21 Aug 2026 10:47 PDT（官网当地时间）');
  assert.equal(result.trackingDetail?.events.length, 6);
  assert.equal(result.trackingDetail?.events[0].cargoState, 'empty');
  assert.equal(result.trackingDetail?.events[0].transportMode, 'truck');
  assert.equal(result.trackingDetail?.events.at(-1)?.eventType, 'discharge');
  assert.equal(result.trackingDetail?.events.at(-1)?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.at(-1)?.transportMode, 'ocean');
  assert.equal(result.trackingDetail?.routeStops.length, 3);
  assert.equal(result.trackingDetail?.currentPort, 'Los Angeles');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'Los Angeles');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, null);
  assert.match(result.routeText || '', /Ningbo Meishan-Island/);
  assert.match(result.routeText || '', /Everport Terminal Services/);
});

test('OOCL Control Tower 表格使用制表符分隔时仍识别到港和卸货', () => {
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = parseOoclControlTowerText([
    '货物跟踪 : 订舱 2171963250',
    '集装箱号 : OOCU7496887',
    '动态\t时间\t位置\t阶段\t运输方式',
    '卸货\t21 Aug 2026 10:47 PDT\tEverport Terminal Services - Los Angeles\tLos Angeles\tOcean\tVessel',
    '到达\t20 Aug 2026 05:39 PDT\tEverport Terminal Services - Los Angeles\tLos Angeles\tOcean\tVessel',
    '离港\t07 Aug 2026 07:38 CST\tNingbo BeiLun No1 Cntr Trml Co Ltd\tNingbo\tOcean\tVessel',
    '提单信息',
  ].join('\n'), {
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.equal(result.arrivalTimeText, '20 Aug 2026 05:39 PDT（官网当地时间）');
  assert.equal(result.dischargeTimeText, '21 Aug 2026 10:47 PDT（官网当地时间）');
  assert.equal(result.trackingDetail?.events.length, 3);
});

test('OOCL Control Tower 响应式布局把事件压在同一行时仍可解析', () => {
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = parseOoclControlTowerText(`
货物跟踪 : 订舱 2171963250
集装箱号 : OOCU7496887
动态 时间 位置 阶段 运输方式
卸货 21 Aug 2026 10:47 PDT Everport Terminal Services - Los Angeles Ocean Vessel
到达 20 Aug 2026 05:39 PDT Everport Terminal Services - Los Angeles Ocean Vessel
离港 07 Aug 2026 07:38 CST Ningbo BeiLun No1 Cntr Trml Co Ltd Ocean Vessel
提单信息
`, {
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.dischargeTimeText, '21 Aug 2026 10:47 PDT（官网当地时间）');
  assert.equal(result.trackingDetail?.events.length, 3);
});

test('OOCL Control Tower 只有预计到达时仍返回 ETA，不误报解析失败', () => {
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = parseOoclControlTowerText(`
货物跟踪 : 订舱 2171963250
集装箱号 : OOCU7496887
动态
时间
位置
阶段
运输方式
预计到达
27 Aug 2026 10:00 PDT
Everport Terminal Services - Los Angeles
Los Angeles
Ocean
Vessel
提单信息
`, {
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrived, false);
  assert.equal(result.arrivalTimeText, '27 Aug 2026 10:00 PDT（官网当地时间）');
  assert.equal(result.trackingDetail?.events.at(-1)?.actual, false);
  assert.equal(result.trackingDetail?.currentPort, null);
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'Los Angeles');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '27 Aug 2026 10:00 PDT（官网当地时间）');
});
