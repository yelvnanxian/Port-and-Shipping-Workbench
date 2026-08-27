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
  /** Whether the displayed arrival time is an actual arrival or an estimate. */
  arrivalKind?: 'ATA' | 'ETA' | null;
  status: ShipmentStatus;
  lastUpdated: string;
  note?: string;
  vesselState?: '未到港未卸船' | '已到港未卸船' | '已到港已卸船';
  manualMark: ManualMark;
  progress?: '待查询' | '查询中' | '已完成' | '失败';
  sourceUrl?: string;
  evidencePath?: string;
  failureEvidencePath?: string;
  verificationNo?: string;
  trackingDetail?: {
    carrierCode: string;
    queryType: 'bill' | 'container';
    queryValue: string;
    capturedAt: string;
    routeStops: Array<{
      name: string;
      role: 'origin' | 'loading' | 'transshipment' | 'discharge' | 'delivery' | 'unknown';
    }>;
    events: Array<{
      label: string;
      eventType: 'origin' | 'departure' | 'transshipment' | 'arrival' | 'discharge' | 'pickup' | 'empty-return' | 'delivery' | 'other';
      location: string | null;
      time: string | null;
      timeText?: string | null;
      actual: boolean;
      cargoState: 'laden' | 'empty' | 'unknown';
      facility?: string | null;
      vesselName?: string | null;
      voyageNo?: string | null;
      transportMode?: 'ocean' | 'rail' | 'truck' | 'terminal' | 'unknown';
      sourceLine?: string;
    }>;
    currentPort?: string | null;
    estimatedArrivalPort?: string | null;
    estimatedArrivalTimeText?: string | null;
    facts?: Array<{ label: string; value: string }>;
  };
  trackingDetailUrl?: string;
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

export interface CarrierAdapter {
  readonly source: Omit<CarrierSource, 'lastSync' | 'recordCount'>;
  fetchShipments(): Promise<Shipment[]>;
}
