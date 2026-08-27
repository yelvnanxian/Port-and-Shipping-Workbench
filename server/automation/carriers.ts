import type { CarrierRule, WorkbookRecord } from './types.js';

export const CARRIER_RULES: CarrierRule[] = [
  { prefix: 'ONEY', code: 'ONE', name: '海洋网联', removePrefix: true, queryMode: 'bill-then-container', url: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking', integration: 'ready', integrationMessage: '已接入官网公开追踪接口；先查提单号，明确无结果后再改查柜号' },
  { prefix: 'MAEU', code: 'MAERSK', name: '马士基', removePrefix: true, queryMode: 'bill', url: 'https://www.maersk.com/tracking/', integration: 'ready', integrationMessage: '已接入官网浏览器查询与完整多港事件解析；先查去前缀提单号，明确无结果时再尝试完整提单号和柜号；Akamai 拒绝会明确标记为风控而非订单号无效' },
  { prefix: 'MEDU', code: 'MSC', name: '地中海', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.msccargo.cn/en/track-a-shipment?agencyPath=hkg', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；提单明确无结果时自动改查柜号，仅在页面可核验号码及时间字段时写入' },
  { prefix: 'EGLV', code: 'EVERGREEN', name: '长荣', removePrefix: true, queryMode: 'bill-then-container', url: 'https://www.evergreen-shipping.cn/servlet/TDB1_CargoTracking.do', integration: 'ready', integrationMessage: '已接入提单查询与货柜动态二次查询；提单明确无结果时自动改查柜号' },
  { prefix: 'OOLU', code: 'OOCL', name: '东方海外', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.oocl.com/schi/Pages/default.aspx', integration: 'limited', integrationMessage: '已接入 Patchright 持久会话；出现图形拖拽验证时保持页面等待人工完成，通过后自动采集完整事件、路线、接口原文和截图证据' },
  { prefix: 'WHLC', code: 'WANHAI', name: '万海', removePrefix: true, queryMode: 'bill-then-container', url: 'https://cn.wanhai.com/cec/#/cargotracking?q=N', integration: 'limited', integrationMessage: '已接入 Patchright 持久会话，避免旧通用浏览器纯白页；先查提单号，明确无结果后再查询柜号，并保留完整页面、接口原文和截图证据' },
  { prefix: 'ZIMU', code: 'ZIM', name: '以星', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.zimchina.com/tools/track-a-shipment', integration: 'limited', integrationMessage: '已接入 Patchright 持久会话；先查提单号，明确无结果后再改查柜号，避免不必要的重复请求；查询期间禁用地图自动滚动' },
  { prefix: 'MATS', code: 'MATSON', name: '美森', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.cargo.chinamatson.com/', integration: 'ready', integrationMessage: '已接入 cargo.chinamatson.com 官方公开查询接口；提单明确无结果时自动改查柜号' },
  { prefix: 'YMJA', code: 'YANGMING', name: '阳明', removePrefix: false, queryMode: 'bill-then-container', url: 'https://www.yangming.com/en/esolution/cargo_tracking', integration: 'ready', integrationMessage: '已接入阳明官方 CargoTracking 公开接口；提单明确无结果时自动改查柜号并核对到港、卸船事件' },
  { prefix: 'SML', code: 'SMLINE', name: '森罗', removePrefix: true, queryMode: 'bill-then-container', url: 'https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=zh', integration: 'ready', integrationMessage: '提单号去除 SMLM 前缀后优先查询；明确无结果时再改查柜号' },
  { prefix: 'CMDU', code: 'CMA', name: '达飞', removePrefix: true, queryMode: 'bill-then-container', url: 'https://www.cma-cgm.com/ebusiness/tracking', integration: 'limited', integrationMessage: '使用普通 Chrome/Edge + 工作台扩展采集；人工完成 DataDome 验证和查询后，扩展提交当前结果页、截图与路线数据，后台任务不会启动自动化 Chrome' },
  { prefix: 'COSU', code: 'COSCO', name: '中远海运', removePrefix: true, queryMode: 'bill-then-container', url: 'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=BILLOFLADING', integration: 'limited', integrationMessage: '已接入官网直连与浏览器模拟点击；提单明确无结果时自动改查柜号，动态结果无法核验时保留截图' },
  { prefix: 'HLCU', code: 'HAPAG', name: '赫伯罗特', removePrefix: true, queryMode: 'bill-then-container', url: 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-container-solution.html', integration: 'limited', integrationMessage: '固定使用完整柜号，通过普通 Chrome/Edge + 工作台扩展采集；人工完成 Security Check、查询并进入 Details 后提交页面与截图，后台任务不会启动自动化 Chrome' },
  { prefix: 'HDUJ', code: 'HEDE', name: '合德', removePrefix: false, queryMode: 'bill-then-container', url: 'http://elines.hedehk.com/cargoDynamic', integration: 'ready', integrationMessage: '已接入合德官方货物动态接口；提单明确无结果时自动改查柜号' },
  { prefix: 'HDMU', code: 'HMM', name: '韩新海运', removePrefix: true, queryMode: 'bill-then-container', url: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do', integration: 'ready', integrationMessage: '已接入官网有界面浏览器查询；提单明确无结果时自动改查柜号，并区分实际到港、预计到港和实际卸船事件' },
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
