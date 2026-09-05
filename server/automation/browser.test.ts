import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRenderedTrackingText, verificationStability } from './browser.js';
import { classifyTrackingError } from './errors.js';
import type { TrackingQuery } from './types.js';

const query: TrackingQuery = {
  rule: { prefix: 'MAEU', code: 'MAERSK', name: '马士基', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'limited', integrationMessage: '' },
  originalBillNo: 'MAEU271552824',
  queryBillNo: '271552824',
  containerNo: 'CICU6040856',
  queryType: 'bill',
};

test('浏览器结果必须包含对应订单号才允许写入', () => {
  assert.throws(() => parseRenderedTrackingText('ETA\n20 Aug 2026 09:00', query), /未显示对应的提单号或柜号/);
});

test('浏览器结果解析明确的 ETA 和实际卸船时间', () => {
  const result = parseRenderedTrackingText('MAEU271552824\nETA\n20 Aug 2026 09:00\nContainer discharged\n22 Aug 2026 08:30', query);
  assert.equal(result.arrivalKind, 'ETA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-20T01:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-22T00:30:00.000Z');
  assert.equal(result.arrived, true);
});

test('预计卸船不能被浏览器解析器写成实际卸船', () => {
  const result = parseRenderedTrackingText('MAEU271552824\nETA\n20 Aug 2026 09:00\nEstimated discharge\n22 Aug 2026 08:30', query);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrived, false);
});

test('浏览器安全检查仍归类为验证码或风控', () => {
  let captured: unknown;
  try {
    parseRenderedTrackingText('MAEU271552824\nSecurity Check\nVerify you are human', query);
  } catch (error) {
    captured = error;
  }
  const failure = classifyTrackingError(captured);
  assert.equal(failure.category, '验证码或风控');
});

test('浏览器网关错误归类为官网接口异常', () => {
  let captured: unknown;
  try {
    parseRenderedTrackingText('502 Bad Gateway\nMicrosoft-Azure-Application-Gateway/v2', query);
  } catch (error) {
    captured = error;
  }
  assert.equal(classifyTrackingError(captured).category, '官网接口异常');
});

test('人工验证短暂消失后重新出现时必须重新累计稳定时间', () => {
  let state = verificationStability(0, false, 1_000, 10_000);
  assert.equal(state.resolved, false);
  state = verificationStability(state.clearSince, false, 7_000, 10_000);
  assert.equal(state.resolved, false);
  state = verificationStability(state.clearSince, true, 8_000, 10_000);
  assert.deepEqual(state, { clearSince: 0, resolved: false });
  state = verificationStability(state.clearSince, false, 9_000, 10_000);
  state = verificationStability(state.clearSince, false, 18_999, 10_000);
  assert.equal(state.resolved, false);
  state = verificationStability(state.clearSince, false, 19_000, 10_000);
  assert.equal(state.resolved, true);
});

test('中远多港口轨迹取最后一个目的港到港时间', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310',
    '中转港 Ningbo',
    '实际到港',
    '2026-07-03 09:23:25',
    '目的港 Houston',
    '实际到港',
    '2026-08-06 11:07:44 CDT',
  ].join('\n'), coscoQuery);
  assert.equal(result.arrivalTime, null);
  assert.equal(result.arrivalTimeText, '2026-08-06 11:07:44 CDT（官网当地时间）');
});

test('地中海时间线支持日期位于实际卸船事件之前', () => {
  const mscQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'MEDU', code: 'MSC', name: '地中海', removePrefix: false },
    originalBillNo: 'MEDUPN815212',
    queryBillNo: 'MEDUPN815212',
  };
  const result = parseRenderedTrackingText([
    'BILL OF LADING: MEDUPN815212',
    '29/07/2026',
    'New York, US',
    'Import Discharged from Vessel',
    'MSC CHIARA X 624W',
  ].join('\n'), mscQuery);
  assert.equal(result.arrivalTime?.toISOString(), '2026-07-28T16:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-28T16:00:00.000Z');
  assert.ok(result.dischargeTime);
  assert.equal(result.arrived, true);
});

test('地中海时间线不会把上一条场站事件日期误配给 Import Discharged from Vessel', () => {
  const mscQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'MEDU', code: 'MSC', name: '地中海', removePrefix: false },
    originalBillNo: 'MEDUPN815212',
    queryBillNo: 'MEDUPN815212',
  };
  const result = parseRenderedTrackingText([
    'BILL OF LADING: MEDUPN815212',
    '04/08/2026',
    'New York, US',
    'Empty received at CY',
    '31/07/2026',
    'New York, US',
    'Import to consignee',
    '29/07/2026',
    'New York, US',
    'Full Available for Delivery',
    '29/07/2026',
    'New York, US',
    'Import Discharged from Vessel',
    'MSC CHIARA X 624W',
    '27/07/2026',
    'New York, US',
    'Carrier release',
  ].join('\n'), mscQuery);
  assert.equal(result.arrivalTime?.toISOString(), '2026-07-28T16:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-07-28T16:00:00.000Z');
});

test('中远出现提货或还空箱等后续实际节点时确认已卸船但不伪造卸船时间', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310',
    '始发港 Xingang',
    '实际离港',
    '2026-06-18 02:14:15 CST',
    '目的港 Houston',
    '实际到港',
    '2026-08-06 11:07:44 CDT',
    '目的地 Houston, US',
    '提货时间',
    '2026-08-13 12:34:00 CDT',
    '最新动态',
    '还空箱',
    '发生于 Barbours Cut Terminal, 2026-08-13 14:31:00',
  ].join('\n'), coscoQuery);
  assert.equal(result.arrivalTimeText, '2026-08-06 11:07:44 CDT（官网当地时间）');
  assert.equal(result.dischargeTimeText, undefined);
  assert.equal(result.dischargeTime, null);
  assert.equal(result.discharged, true);
  assert.match(result.rawSummary, /确认已卸船，但未提供精确卸船时刻/);
  assert.equal(result.arrived, true);
});

test('中远保存完整线路和多地点事件，并区分有货卸船与空箱回箱', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310',
    'Xingang, CN', '起始地',
    'Xingang', '始发港',
    'Ningbo', '中转港',
    'Houston', '目的港',
    'Houston, US', '目的地',
    'Xingang', '实际离港', '2026-06-18 02:14:15 CST',
    'Ningbo', '实际到港', '2026-07-03 09:23:25 CST',
    'Houston, US', '实际到港', '2026-08-06 11:07:44 CDT',
    'Houston, US', '卸船', '2026-08-06 12:00:00 CDT',
    'Houston, US', '提货时间', '2026-08-13 12:34:00 CDT',
    'Houston, US', '还空箱', '2026-08-13 14:31:00 CDT',
  ].join('\n'), coscoQuery);
  assert.equal(result.arrivalTimeText, '2026-08-06 11:07:44 CDT（官网当地时间）');
  assert.equal(result.dischargeTimeText, '2026-08-06 12:00:00 CDT（官网当地时间）');
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => stop.name), ['Xingang, CN', 'Xingang', 'Ningbo', 'Houston', 'Houston, US']);
  assert.equal(result.trackingDetail?.events.filter((event) => event.eventType === 'discharge')[0]?.cargoState, 'laden');
  assert.equal(result.trackingDetail?.events.find((event) => event.eventType === 'empty-return')?.cargoState, 'empty');
  assert.equal(result.rawPageText?.includes('Houston, US'), true);
});

test('中远事件时间线缺少路线标题时仍补齐多个事件地点', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310',
    'Xingang', '实际离港', '2026-06-18 02:14:15 CST',
    'Houston', '实际到港', '2026-08-06 11:07:44 CDT',
    'Barbours Cut Terminal', '卸船', '2026-08-06 12:00:00 CDT',
  ].join('\n'), coscoQuery);
  assert.deepEqual(result.trackingDetail?.routeStops.map((stop) => stop.name), ['Xingang', 'Houston', 'Barbours Cut Terminal']);
  assert.equal(result.trackingDetail?.events.filter((event) => event.location === 'Barbours Cut Terminal').length, 1);
});

test('中远真实成功页结构不会把菜单、时区和柜号误认成地点', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU6503130310',
    queryBillNo: '6503130310',
    containerNo: 'OOCU0872637',
  };
  const result = parseRenderedTrackingText([
    '提单号 6503130310', '最新动态', '还空箱', '发生于Barbours CutTerminal, 2026-08-13 14:31:00',
    '全链运输信息', '集装箱信息', '报关信息',
    '起始地', '始发港', '中转港', '目的港', '目的地',
    'Xingang, CN', 'Xingang', 'Ningbo', 'Houston', 'Houston, US',
    '还重时间', '2026-06-17', '07:25:00', 'CST',
    '实际离港', '2026-06-18', '02:14:15', 'CST',
    '实际离港', '2026-07-03', '09:23:25', 'CST',
    '实际到港', '2026-08-06', '11:07:44', 'CDT',
    '提货时间', '2026-08-13', '12:34:00', 'CDT',
    '运输详情', 'OOCU0872637', 'Truck', 'Barbours CutTerminal', '还空箱', '于 2026-08-13 14:31:00',
    '实时船期', '船名 航线 / 航次 装货港 离港时间 卸货港 到港时间',
    'COSCO SHIPPING ORCHID', 'AWE2', '034E', 'Xingang', '预计：2026-06-18 02:00:00', '实际：2026-06-18 02:14:15', 'Ningbo', '预计：2026-06-24 13:00:00', '实际：2026-06-24 13:34:02',
    'OOCL EUROPE', 'GME', '213E', 'Ningbo', '预计：2026-07-03 09:45:00', '实际：2026-07-03 09:23:25', 'Houston', '预计：2026-08-06 11:00:00', '实际：2026-08-06 11:07:44',
    '提单信息', '装货港 :', "Xingang-Tianjin Port Pacific Int'l Ctn Tml", '卸货港 :', 'Houston-Barbours CutTerminal', '6503130310',
  ].join('\n'), coscoQuery);
  assert.deepEqual(result.trackingDetail?.routeStops.slice(0, 5).map((stop) => stop.name), ['Xingang, CN', 'Xingang', 'Ningbo', 'Houston', 'Houston, US']);
  assert.equal(result.trackingDetail?.routeStops.some((stop) => /报关信息|CST|CDT|OOCU0872637/.test(stop.name)), false);
  assert.equal(result.trackingDetail?.events.some((event) => /报关信息|CST|CDT|OOCU0872637/.test(event.location || '')), false);
  assert.equal(result.trackingDetail?.events.some((event) => event.eventType === 'arrival' && event.location === 'Ningbo' && event.timeText === '2026-06-24 13:34:02'), true);
  assert.equal(result.trackingDetail?.events.find((event) => event.eventType === 'arrival' && event.location === 'Houston' && event.actual)?.time, '2026-08-06T16:07:44.000Z');
  const emptyReturn = result.trackingDetail?.events.find((event) => event.eventType === 'empty-return' && event.cargoState === 'empty');
  assert.equal(emptyReturn?.time, null);
  assert.equal(emptyReturn?.timeText, '2026-08-13 14:31:00');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.discharged, true);
});

test('中远四节点路线不把码头链接当预计到达港口，并读取实时船期 ETA', () => {
  const coscoQuery: TrackingQuery = {
    ...query,
    rule: { ...query.rule, prefix: 'COSU', code: 'COSCO', name: '中远海运' },
    originalBillNo: 'COSU9508832520',
    queryBillNo: '9508832520',
    containerNo: 'FFAU3236667',
  };
  const result = parseRenderedTrackingText([
    '提单号 9508832520',
    '全链运输信息',
    '起始地', '始发港', '目的港', '目的地',
    'Yantian, CN', 'Yantian', 'Long Beach', 'Long Beach, US',
    '实际到港', '2026-08-29', '14:44:35', 'PDT',
    '实时船期',
    'COSCO SHIPPING CARNATION', 'SEA', '008E', 'Yantian',
    '预计：2026-08-13 18:00:00', '实际：2026-08-13 13:47:18',
    'Long Beach', '预计：2026-08-29 08:00:00', '实际：2026-08-29 14:44:35',
    '提单信息', '码头链接', '卸货港 :', 'Long Beach-Long Beach Container Terminal , LLC',
  ].join('\n'), coscoQuery);

  assert.equal(result.trackingDetail?.estimatedArrivalPort, 'Long Beach');
  assert.equal(result.trackingDetail?.estimatedArrivalTimeText, '2026-08-29 08:00:00（官网当地时间）');
  assert.equal(result.trackingDetail?.routeStops.some((stop) => /码头链接/.test(stop.name)), false);
  assert.equal(result.arrivalTimeText, '2026-08-29 14:44:35 PDT（官网当地时间）');
});
