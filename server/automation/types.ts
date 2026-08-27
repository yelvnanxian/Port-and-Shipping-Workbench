export type VesselState = '未到港未卸船' | '已到港未卸船' | '已到港已卸船';
export type QueryProgress = '待查询' | '查询中' | '已完成' | '失败';
export type ManualMark = '' | '已清关' | '查验中' | '其他';
export type ArrivalKind = 'ATA' | 'ETA' | null;
export type TrackingTime = Date | string | null;
export type TrackingCargoState = 'laden' | 'empty' | 'unknown';
export type TrackingEventType =
  | 'origin'
  | 'departure'
  | 'transshipment'
  | 'arrival'
  | 'discharge'
  | 'pickup'
  | 'empty-return'
  | 'delivery'
  | 'other';

export interface TrackingRouteStop {
  name: string;
  role: 'origin' | 'loading' | 'transshipment' | 'discharge' | 'delivery' | 'unknown';
}

export interface TrackingEventDetail {
  label: string;
  eventType: TrackingEventType;
  location: string | null;
  time: string | null;
  timeText?: string | null;
  actual: boolean;
  cargoState: TrackingCargoState;
  facility?: string | null;
  vesselName?: string | null;
  voyageNo?: string | null;
  transportMode?: 'ocean' | 'rail' | 'truck' | 'terminal' | 'unknown';
  sourceLine?: string;
}

export interface TrackingFact {
  label: string;
  value: string;
}

export interface TrackingDetail {
  carrierCode: string;
  queryType: TrackingQuery['queryType'];
  queryValue: string;
  capturedAt: string;
  routeStops: TrackingRouteStop[];
  events: TrackingEventDetail[];
  /** 最新一条可识别的实际港口事件地点（中转港也只保留在这里，不写入 ATA/卸船字段）。 */
  currentPort?: string | null;
  /** 最终目的港（POD），与中转港严格区分。 */
  estimatedArrivalPort?: string | null;
  /** 官网 Current ETA/最终目的港 ETA 原文。 */
  estimatedArrivalTimeText?: string | null;
  facts?: TrackingFact[];
}
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
  /**
   * `bill-or-container` and `bill-then-container` both mean bill-first with
   * container fallback. `bill-and-container` remains only for compatibility
   * with older serialized rules and is treated the same way by trackRecord.
   */
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
  /** 官网后续事件可确认已卸船，但未必提供可核验的精确卸船时刻。 */
  discharged?: boolean;
  dischargeTime: Date | null;
  dischargeTimeText?: string | null;
  /** 官网最终目的港 ETA 原文；不包含中转港预计时间。 */
  estimatedArrivalTimeText?: string | null;
  rawSummary: string;
  sourceUrl: string;
  evidencePath?: string;
  routeText?: string | null;
  trackingDetail?: TrackingDetail;
  rawPageText?: string;
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
  verification?: {
    carrier: string;
    carrierCode: string;
    billNo: string;
    containerNo: string;
    sourceUrl: string;
  };
  startedAt: string;
}

export interface AutomationSettings {
  enabled: boolean;
  browserAutomationEnabled: boolean;
  schedule: Array<{ time: string; cron: string }>;
  timezone: 'Asia/Shanghai';
  wechatWebhookUrl: string;
}
