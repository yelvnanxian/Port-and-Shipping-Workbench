import type { CarrierAdapter, Shipment } from '../types.js';

const records: Shipment[] = [
  { id: 'SHP-001', carrier: '中远海运', carrierCode: 'COSCO', billNo: 'COSU63829104', containerNo: 'CSNU7284156', vesselVoyage: '新亚洲 / 068E', terminal: '上海 · 洋山四期', eta: '2026-08-19T08:30:00+08:00', berthingTime: '2026-08-19T10:00:00+08:00', dischargeTime: null, status: '待靠泊', lastUpdated: '2026-08-18T20:24:00+08:00' },
  { id: 'SHP-002', carrier: '马士基', carrierCode: 'MAERSK', billNo: 'MAEU24973186', containerNo: 'MSKU9483201', vesselVoyage: 'MARCHEN MAERSK / 626W', terminal: '宁波 · 梅山码头', eta: '2026-08-18T22:15:00+08:00', berthingTime: '2026-08-18T23:10:00+08:00', dischargeTime: null, status: '作业中', lastUpdated: '2026-08-18T20:31:00+08:00' },
  { id: 'SHP-003', carrier: 'ONE', carrierCode: 'ONE', billNo: 'ONEYSH6AD28100', containerNo: 'ONEU3157624', vesselVoyage: 'ONE INNOVATION / 062E', terminal: '盐田国际', eta: '2026-08-20T14:00:00+08:00', berthingTime: null, dischargeTime: null, status: '计划变更', lastUpdated: '2026-08-18T19:52:00+08:00', note: 'ETA 较上一版推迟 6 小时' },
  { id: 'SHP-004', carrier: '达飞轮船', carrierCode: 'CMA CGM', billNo: 'CMDUSHZ6719280', containerNo: 'CMAU1864290', vesselVoyage: 'CMA CGM ARGENTINA / 0FL9E', terminal: '上海 · 外高桥五期', eta: '2026-08-17T16:40:00+08:00', berthingTime: '2026-08-17T18:05:00+08:00', dischargeTime: '2026-08-18T03:42:00+08:00', status: '已卸船', lastUpdated: '2026-08-18T04:02:00+08:00' },
  { id: 'SHP-005', carrier: '中远海运', carrierCode: 'COSCO', billNo: 'COSU77120593', containerNo: 'OOLU6721948', vesselVoyage: 'COSCO SHIPPING ARIES / 057W', terminal: '青岛 · 前湾码头', eta: '2026-08-21T06:20:00+08:00', berthingTime: null, dischargeTime: null, status: '待靠泊', lastUpdated: '2026-08-18T20:10:00+08:00' },
  { id: 'SHP-006', carrier: '长荣海运', carrierCode: 'EVERGREEN', billNo: 'EGLV143628955', containerNo: 'EGHU9274015', vesselVoyage: 'EVER ARM / 119E', terminal: '厦门 · 海天码头', eta: '2026-08-18T09:45:00+08:00', berthingTime: '2026-08-18T11:20:00+08:00', dischargeTime: '2026-08-18T17:36:00+08:00', status: '已卸船', lastUpdated: '2026-08-18T17:51:00+08:00' },
  { id: 'SHP-007', carrier: '马士基', carrierCode: 'MAERSK', billNo: 'MAEU62819045', containerNo: 'TCLU4382017', vesselVoyage: 'MAERSK HANOI / 631N', terminal: '南沙二期', eta: '2026-08-19T19:30:00+08:00', berthingTime: '2026-08-19T21:00:00+08:00', dischargeTime: null, status: '待靠泊', lastUpdated: '2026-08-18T20:06:00+08:00' },
  { id: 'SHP-008', carrier: 'ONE', carrierCode: 'ONE', billNo: 'ONEYTY6BC39100', containerNo: 'NYKU8421593', vesselVoyage: 'ONE TRADITION / 078W', terminal: '宁波 · 北仑三期', eta: '2026-08-18T05:20:00+08:00', berthingTime: '2026-08-18T06:12:00+08:00', dischargeTime: '2026-08-18T14:08:00+08:00', status: '已卸船', lastUpdated: '2026-08-18T14:31:00+08:00' },
];

export class DemoCarrierAdapter implements CarrierAdapter {
  readonly source = {
    id: 'demo-carriers',
    name: '船司聚合演示源',
    code: 'DEMO',
    color: '#19b8a3',
    mode: 'demo' as const,
    status: 'online' as const,
  };

  async fetchShipments(): Promise<Shipment[]> {
    await new Promise((resolve) => setTimeout(resolve, 650));
    const now = new Date().toISOString();
    return records.map((record) => ({ ...record, lastUpdated: record.lastUpdated || now }));
  }
}
