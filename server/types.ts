export type ShipmentStatus = '待靠泊' | '作业中' | '已卸船' | '计划变更';

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
  progress?: '待查询' | '查询中' | '已完成' | '失败';
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
