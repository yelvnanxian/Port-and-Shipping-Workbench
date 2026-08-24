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
