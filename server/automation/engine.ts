import fs from 'node:fs/promises';
import path from 'node:path';
import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { BrowserTrackingProvider, FallbackTrackingProvider, type BrowserVerificationCallbacks } from './browser.js';
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
import type { AutomationSettings, AutomationTask, AutomationTaskScope, FailedTrackingDetail, ManualMark, QueryProgress, RunProgress, RunSummary, TrackingTime, VesselState, WorkbookRecord } from './types.js';
import { WorkbookStore } from './workbook.js';

function isQueryable(record: WorkbookRecord) {
  return record.manualMark !== '已清关'
    && (!record.vesselState || record.vesselState === '未到港未卸船' || record.vesselState === '已到港未卸船');
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

function routeTextFromNote(note: string) {
  return note.match(/(?:^|；)运行线路=([^；]+)/)?.[1]?.trim() || null;
}

function manualTime(value: unknown): TrackingTime {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('时间必须是文本或空值');
  const normalized = value.trim().replace('T', ' ');
  if (!normalized) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const localValue = /\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
  const withTimezone = hasTimezone ? normalized : `${localValue}+08:00`;
  const parsed = new Date(withTimezone.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) throw new Error(`无法识别时间：${value}`);
  return withTimezone;
}

function manualState(value: unknown): VesselState {
  if (value !== '未到港未卸船' && value !== '已到港未卸船' && value !== '已到港已卸船') {
    throw new Error('船只状态不合法');
  }
  return value;
}

function manualMark(value: unknown): ManualMark {
  if (value === '' || value === '已清关' || value === '查验中' || value === '其他') return value;
  throw new Error('人工标记不合法');
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
  readonly tasksPath: string;
  private browserEvidenceProvider: BrowserTrackingProvider | null = null;
  private verificationSkipRequested = false;

  constructor(store = new WorkbookStore()) {
    this.store = store;
    this.runLogPath = path.join(store.dataDirectory, 'runs.json');
    this.settingsPath = path.join(store.dataDirectory, 'settings.json');
    this.tasksPath = path.join(store.dataDirectory, 'tasks.json');
  }

  get isRunning() {
    return this.running;
  }

  private provider(settings: AutomationSettings): TrackingProvider {
    const verificationCallbacks: BrowserVerificationCallbacks = {
      onRequired: (verification) => {
        this.verificationSkipRequested = false;
        if (this.currentRun) this.currentRun.verification = verification;
      },
      onResolved: () => {
        if (this.currentRun) this.currentRun.verification = undefined;
        this.verificationSkipRequested = false;
      },
      shouldSkip: () => this.verificationSkipRequested,
    };
    const browser = settings.browserAutomationEnabled
      ? new BrowserTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks)
      : null;
    this.browserEvidenceProvider = browser;
    const withBrowserFallback = (primary: TrackingProvider) => browser ? new FallbackTrackingProvider(primary, browser) : primary;
    const hmm = settings.browserAutomationEnabled
      ? new HmmTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks)
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

  skipVerification() {
    if (!this.running || !this.currentRun?.verification) return false;
    this.verificationSkipRequested = true;
    this.currentRun.verification = undefined;
    return true;
  }

  async listRuns(): Promise<RunSummary[]> {
    try {
      const runs = JSON.parse(await fs.readFile(this.runLogPath, 'utf8')) as RunSummary[];
      return runs.map((run) => ({ ...run, failedBills: run.failedBills || [], failedDetails: run.failedDetails || [] }));
    } catch {
      return [];
    }
  }

  async deleteRuns(ids: string[]) {
    const requested = new Set(ids.filter(Boolean));
    const runs = await this.listRuns();
    const kept = runs.filter((run) => !requested.has(run.id));
    await this.store.initialize();
    await fs.writeFile(this.runLogPath, JSON.stringify(kept, null, 2));
    return kept;
  }

  async listTasks(): Promise<AutomationTask[]> {
    try {
      const tasks = JSON.parse(await fs.readFile(this.tasksPath, 'utf8')) as AutomationTask[];
      return Array.isArray(tasks) ? tasks.map((task) => ({ ...task, scheduleTime: task.scheduleTime || null })) : [];
    } catch {
      return [];
    }
  }

  private async saveTasks(tasks: AutomationTask[]) {
    await this.store.initialize();
    await fs.writeFile(this.tasksPath, JSON.stringify(tasks, null, 2));
  }

  async createTask(input: { name: string; scope: AutomationTaskScope; carrierCodes?: string[]; shipmentIds?: string[]; scheduleTime?: string | null }) {
    const name = input.name.trim();
    if (!name) throw new Error('任务名称不能为空');
    if (!['all', 'carrier', 'shipment'].includes(input.scope)) throw new Error('任务范围不合法');
    const carrierCodes = [...new Set((input.carrierCodes || []).map((code) => code.trim().toUpperCase()).filter(Boolean))];
    const shipmentIds = [...new Set((input.shipmentIds || []).map((id) => id.trim()).filter(Boolean))];
    const scheduleTime = input.scheduleTime?.trim() || null;
    if (scheduleTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error('任务时间必须是 HH:mm 格式');
    if (input.scope === 'carrier' && !carrierCodes.length) throw new Error('请选择至少一个船司');
    if (input.scope === 'shipment' && !shipmentIds.length) throw new Error('请选择至少一条船期');
    const now = new Date().toISOString();
    const task: AutomationTask = {
      id: `TASK-${now.replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      scope: input.scope,
      carrierCodes: input.scope === 'carrier' ? carrierCodes : [],
      shipmentIds: input.scope === 'shipment' ? shipmentIds : [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunId: null,
      scheduleTime,
    };
    const tasks = await this.listTasks();
    tasks.push(task);
    await this.saveTasks(tasks);
    return task;
  }

  async deleteTasks(ids: string[]) {
    const requested = new Set(ids.filter(Boolean));
    const tasks = await this.listTasks();
    const kept = tasks.filter((task) => !requested.has(task.id));
    await this.saveTasks(kept);
    return kept;
  }

  async updateTask(id: string, patch: { enabled?: boolean }) {
    const tasks = await this.listTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error('自动化任务不存在');
    tasks[index] = { ...tasks[index], enabled: patch.enabled ?? tasks[index].enabled, updatedAt: new Date().toISOString() };
    await this.saveTasks(tasks);
    return tasks[index];
  }

  async manualAppend(input: { billNo: string; containerNo?: string; carrierHint?: string; arrivalTime?: unknown; dischargeTime?: unknown; vesselState: unknown; note?: string }) {
    if (this.running) throw new Error('自动更新正在执行，请稍后再进行人工补录');
    const billNo = input.billNo.trim().toUpperCase();
    if (!billNo) throw new Error('提单号不能为空');
    const arrivalTime = manualTime(input.arrivalTime);
    const dischargeTime = manualTime(input.dischargeTime);
    const vesselState = manualState(input.vesselState);
    const note = input.note?.trim() ? `人工补录：${input.note.trim()}` : '人工补录数据';
    if (await this.store.exists()) {
      const opened = await this.store.open();
      if (this.store.readRecords(opened.sheet, opened.headerMap).some((record) => record.billNo === billNo)) {
        throw new Error(`提单号已存在：${billNo}`);
      }
    }
    const backupPath = await this.store.backup('人工补录前备份');
    const result = await this.store.appendRecords([{
      billNo,
      containerNo: input.containerNo,
      carrierHint: input.carrierHint,
      arrivalTime,
      dischargeTime,
      vesselState,
      note,
      progress: '已完成',
    }]);
    if (result.duplicates.length) throw new Error(`提单号已存在：${result.duplicates.join('、')}`);
    const addedRecord = result.added[0];
    if (addedRecord) {
      const opened = await this.store.open();
      const records = this.store.readRecords(opened.sheet, opened.headerMap);
      const record = records.find((item) => item.rowNumber === addedRecord.rowNumber);
      if (record) {
        record.lastUpdated = new Date();
        this.store.writeRecord(opened.sheet, opened.headerMap, record);
        await this.store.save(opened.workbook);
      }
    }
    return { ...result, backupPath };
  }

  async manualUpdate(rowNumber: number, input: { arrivalTime?: unknown; dischargeTime?: unknown; vesselState: unknown; note?: string }) {
    if (this.running) throw new Error('自动更新正在执行，请稍后再进行人工补录');
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error('船期记录编号不合法');
    const arrivalTime = manualTime(input.arrivalTime);
    const dischargeTime = manualTime(input.dischargeTime);
    const vesselState = manualState(input.vesselState);
    const opened = await this.store.open();
    const records = this.store.readRecords(opened.sheet, opened.headerMap);
    const record = records.find((item) => item.rowNumber === rowNumber);
    if (!record) throw new Error('找不到对应船期记录');
    const backupPath = await this.store.backup('人工修改前备份');
    record.arrivalTime = arrivalTime;
    record.dischargeTime = dischargeTime;
    record.vesselState = vesselState;
    record.progress = '已完成' as QueryProgress;
    record.lastUpdated = new Date();
    record.note = input.note?.trim()
      ? `人工修改：${input.note.trim()}`
      : `${record.note ? `${record.note}；` : ''}人工修改船期状态`;
    this.store.writeRecord(opened.sheet, opened.headerMap, record);
    await this.store.save(opened.workbook);
    return { record, backupPath };
  }

  async updateManualMark(rowNumber: number, value: unknown) {
    if (this.running) throw new Error('自动更新正在执行，请稍后再修改人工标记');
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error('船期记录编号不合法');
    const opened = await this.store.open();
    const record = this.store.readRecords(opened.sheet, opened.headerMap).find((item) => item.rowNumber === rowNumber);
    if (!record) throw new Error('找不到对应船期记录');
    const nextMark = manualMark(value);
    const backupPath = await this.store.backup('修改人工标记前备份');
    record.manualMark = nextMark;
    this.store.writeRecord(opened.sheet, opened.headerMap, record);
    await this.store.save(opened.workbook);
    return { record, backupPath };
  }

  async deleteShipments(rowNumbers: number[]) {
    if (this.running) throw new Error('自动更新正在执行，请稍后再删除船期记录');
    const backupPath = await this.store.backup('删除船期记录前备份');
    const result = await this.store.deleteRecords(rowNumbers);
    return { ...result, backupPath };
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

  async run(reason: RunSummary['reason'], selection?: { carrierCodes?: string[]; shipmentIds?: string[] }): Promise<RunSummary> {
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
    this.verificationSkipRequested = false;
    let backupPath: string | null = null;
    let provider: TrackingProvider | null = null;
    try {
      const settings = await this.settings();
      const { workbook, sheet, headerMap } = await this.store.open();
      const allRecords = this.store.readRecords(sheet, headerMap);
      const selectedCarrierCodes = selection?.carrierCodes?.length ? new Set(selection.carrierCodes.map((code) => code.toUpperCase())) : null;
      const selectedShipmentIds = selection?.shipmentIds?.length ? new Set(selection.shipmentIds) : null;
      const records = allRecords.filter((record) => {
        if (selectedShipmentIds) {
          const rowId = `XLSX-${record.rowNumber}`;
          if (!selectedShipmentIds.has(rowId) && !selectedShipmentIds.has(record.billNo)) return false;
          // 显式点选更新时，不因“已到港已卸船”等历史状态跳过；仅保留已清关保护。
          if (record.manualMark === '已清关') return false;
        } else if (!isQueryable(record)) {
          return false;
        }
        if (selectedCarrierCodes) {
          try {
            if (!selectedCarrierCodes.has(resolveCarrierRule(record).code)) return false;
          } catch {
            return false;
          }
        }
        return true;
      });
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
            const { rule, result: primaryResult } = await trackRecord(record, rateLimitedProvider);
            let result = primaryResult;
            let evidenceWarning = '';
            // 直连接口成功时仍补做一次浏览器页面采集，确保成功记录也有可复核截图和航线信息。
            if (!result.evidencePath && this.browserEvidenceProvider) {
              try {
                const captured = await trackRecord(record, this.browserEvidenceProvider);
                result = {
                  ...result,
                  evidencePath: captured.result.evidencePath || result.evidencePath,
                  routeText: result.routeText || captured.result.routeText,
                };
                if (!result.evidencePath) evidenceWarning = '；成功页面未生成截图证据';
              } catch (captureError) {
                const captureFailure = classifyTrackingError(captureError);
                evidenceWarning = `；成功页面截图采集失败（${captureFailure.category}）`;
                console.warn(`[AutomationEngine] ${record.billNo} 成功证据采集失败：${captureFailure.reason}`);
              }
            }
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
            record.note = `${result.arrivalKind ? `到港字段=${result.arrivalKind}；` : ''}${result.rawSummary}${result.routeText ? `；运行线路=${result.routeText}` : ''}${evidenceWarning}；来源=${result.sourceUrl}${result.evidencePath ? `；成功证据=${result.evidencePath}` : ''}`;
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
      this.browserEvidenceProvider = null;
      this.verificationSkipRequested = false;
      this.running = false;
      this.currentRun = null;
    }
  }

  async runTask(id: string) {
    const task = (await this.listTasks()).find((item) => item.id === id);
    if (!task) throw new Error('自动化任务不存在');
    if (!task.enabled) throw new Error('自动化任务已停用');
    const selection = task.scope === 'carrier'
      ? { carrierCodes: task.carrierCodes }
      : task.scope === 'shipment'
        ? { shipmentIds: task.shipmentIds }
        : undefined;
    const run = await this.run('manual', selection);
    const tasks = await this.listTasks();
    const index = tasks.findIndex((item) => item.id === id);
    if (index >= 0) {
      tasks[index] = { ...tasks[index], lastRunAt: run.finishedAt, lastRunId: run.id, updatedAt: run.finishedAt };
      await this.saveTasks(tasks);
    }
    return run;
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
        route: routeTextFromNote(record.note),
      };
    });
  }
}
