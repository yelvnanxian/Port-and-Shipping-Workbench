import type { CarrierRule, WorkbookRecord } from './types.js';

export const CARRIER_RULES: CarrierRule[] = [
  { prefix: 'ONEY', code: 'ONE', name: '海洋网联', removePrefix: true, queryMode: 'bill', url: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；验证页面仍会按风控失败并保存截图' },
  { prefix: 'MAEU', code: 'MAERSK', name: '马士基', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'limited', integrationMessage: '依次尝试去前缀提单号、完整提单号和柜号；仅在页面可核验号码及时间字段时写入' },
  { prefix: 'MEDU', code: 'MSC', name: '地中海', removePrefix: false, queryMode: 'bill', url: 'https://www.msccargo.cn/en/track-a-shipment?agencyPath=hkg', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；仅在页面可核验单号及时间字段时写入' },
  { prefix: 'EGLV', code: 'EVERGREEN', name: '长荣', removePrefix: true, queryMode: 'bill', url: 'https://www.evergreen-shipping.cn/servlet/TDB1_CargoTracking.do', integration: 'ready', integrationMessage: '已接入提单查询与货柜动态二次查询' },
  { prefix: 'OOLU', code: 'OOCL', name: '东方海外', removePrefix: false, queryMode: 'bill', url: 'https://www.oocl.com/schi/Pages/default.aspx', integration: 'ready', integrationMessage: '已接入 OOCL 官方公开追踪接口' },
  { prefix: 'WHLC', code: 'WANHAI', name: '万海', removePrefix: true, queryMode: 'bill-then-container', url: 'https://cn.wanhai.com/cec/#/cargotracking?q=N', integration: 'blocked', integrationMessage: '先查提单，失败后自动用柜号再次查询；HTTP 412 或页面验证会保留截图证据' },
  { prefix: 'ZIMU', code: 'ZIM', name: '以星', removePrefix: false, queryMode: 'bill-and-container', url: 'https://www.zimchina.com/tools/track-a-shipment', integration: 'blocked', integrationMessage: '已接入提单号、柜号双查及浏览器备用；Cloudflare 验证仍按风控失败' },
  { prefix: 'MATS', code: 'MATSON', name: '美森', removePrefix: false, queryMode: 'bill', url: 'https://www.cargo.chinamatson.com/', integration: 'ready', integrationMessage: '已接入 cargo.chinamatson.com 官方公开查询接口' },
  { prefix: 'YMJA', code: 'YANGMING', name: '阳明', removePrefix: false, queryMode: 'bill', url: 'https://www.yangming.com/en/esolution/cargo_tracking', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；动态结果必须核对订单号后才写入' },
  { prefix: 'SML', code: 'SMLINE', name: '森罗', removePrefix: true, queryMode: 'bill', url: 'https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=zh', integration: 'ready', integrationMessage: '已接入提单、航线与货柜事件三段官方查询' },
  { prefix: 'CMDU', code: 'CMA', name: '达飞', removePrefix: true, queryMode: 'bill', url: 'https://www.cma-cgm.com/ebusiness/tracking', integration: 'blocked', integrationMessage: '已接入直连与浏览器备用查询；Cloudflare 验证仍按风控失败并截图' },
  { prefix: 'COSU', code: 'COSCO', name: '中远海运', removePrefix: true, queryMode: 'bill', url: 'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=BILLOFLADING', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；动态结果无法核验时保留截图' },
  { prefix: 'HLCU', code: 'HAPAG', name: '赫伯罗特', removePrefix: true, queryMode: 'bill', url: 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-booking-solution.html', integration: 'blocked', integrationMessage: '已接入直连与浏览器备用查询；Security Check 仍按风控失败并截图' },
  { prefix: 'HDUJ', code: 'HEDE', name: '合德', removePrefix: false, queryMode: 'bill', url: 'http://elines.hedehk.com/cargoDynamic', integration: 'ready', integrationMessage: '已接入合德官方货物动态接口' },
  { prefix: 'HDMU', code: 'HMM', name: '韩新海运', removePrefix: true, queryMode: 'bill', url: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；动态结果必须核对订单号后才写入' },
];

export const ALL_CARRIER_RULES = CARRIER_RULES;

export function resolveCarrierRule(record: Pick<WorkbookRecord, 'billNo' | 'carrierHint'>): CarrierRule {
  const billNo = record.billNo.trim().toUpperCase();
  const rule = [...CARRIER_RULES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((candidate) => billNo.startsWith(candidate.prefix));
  if (!rule) throw new Error(`不支持的提单号前缀：${billNo.slice(0, 4) || '空'}`);
  return rule;
}

export function buildQueryBillNo(billNo: string, rule: CarrierRule) {
  const normalized = billNo.trim().toUpperCase();
  if (!rule.removePrefix) return normalized;
  if (rule.code === 'SMLINE' && normalized.startsWith('SMLM')) return normalized.slice(4);
  return normalized.slice(rule.prefix.length);
}
