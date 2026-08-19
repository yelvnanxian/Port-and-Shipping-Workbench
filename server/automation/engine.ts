import fs from 'node:fs/promises';
import path from 'node:path';
import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { BrowserTrackingProvider, FallbackTrackingProvider } from './browser.js';
import { classifyTrackingError } from './errors.js';
import { EvergreenTrackingProvider } from './evergreen.js';
import { MatsonTrackingProvider } from './matson.js';
import { YangmingTrackingProvider } from './yangming.js';
import { notifyWeCom } from './notifier.js';
import { OoclTrackingProvider } from './oocl.js';
import { OneTrackingProvider } from './one.js';
import { HedeTrackingProvider } from './hede.js';
import { HmmTrackingProvider } from './hmm.js';
import { OfficialSiteProbeProvider } from './official-probe.js';
import { SmLineTrackingProvider } from './smline.js';
import { RateLimiter } from './rate-limiter.js';
import { CarrierRoutingTrackingProvider, trackRecord, type TrackingProvider } from './tracker.js';
import type { AutomationSettings, FailedTrackingDetail, RunProgress, RunSummary, TrackingTime, WorkbookRecord } from './types.js';
import { WorkbookStore } from './workbook.js';

function isQueryable(record: WorkbookRecord) {
  return !record.vesselState || record.vesselState === '未到港未卸船' || record.vesselState === '已到港未卸船';
}

function failedNote(detail: FailedTrackingDetail) {
  return `失败分类=${detail.category}；船司=${detail.carrier}；提单号=${detail.billNo}；柜号=${detail.containerNo || '未提供'}；原因=${detail.reason}；来源=${detail.sourceUrl}${detail.evidencePath ? `；浏览器证据=${detail.evidencePath}` : ''}`;
}

function publicTime(value: TrackingTime) {
  return value instanceof Date ? value.toISOString() : value;
}

function sourceUrlFromNote(note: string) {
  return note.match(/(?:^|；)来源=(https?:\/\/[^；\s]+)/i)?.[1] || '';
}

export function evidencePathFromNote(note: string) {
  return note.match(/(?:^|；)成功证据=(\/api\/browser-evidence\/[^；\s]+)/i)?.[1] || '';
}

export class AutomationEngine {
  private running = false;
  private currentRun: RunProgress | null = null;
  readonly store: WorkbookStore;
  readonly runLogPath: string;
  readonly settingsPath: string;

  constructor(store = new WorkbookStore()) {
    this.store = store;
    this.runLogPath = path.join(store.dataDirectory, 'runs.json');
    this.settingsPath = path.join(store.dataDirectory, 'settings.json');
  }

  get isRunning() {
    return this.running;
  }

  private provider(settings: AutomationSettings): TrackingProvider {
    const browser = settings.browserAutomationEnabled
      ? new BrowserTrackingProvider(path.join(this.store.dataDirectory, 'browser-evidence'))
      : null;
    const withBrowserFallback = (primary: TrackingProvider) => browser ? new FallbackTrackingProvider(primary, browser) : primary;
    const hmm = settings.browserAutomationEnabled
      ? new HmmTrackingProvider(path.join(this.store.dataDirectory, 'browser-evidence'))
      : new OfficialSiteProbeProvider();
    return new CarrierRoutingTrackingProvider(new Map<string, TrackingProvider>([
      ['OOCL', withBrowserFallback(new OoclTrackingProvider())],
      ['ONE', withBrowserFallback(new OneTrackingProvider())],
      ['HEDE', withBrowserFallback(new HedeTrackingProvider())],
      ['SMLINE', withBrowserFallback(new SmLineTrackingProvider())],
      ['EVERGREEN', withBrowserFallback(new EvergreenTrackingProvider())],
      ['MATSON', withBrowserFallback(new MatsonTrackingProvider())],
      ['YANGMING', withBrowserFallback(new YangmingTrackingProvider())],
      ['HMM', hmm],
    ]), withBrowserFallback(new OfficialSiteProbeProvider()));
  }

  async listRuns(): Promise<RunSummary[]> {
    try {
      const runs = JSON.parse(await fs.readFile(this.runLogPath, 'utf8')) as RunSummary[];
      return runs.map((run) => ({ ...run, failedBills: run.failedBills || [], failedDetails: run.failedDetails || [] }));
    } catch {
      return [];
    }
  }

  async settings(): Promise<AutomationSettings> {
    const fallback: AutomationSettings = {
      enabled: true,
      browserAutomationEnabled: true,
      schedule: [
        { time: '09:00', cron: '0 9 * * *' },
        { time: '11:00', cron: '0 11 * * *' },
        { time: '17:30', cron: '30 17 * * *' },
      ],
      timezone: 'Asia/Shanghai',
      wechatWebhookUrl: process.env.WECHAT_WEBHOOK_URL?.trim() || '',
    };
    try {
      const saved = JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) as Partial<AutomationSettings>;
      return { ...fallback, ...saved, schedule: fallback.schedule, wechatWebhookUrl: saved.wechatWebhookUrl ?? fallback.wechatWebhookUrl };
    } catch {
      await this.store.initialize();
      await fs.writeFile(this.settingsPath, JSON.stringify(fallback, null, 2));
      return fallback;
    }
  }

  async updateSettings(patch: Partial<Pick<AutomationSettings, 'enabled' | 'browserAutomationEnabled' | 'wechatWebhookUrl'>>) {
    const current = await this.settings();
    const next = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      browserAutomationEnabled: patch.browserAutomationEnabled ?? current.browserAutomationEnabled,
      wechatWebhookUrl: patch.wechatWebhookUrl ?? current.wechatWebhookUrl,
    };
    await fs.writeFile(this.settingsPath, JSON.stringify(next, null, 2));
    return next;
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
    this.currentRun = {
      id,
      reason,
      phase: 'preparing',
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      currentBills: [],
      startedAt: startedAt.toISOString(),
    };
    let backupPath: string | null = null;
    let provider: TrackingProvider | null = null;
    try {
      const settings = await this.settings();
      const { workbook, sheet, headerMap } = await this.store.open();
      const allRecords = this.store.readRecords(sheet, headerMap);
      const records = allRecords.filter(isQueryable);
      this.currentRun.total = records.length;
      this.currentRun.skipped = allRecords.length - records.length;
      backupPath = await this.store.backup(`${reason === 'manual' ? '手动' : '定时'}更新前备份`);
      provider = this.provider(settings);
      const activeProvider = provider;
      const failedDetails: FailedTrackingDetail[] = [];
      let success = 0;
      let unfinished = 0;

      if (!records.length) {
        const finishedAt = new Date();
        const summary: RunSummary = {
          id,
          reason,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          total: 0,
          success: 0,
          unfinished: 0,
          failed: 0,
          skipped: allRecords.length,
          failedBills: [],
          failedDetails: [],
          backupPath,
          notification: 'skipped',
        };
        this.currentRun.phase = 'notifying';
        summary.notification = await notifyWeCom(summary, settings.wechatWebhookUrl);
        await this.saveRun(summary);
        return summary;
      }

      // 创建速率限制器
      const defaultLimit = Number(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE) || 10;
      const rateLimiter = new RateLimiter(defaultLimit);
      const rateLimitedProvider: TrackingProvider = {
        async query(input) {
          await rateLimiter.throttle(input.rule.code);
          return activeProvider.query(input);
        },
      };

      for (const record of records) {
        record.progress = '查询中';
        this.store.writeRecord(sheet, headerMap, record);
      }
      await this.store.save(workbook);
      this.currentRun.phase = 'querying';

      let cursor = 0;
      const worker = async () => {
        while (cursor < records.length) {
          const record = records[cursor++];
          let carrier = record.carrierHint || '未知船司';
          try {
            carrier = resolveCarrierRule(record).name;
          } catch { /* 前缀错误会在查询结果中记录 */ }
          const activeBill = { billNo: record.billNo, carrier };
          this.currentRun?.currentBills.push(activeBill);

          try {
            const { rule, result } = await trackRecord(record, rateLimitedProvider);
            record.carrierHint = rule.name;
            record.arrivalTime = result.arrivalTimeText || result.arrivalTime;
            record.dischargeTime = result.dischargeTimeText || result.dischargeTime;
            record.vesselState = result.dischargeTime || result.dischargeTimeText
              ? '已到港已卸船'
              : result.arrived
                ? '已到港未卸船'
                : '未到港未卸船';
            record.lastUpdated = new Date();
            record.progress = '已完成';
            record.note = `${result.arrivalKind ? `到港字段=${result.arrivalKind}；` : ''}${result.rawSummary}；来源=${result.sourceUrl}${result.evidencePath ? `；成功证据=${result.evidencePath}` : ''}`;
            success += 1;
            if (record.vesselState !== '已到港已卸船') unfinished += 1;
          } catch (error) {
            let carrier = record.carrierHint || '未知船司';
            let carrierCode = 'UNKNOWN';
            let sourceUrl = '';
            try {
              const rule = resolveCarrierRule(record);
              carrier = rule.name;
              carrierCode = rule.code;
              sourceUrl = rule.url;
              record.carrierHint = rule.name;
            } catch { /* 前缀错误由失败原因说明 */ }
            const failure = classifyTrackingError(error);
            const detail: FailedTrackingDetail = {
              carrier,
              carrierCode,
              billNo: record.billNo,
              containerNo: record.containerNo,
              category: failure.category,
              reason: failure.reason,
              sourceUrl: failure.sourceUrl || sourceUrl,
              evidencePath: failure.evidencePath,
            };
            record.lastUpdated = new Date();
            record.progress = '失败';
            record.note = failedNote(detail);
            failedDetails.push(detail);
          }
          this.store.writeRecord(sheet, headerMap, record);
          if (this.currentRun) {
            this.currentRun.completed += 1;
            this.currentRun.success = success;
            this.currentRun.failed = failedDetails.length;
            this.currentRun.currentBills = this.currentRun.currentBills.filter((item) => item !== activeBill);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, records.length) }, () => worker()));
      this.currentRun.phase = 'saving';
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
        failed: failedDetails.length,
        skipped: allRecords.length - records.length,
        failedBills: failedDetails.map((detail) => detail.billNo),
        failedDetails,
        backupPath,
        notification: 'skipped',
      };
      this.currentRun.phase = 'notifying';
      summary.notification = await notifyWeCom(summary, settings.wechatWebhookUrl);
      await this.saveRun(summary);
      return summary;
    } finally {
      try {
        await provider?.close?.();
      } catch (error) {
        console.error('Browser provider close failed:', error instanceof Error ? error.message : error);
      }
      this.running = false;
      this.currentRun = null;
    }
  }

  async status() {
    const workbook = await this.store.metadata();
    const runs = await this.listRuns();
    const settings = await this.settings();
    return {
      running: this.running,
      currentRun: this.currentRun ? { ...this.currentRun, currentBills: [...this.currentRun.currentBills] } : null,
      mode: 'live' as const,
      enabled: settings.enabled,
      browserAutomationEnabled: settings.browserAutomationEnabled,
      workbook,
      schedule: settings.schedule,
      timezone: settings.timezone,
      notificationConfigured: Boolean(settings.wechatWebhookUrl),
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
      let sourceUrl = '';
      let verificationNo = record.billNo;
      try {
        const rule = resolveCarrierRule(record);
        carrier = rule.name;
        carrierCode = rule.code;
        sourceUrl = rule.url;
        verificationNo = rule.code === 'SMLINE' && record.containerNo && record.note.includes('本次通道=柜号')
          ? record.containerNo
          : buildQueryBillNo(record.billNo, rule);
      } catch { /* 错误展示在 Excel 备注中 */ }
      return {
        record: {
          ...record,
          arrivalTime: publicTime(record.arrivalTime),
          dischargeTime: publicTime(record.dischargeTime),
        },
        carrier,
        carrierCode,
        sourceUrl: sourceUrlFromNote(record.note) || sourceUrl,
        evidencePath: evidencePathFromNote(record.note),
        verificationNo,
      };
    });
  }
}
