import type { CarrierRule, WorkbookRecord } from './types.js';

export const CARRIER_RULES: CarrierRule[] = [
  { prefix: 'ONEY', code: 'ONE', name: '海洋网联 ONE', removePrefix: true, queryMode: 'bill', url: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking', integration: 'pending' },
  { prefix: 'MAEU', code: 'MAERSK', name: '马士基 Maersk', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'pending' },
  { prefix: 'EGLV', code: 'EVERGREEN', name: '长荣 Evergreen', removePrefix: true, queryMode: 'bill', url: 'https://www.evergreen-shipping.cn/servlet/TDB1_CargoTracking.do', integration: 'pending' },
  { prefix: 'OOLU', code: 'OOCL', name: '东方海外 OOCL', removePrefix: false, queryMode: 'bill', url: 'https://www.oocl.com/schi/Pages/default.aspx', integration: 'ready' },
  { prefix: 'WHLC', code: 'WANHAI', name: '万海 Wan Hai', removePrefix: true, queryMode: 'bill', url: 'https://cn.wanhai.com/cec/#/cargotracking?q=N', integration: 'pending' },
  { prefix: 'ZIMU', code: 'ZIM', name: '以星 ZIM', removePrefix: false, queryMode: 'bill-and-container', url: 'https://www.zimchina.com/tools/track-a-shipment', integration: 'pending' },
  { prefix: 'MATS', code: 'MATSON', name: '美森 Matson', removePrefix: false, queryMode: 'bill', url: 'https://www.cargo.chinamatson.com/', integration: 'pending' },
  { prefix: 'YMJA', code: 'YANGMING', name: '阳明 Yang Ming', removePrefix: false, queryMode: 'bill', url: 'https://www.yangming.com/en/esolution/cargo_tracking', integration: 'pending' },
  { prefix: 'SML', code: 'SMLINE', name: '森罗 SM Line', removePrefix: true, queryMode: 'bill', url: 'https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=zh', integration: 'pending' },
  { prefix: 'CMDU', code: 'CMA', name: '达飞 CMA CGM', removePrefix: true, queryMode: 'bill', url: 'https://www.cma-cgm.com/ebusiness/tracking', integration: 'pending' },
  { prefix: 'COSU', code: 'COSCO', name: '中远海运 COSCO', removePrefix: true, queryMode: 'bill', url: 'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=BILLOFLADING', integration: 'pending' },
  { prefix: 'HLCU', code: 'HAPAG', name: '赫伯罗特 Hapag-Lloyd', removePrefix: true, queryMode: 'bill', url: 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-booking-solution.html', integration: 'pending' },
  { prefix: 'HDUJ', code: 'HEDE', name: '合德', removePrefix: false, queryMode: 'bill', url: 'http://elines.hedehk.com/cargoDynamic', integration: 'pending' },
  { prefix: 'HDMU', code: 'HMM', name: '韩新海运 HMM', removePrefix: true, queryMode: 'bill', url: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do', integration: 'pending' },
];

export const MSC_RULE: CarrierRule = {
  prefix: 'MAEU',
  code: 'MSC',
  name: '地中海 MSC',
  removePrefix: false,
  queryMode: 'bill',
  url: 'https://www.msccargo.cn/en/track-a-shipment?agencyPath=hkg',
  integration: 'pending',
};

export const ALL_CARRIER_RULES = [...CARRIER_RULES.slice(0, 2), MSC_RULE, ...CARRIER_RULES.slice(2)];

export function resolveCarrierRule(record: Pick<WorkbookRecord, 'billNo' | 'carrierHint'>): CarrierRule {
  const billNo = record.billNo.trim().toUpperCase();
  if (billNo.startsWith('MAEU') && /地中海|\bMSC\b/i.test(record.carrierHint)) return MSC_RULE;
  const rule = [...CARRIER_RULES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((candidate) => billNo.startsWith(candidate.prefix));
  if (!rule) throw new Error(`不支持的提单号前缀：${billNo.slice(0, 4) || '空'}`);
  return rule;
}

export function buildQueryBillNo(billNo: string, rule: CarrierRule) {
  const normalized = billNo.trim().toUpperCase();
  return rule.removePrefix ? normalized.slice(rule.prefix.length) : normalized;
}
