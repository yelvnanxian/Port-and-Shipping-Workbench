export type VesselState = '未到港未卸船' | '已到港未卸船' | '已到港已卸船';
export type QueryProgress = '待查询' | '查询中' | '已完成' | '失败';
export type ManualMark = '' | '已清关' | '查验中' | '其他';
export type ArrivalKind = 'ATA' | 'ETA' | null;
export type TrackingTime = Date | string | null;
export type TrackingFailureCategory =
  | '订单号验证失败'
  | '官网拒绝访问'
  | '验证码或风控'
  | '官网接口异常'
  | '解析失败'
  | '查询超时';

export interface WorkbookRecord {
  rowNumber: number;
  carrierHint: string;
  billNo: string;
  containerNo: string;
  arrivalTime: TrackingTime;
  dischargeTime: TrackingTime;
  vesselState: VesselState | '';
  manualMark: ManualMark;
  lastUpdated: Date | null;
  note: string;
  progress: QueryProgress | '';
}

export interface CarrierRule {
  prefix: string;
  code: string;
  name: string;
  removePrefix: boolean;
  queryMode: 'bill' | 'bill-and-container' | 'bill-then-container' | 'bill-or-container';
  url: string;
  integration: 'ready' | 'blocked' | 'limited' | 'error';
  integrationMessage: string;
}

export interface TrackingQuery {
  rule: CarrierRule;
  originalBillNo: string;
  queryBillNo: string;
  containerNo: string;
  queryType: 'bill' | 'container';
}

export interface TrackingResult {
  arrivalTime: Date | null;
  arrivalTimeText?: string | null;
  arrivalKind: ArrivalKind;
  arrived: boolean;
  dischargeTime: Date | null;
  dischargeTimeText?: string | null;
  rawSummary: string;
  sourceUrl: string;
  evidencePath?: string;
  routeText?: string | null;
}

export interface FailedTrackingDetail {
  carrier: string;
  carrierCode: string;
  billNo: string;
  containerNo: string;
  category: TrackingFailureCategory;
  reason: string;
  sourceUrl: string;
  evidencePath?: string;
}

export interface RunSummary {
  id: string;
  reason: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt: string;
  total: number;
  success: number;
  unfinished: number;
  failed: number;
  skipped: number;
  failedBills: string[];
  failedDetails: FailedTrackingDetail[];
  backupPath: string | null;
  notification: 'sent' | 'skipped' | 'failed';
}

export type AutomationTaskScope = 'all' | 'carrier' | 'shipment';

export interface AutomationTask {
  id: string;
  name: string;
  scope: AutomationTaskScope;
  carrierCodes: string[];
  shipmentIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  scheduleTime: string | null;
}

export interface RunProgress {
  id: string;
  reason: RunSummary['reason'];
  phase: 'preparing' | 'querying' | 'saving' | 'notifying';
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  currentBills: Array<{ billNo: string; carrier: string }>;
  startedAt: string;
}

export interface AutomationSettings {
  enabled: boolean;
  browserAutomationEnabled: boolean;
  schedule: Array<{ time: string; cron: string }>;
  timezone: 'Asia/Shanghai';
  wechatWebhookUrl: string;
}
