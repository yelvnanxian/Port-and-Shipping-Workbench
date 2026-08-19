import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCarrierRule } from './carriers.js';
import { notifyWeCom } from './notifier.js';
import { OoclTrackingProvider } from './oocl.js';
import { HedeTrackingProvider } from './hede.js';
import { CarrierRoutingTrackingProvider, DemoTrackingProvider, trackRecord, type TrackingProvider } from './tracker.js';
import type { RunSummary, WorkbookRecord } from './types.js';
import { WorkbookStore } from './workbook.js';

function isDemoMode() {
  return process.env.SCRAPER_MODE === 'demo';
}

function isQueryable(record: WorkbookRecord) {
  return !record.vesselState || record.vesselState === '未到港未卸船' || record.vesselState === '已到港未卸船';
}

export class AutomationEngine {
  private running = false;
  readonly store: WorkbookStore;
  readonly runLogPath: string;

  constructor(store = new WorkbookStore()) {
    this.store = store;
    this.runLogPath = path.join(store.dataDirectory, 'runs.json');
  }

  get isRunning() {
    return this.running;
  }

  private provider(): TrackingProvider {
    return isDemoMode()
      ? new DemoTrackingProvider()
      : new CarrierRoutingTrackingProvider(new Map<string, TrackingProvider>([
        ['OOCL', new OoclTrackingProvider()],
        ['HEDE', new HedeTrackingProvider()],
      ]));
  }

  async listRuns(): Promise<RunSummary[]> {
    try {
      return JSON.parse(await fs.readFile(this.runLogPath, 'utf8')) as RunSummary[];
    } catch {
      return [];
    }
  }

  private async saveRun(summary: RunSummary) {
    await this.store.initialize();
    const runs = await this.listRuns();
    await fs.writeFile(this.runLogPath, JSON.stringify([summary, ...runs].slice(0, 30), null, 2));
  }

  async run(reason: RunSummary['reason']): Promise<RunSummary> {
    if (this.running) throw new Error('已有更新任务正在执行');
    this.running = true;
    const startedAt = new Date();
    const id = `RUN-${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`;
    let backupPath: string | null = null;
    try {
      const { workbook, sheet, headerMap } = await this.store.open();
      const allRecords = this.store.readRecords(sheet, headerMap);
      const records = allRecords.filter(isQueryable);
      backupPath = await this.store.backup(`${reason === 'manual' ? '手动' : '定时'}更新前备份`);
      const provider = this.provider();
      const failedBills: string[] = [];
      let success = 0;
      let unfinished = 0;

      for (const record of records) {
        record.progress = '查询中';
        this.store.writeRecord(sheet, headerMap, record);
      }
      await this.store.save(workbook);

      for (const record of records) {
        try {
          const { rule, result } = await trackRecord(record, provider);
          record.carrierHint = record.carrierHint || rule.name;
          record.arrivalTime = result.arrivalTime;
          record.dischargeTime = result.dischargeTime;
          record.vesselState = result.dischargeTime
            ? '已到港已卸船'
            : result.arrived
              ? '已到港未卸船'
              : '未到港未卸船';
          record.lastUpdated = new Date();
          record.progress = '已完成';
          record.note = `${result.arrivalKind ? `到港字段=${result.arrivalKind}；` : ''}${result.rawSummary}；来源=${rule.name}官网`;
          success += 1;
          if (record.vesselState !== '已到港已卸船') unfinished += 1;
        } catch (error) {
          record.lastUpdated = new Date();
          record.progress = '失败';
          record.note = error instanceof Error ? error.message : '未知抓取错误';
          failedBills.push(record.billNo);
        }
        this.store.writeRecord(sheet, headerMap, record);
      }
      await this.store.save(workbook);

      const finishedAt = new Date();
      const summary: RunSummary = {
        id,
        reason,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        total: records.length,
        success,
        unfinished,
        failed: failedBills.length,
        skipped: allRecords.length - records.length,
        failedBills,
        backupPath,
        notification: 'skipped',
      };
      summary.notification = await notifyWeCom(summary);
      await this.saveRun(summary);
      return summary;
    } finally {
      this.running = false;
    }
  }

  async status() {
    const workbook = await this.store.metadata();
    const runs = await this.listRuns();
    return {
      running: this.running,
      mode: isDemoMode() ? 'demo' : 'live',
      workbook,
      schedule: [
        { time: '09:00', cron: '0 9 * * *' },
        { time: '11:00', cron: '0 11 * * *' },
        { time: '17:30', cron: '30 17 * * *' },
      ],
      timezone: 'Asia/Shanghai',
      notificationConfigured: Boolean(process.env.WECHAT_WEBHOOK_URL),
      lastRun: runs[0] || null,
      supportedCarriers: 15,
    };
  }

  async dashboardRecords() {
    if (!(await this.store.exists())) return [];
    const { sheet, headerMap } = await this.store.open();
    return this.store.readRecords(sheet, headerMap).map((record) => {
      let carrier = record.carrierHint || '未知船司';
      let carrierCode = 'UNKNOWN';
      try {
        const rule = resolveCarrierRule(record);
        carrier = record.carrierHint || rule.name;
        carrierCode = rule.code;
      } catch { /* 错误展示在 Excel 备注中 */ }
      return { record, carrier, carrierCode };
    });
  }
}
