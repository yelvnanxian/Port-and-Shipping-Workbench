export type VesselState = '未到港未卸船' | '已到港未卸船' | '已到港已卸船';
export type QueryProgress = '待查询' | '查询中' | '已完成' | '失败';
export type ArrivalKind = 'ATA' | 'ETA' | null;

export interface WorkbookRecord {
  rowNumber: number;
  carrierHint: string;
  billNo: string;
  containerNo: string;
  arrivalTime: Date | null;
  dischargeTime: Date | null;
  vesselState: VesselState | '';
  lastUpdated: Date | null;
  note: string;
  progress: QueryProgress | '';
}

export interface CarrierRule {
  prefix: string;
  code: string;
  name: string;
  removePrefix: boolean;
  queryMode: 'bill' | 'bill-and-container';
  url: string;
  integration: 'pending' | 'ready';
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
  arrivalKind: ArrivalKind;
  arrived: boolean;
  dischargeTime: Date | null;
  rawSummary: string;
  sourceUrl: string;
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
  backupPath: string | null;
  notification: 'sent' | 'skipped' | 'failed';
}
