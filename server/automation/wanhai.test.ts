import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCarrierRule } from './carriers.js';
import { parseWanhaiTrackingText } from './wanhai.js';

const rule = resolveCarrierRule({ billNo: 'WHLC025G709663', carrierHint: '万海' });

test('万海柜号结果解析实际到港和卸船后续状态，并保留官网原始时间', () => {
  const result = parseWanhaiTrackingText(`
提单号或柜号或关单号
WHSU8284656
2026-07-01 11:58:00
网上Booking
2026-07-06 16:14:43.0
舱单制作
2026-07-17 11:01:00
CNSKU已开船
2026-08-05 08:07:00
已到达USLAX
船名/航次
ONE SINGAPORE / 025E
提单号
025G709663
装货港
CNSKU
卸货港
USLAX
卸货港预计到港时间
2026-08-05 08:07:00
柜号
WHSU8284656
ISO Code
45G1
2026-08-13 13:09:00
进口重柜领出
2026-08-18 00:28:00
空柜进站
`, {
    rule,
    originalBillNo: 'WHLC025G709663',
    queryBillNo: '025G709663',
    containerNo: 'WHSU8284656',
    queryType: 'container',
  });

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTimeText, '2026-08-05 08:07:00（官网未标注时区）');
  assert.equal(result.discharged, true);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.trackingDetail?.events.some((event) => event.eventType === 'empty-return'), true);
  assert.equal(result.routeText, 'CNSKU → USLAX');
  assert.deepEqual(result.trackingDetail?.facts?.filter((item) => item.label === '提单号' || item.label === '柜号'), [
    { label: '提单号', value: '025G709663' },
    { label: '柜号', value: 'WHSU8284656' },
  ]);
});

test('万海结果必须显示当前查询号码', () => {
  assert.throws(() => parseWanhaiTrackingText('已到达USLAX\n2026-08-05 08:07:00\nOTHER1234567', {
    rule,
    originalBillNo: 'WHLC025G709663',
    queryBillNo: '025G709663',
    containerNo: 'WHSU8284656',
    queryType: 'container',
  }), /未显示本次提单号或柜号/);
});

test('万海结果表按整行表头输出时仍能读取卸货港预计到港时间', () => {
  const result = parseWanhaiTrackingText(`
提单号或柜号或关单号查询
2026-07-17 11:32:00
网上Booking
2026-07-31 11:17:33.0
船名/航次
提单号
装货港
装货港预计离港时间
卸货港
卸货港预计到港时间
关单号
提单类型
签单时间
HMM TURQUOISE/ 011E
027G731676
CNSHA
2026-08-12 21:00:01
USLAX
2026-09-01 04:00:01
W6243V70093
電放
2026-08-03 12:00:00
柜号
WHSU6850081
ISO Code
45G1
提单号
027G731676
`, {
    rule,
    originalBillNo: 'WHLC027G731676',
    queryBillNo: '027G731676',
    containerNo: 'WHSU6850081',
    queryType: 'bill',
  });

  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTimeText, '2026-09-01 04:00:01（官网未标注时区）');
  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'USLAX');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-09-01 04:00:01（官网未标注时区）');
  assert.equal(result.routeText, 'CNSHA → USLAX');
  assert.equal(result.trackingDetail?.events.some((event) => event.label.includes('预计')), false);
});

test('万海真实接口证据不会把字段标题写成港口，并读取 RTSS 预计到港', () => {
  const result = parseWanhaiTrackingText(`
WHLC027G731676
WHSU6850081
提单号
装货港
卸货港
卸货港预计到港时间
027G731676
CNSHA
USLAX
2026-09-01 04:00:01
柜号
WHSU6850081

[WANHAI API https://cn.wanhai.com/cec/wdcec109_m.do]
{"datas":{"RTSS":[{"status_d_d":"ESTIMATED","place_code_l":"CNSHA","s_arr_datetime_d":"2026-09-01 04:00:01","status_d_a":"ESTIMATED","place_code_d":"USLAX"}],"bookingInfo":[{"pol":"CNSHA","pod":"USLAX","book_no":"027G731676"}],"bookingDymc":[{"remark":"未到达USLAX","format_date":"2026-09-01 04:00:01"}]}}
[WANHAI API https://cn.wanhai.com/cec/getDynamicCtnr.do]
{"datas":[{"place_name":"SHANGHAI","ctnr_date_tpe":"2026-08-12 20:35:00","book_no":"027G731676","ctnr_status_desc":"重櫃裝船","ctnr_place":"CNSHA"}]}
`, {
    rule,
    originalBillNo: 'WHLC027G731676',
    queryBillNo: '027G731676',
    containerNo: 'WHSU6850081',
    queryType: 'bill',
  });

  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'USLAX');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-09-01 04:00:01（官网未标注时区）');
  assert.equal(result.trackingDetail?.routeStops.some((stop) => /预计到港时间/.test(stop.name)), false);
});
