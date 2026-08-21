export type ShipmentStatus = '待靠泊' | '作业中' | '已卸船' | '计划变更';
export type ManualMark = '' | '已清关' | '查验中' | '其他';

export interface Shipment {
  id: string;
  carrier: string;
  carrierCode: string;
  billNo: string;
  containerNo: string;
  vesselVoyage: string;
  terminal: string;
  eta: string | null;
  berthingTime: string | null;
  dischargeTime: string | null;
  status: ShipmentStatus;
  lastUpdated: string;
  note?: string;
  vesselState?: '未到港未卸船' | '已到港未卸船' | '已到港已卸船';
  manualMark: ManualMark;
  progress?: '待查询' | '查询中' | '已完成' | '失败';
  sourceUrl?: string;
  evidencePath?: string;
  verificationNo?: string;
  route?: string | null;
}

export interface CarrierSource {
  id: string;
  name: string;
  code: string;
  color: string;
  mode: 'live';
  status: 'online' | 'warning' | 'offline';
  lastSync: string;
  recordCount: number;
}

export interface DashboardData {
  shipments: Shipment[];
  sources: CarrierSource[];
  generatedAt: string;
}

export interface AutomationStatus {
  running: boolean;
  currentRun: null | {
    id: string;
    reason: 'manual' | 'scheduled';
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
  };
  mode: 'live';
  enabled: boolean;
  browserAutomationEnabled: boolean;
  workbook: null | {
    path: string;
    fileName: string;
    size: number;
    modifiedAt: string;
    records: number;
    queryable: number;
  };
  schedule: Array<{ time: string; cron: string }>;
  timezone: string;
  notificationConfigured: boolean;
  databaseConfigured?: boolean;
  supportedCarriers: number;
  lastRun: null | {
    id: string;
    finishedAt: string;
    total: number;
    success: number;
    unfinished: number;
    failed: number;
    skipped: number;
    notification: 'sent' | 'skipped' | 'failed';
  };
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
