import fs from 'node:fs/promises';
import path from 'node:path';
import { buildQueryBillNo, resolveCarrierRule } from './carriers.js';
import { createApiEvidence } from './api-evidence.js';
import { BrowserTrackingProvider, FallbackTrackingProvider, type BrowserVerificationCallbacks } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { EvergreenTrackingProvider } from './evergreen.js';
import { MatsonTrackingProvider } from './matson.js';
import { YangmingTrackingProvider } from './yangming.js';
import { WanhaiPatchrightTrackingProvider } from './wanhai-patchright.js';
import { ZimPatchrightTrackingProvider } from './zim-patchright.js';
import { notifyWeCom } from './notifier.js';
import { OoclPatchrightTrackingProvider } from './oocl-patchright.js';
import { OoclTrackingProvider } from './oocl.js';
import { OneTrackingProvider } from './one.js';
import { HedeTrackingProvider } from './hede.js';
import { HmmTrackingProvider } from './hmm.js';
import { parseCmaTrackingText } from './cma.js';
import { parseHapagTrackingText } from './hapag.js';
import { isManualCollectionCarrier } from './manual-collection.js';
import { ClearanceHistoryStore, type ClearanceRetentionDays } from './clearance-history.js';
import { OfficialSiteProbeProvider } from './official-probe.js';
import { SmLineTrackingProvider } from './smline.js';
import { RateLimiter } from './rate-limiter.js';
import { CachedTrackingProvider, CarrierRoutingTrackingProvider, trackRecord, type TrackingProvider } from './tracker.js';
import type { AutomationSettings, AutomationTask, AutomationTaskScope, FailedTrackingDetail, ManualMark, QueryProgress, RunProgress, RunSummary, TrackingTime, VesselState, WorkbookRecord } from './types.js';
import { WorkbookStore } from './workbook.js';
import type { AppDatabase } from '../database.js';
import { safeSourceCode, sourceEvidenceDirectory, sourceEvidenceUrl, sourceTrackingDetailKey, sourceTrackingDetailPath, sourceTrackingDetailUrl } from './source-storage.js';
import { SerialExecutionCoordinator } from './concurrency.js';
import { checkAndPlanCarrierBatches } from './batch-checker.js';
import { ConflictError, NotFoundError, RequestValidationError } from '../validation.js';

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
  return note.match(/(?:^|；)(?:已识别)?运行线路=([^；]+)/)?.[1]?.trim() || null;
}

/**
 * 自动查询失败时不能继续沿用上一次自动查询的时间和船只状态。
 * 否则 Excel 会出现“进度=失败”但仍显示“已到港已卸船”的矛盾组合，
 * 使用者容易把历史值误认为本次已核验结果。人工标记不属于解析结果，
 * 因此保留不动。
 */
function clearAutomaticTrackingResult(record: WorkbookRecord) {
  record.arrivalTime = null;
  record.dischargeTime = null;
  record.vesselState = '';
}

function manualTime(value: unknown): TrackingTime {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new RequestValidationError('时间必须是文本或空值');
  let normalized = value.trim().replace('T', ' ').replace(/\//g, '-');
  if (!normalized) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) normalized = `${normalized} 00:00:00`;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const localValue = /\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
  const withTimezone = hasTimezone ? normalized : `${localValue}+08:00`;
  const parsed = new Date(withTimezone.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) throw new RequestValidationError(`无法识别时间：${value}`);
  return withTimezone;
}

/**
 * Parse a manually entered time as Beijing time when no explicit timezone is
 * present. Excel and browser inputs can use either ISO's `T` separator or a
 * space, and date-only values are treated as 00:00:00 in Asia/Shanghai.
 */
function manualTimeDate(value: TrackingTime): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  let normalized = value.trim().replace('T', ' ').replace(/\//g, '-');
  if (!normalized) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) normalized = `${normalized} 00:00:00`;
  if (/^\d{4}-\d{1,2}-\d{1,2} \d{2}:\d{2}$/.test(normalized)) normalized = `${normalized}:00`;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(`${normalized.replace(' ', 'T')}${hasTimezone ? '' : '+08:00'}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function manualState(value: unknown): VesselState {
  if (value !== '未到港未卸船' && value !== '已到港未卸船' && value !== '已到港已卸船') {
    throw new RequestValidationError('船只状态不合法');
  }
  return value;
}

/**
 * Derive the effective vessel state for manual data.
 *
 * A manually entered future timestamp is a plan, not proof that the event has
 * happened. The backend therefore treats future ATA/ETA and discharge times
 * as pending, using Asia/Shanghai semantics for timezone-less values. An
 * explicitly selected state is retained only when it does not contradict the
 * timestamps; an actual discharge timestamp always wins because discharge
 * implies arrival.
 */
export function deriveManualVesselState(
  arrivalTime: TrackingTime,
  dischargeTime: TrackingTime,
  requestedState: VesselState,
  now = new Date(),
): VesselState {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new Error('当前时间不合法');
  const arrivalMs = manualTimeDate(arrivalTime)?.getTime() ?? null;
  const dischargeMs = manualTimeDate(dischargeTime)?.getTime() ?? null;
  const arrivalReached = arrivalMs !== null && arrivalMs <= nowMs;
  const arrivalFuture = arrivalMs !== null && arrivalMs > nowMs;
  const dischargeReached = dischargeMs !== null && dischargeMs <= nowMs;
  const dischargeFuture = dischargeMs !== null && dischargeMs > nowMs;

  // A completed discharge is definitive, even if an arrival field was entered
  // incorrectly or left blank.
  if (dischargeReached) return '已到港已卸船';
  // A future arrival cannot be shown as arrived, regardless of the selected
  // state or a future discharge estimate.
  if (arrivalFuture) return '未到港未卸船';
  // A future discharge is not completion. It is only "arrived" when the
  // arrival time has already passed.
  if (dischargeFuture) return arrivalReached ? '已到港未卸船' : '未到港未卸船';
  // A reached arrival should be reflected immediately unless the user has
  // explicitly recorded the stronger completed state without a precise time.
  if (arrivalReached) return requestedState === '已到港已卸船' ? '已到港已卸船' : '已到港未卸船';
  // With no time evidence, preserve the user's explicit state.
  return requestedState;
}

function manualMark(value: unknown): ManualMark {
  if (value === '' || value === '已清关' || value === '查验中' || value === '其他') return value;
  throw new RequestValidationError('人工标记不合法');
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

type StoredTrackingDetail = {
  carrierCode: string;
  billNo: string;
  containerNo: string;
  sourceUrl: string;
  capturedAt: string;
  trackingDetail: NonNullable<import('./types.js').TrackingResult['trackingDetail']>;
  rawPageText: string;
};

export function evidencePathFromNote(note: string) {
  return note.match(/(?:^|；)成功证据=(\/api\/browser-evidence\/[^；\s]+)/i)?.[1] || '';
}

export function failureEvidencePathFromNote(note: string) {
  return note.match(/(?:^|；)浏览器证据=(\/api\/browser-evidence\/[^；\s]+)/i)?.[1] || '';
}

function trackingMomentIdentity(value: TrackingTime) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  const numeric = value.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (numeric) {
    const [, year, month, day, hour, minute, second = '00'] = numeric;
    return [year, month.padStart(2, '0'), day.padStart(2, '0'), hour.padStart(2, '0'), minute, second].join('-');
  }
  return value.trim();
}

function isSuspiciousArrivalAsDischarge(arrival: TrackingTime, discharge: TrackingTime) {
  const arrivalIdentity = trackingMomentIdentity(arrival);
  return Boolean(arrivalIdentity && arrivalIdentity === trackingMomentIdentity(discharge));
}

export class AutomationEngine {
  private running = false;
  private processingQueue = false;
  private readonly runQueue: Array<{
    reason: RunSummary['reason'];
    selection?: { carrierCodes?: string[]; shipmentIds?: string[]; skipCompleted?: boolean };
    resolve: (summary: RunSummary) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly idempotentRuns = new Map<string, { createdAt: number; promise: Promise<RunSummary> }>();
  private readonly idempotentTaskRuns = new Map<string, { createdAt: number; promise: Promise<RunSummary> }>();
  private currentRun: RunProgress | null = null;
  readonly store: WorkbookStore;
  readonly runLogPath: string;
  readonly settingsPath: string;
  readonly tasksPath: string;
  readonly clearanceHistory: ClearanceHistoryStore;
  private browserEvidenceProvider: BrowserTrackingProvider | null = null;
  private verificationSkipRequested = false;
  private readonly database?: AppDatabase;
  /** PostgreSQL namespace for this Excel workspace (admin or user-<id>). */
  readonly workspaceId: string;
  private readonly defaultWechatWebhookUrl?: string;
  private readonly runCoordinator: SerialExecutionCoordinator;
  private waitingForRunCoordinator = false;

  constructor(store = new WorkbookStore(), database?: AppDatabase, options?: { defaultWechatWebhookUrl?: string; runCoordinator?: SerialExecutionCoordinator; workspaceId?: string }) {
    this.store = store;
    this.database = database?.enabled ? database : undefined;
    const workspaceId = options?.workspaceId?.trim() || 'admin';
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId)) throw new Error('工作区编号不合法');
    this.workspaceId = workspaceId;
    this.defaultWechatWebhookUrl = options?.defaultWechatWebhookUrl;
    this.runCoordinator = options?.runCoordinator || new SerialExecutionCoordinator();
    this.runLogPath = path.join(store.dataDirectory, 'runs.json');
    this.settingsPath = path.join(store.dataDirectory, 'settings.json');
    this.tasksPath = path.join(store.dataDirectory, 'tasks.json');
    this.clearanceHistory = new ClearanceHistoryStore(store.dataDirectory);
  }

  get isRunning() {
    return this.running;
  }

  get queuedRuns() {
    return this.runQueue.length + (this.waitingForRunCoordinator ? 1 : 0);
  }

  withWorkspaceWrite<T>(task: () => Promise<T>) {
    return this.store.withWriteLock(task);
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
    const oocl = settings.browserAutomationEnabled
      ? new FallbackTrackingProvider(
        new OoclTrackingProvider(),
        new OoclPatchrightTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks),
      )
      : new OoclTrackingProvider();
    const wanhai = settings.browserAutomationEnabled
      ? new FallbackTrackingProvider(
        new OfficialSiteProbeProvider(),
        new WanhaiPatchrightTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks),
      )
      : new OfficialSiteProbeProvider();
    // 以星的动态页面通常无法通过无 Cookie 的普通 HTTP 预请求得到结果。
    // 新电脑首次运行时，这个匿名预请求反而会先触发风控，再让浏览器会话
    // 接手。启用浏览器自动化后直接使用持久化 Patchright 会话，减少一次
    // 无效访问，并让人工验证 Cookie 留在同一个本地 Profile 中。
    const zim = settings.browserAutomationEnabled
      ? new ZimPatchrightTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks)
      : new OfficialSiteProbeProvider();
    // CMA and Hapag-Lloyd trigger managed challenges as soon as an automated
    // browser profile opens. They deliberately use the ordinary-browser
    // extension flow instead, so an automation run must never launch Chrome
    // for these two carriers.
    const manualBrowserOnly: TrackingProvider = {
      async query(input) {
        throw trackingError(
          '验证码或风控',
          `${input.rule.name}已改用普通浏览器扩展采集，请在该单号详情中点击“普通浏览器采集”`,
          { sourceUrl: input.rule.url },
        );
      },
    };
    const hmmPrimary = settings.browserAutomationEnabled
      ? new HmmTrackingProvider(this.store.dataDirectory, undefined, verificationCallbacks)
      : new OfficialSiteProbeProvider();
    const hmm = browser && settings.browserAutomationEnabled
      ? new FallbackTrackingProvider(hmmPrimary, browser)
      : hmmPrimary;
    return new CarrierRoutingTrackingProvider(new Map<string, TrackingProvider>([
      ['OOCL', oocl],
      ['WANHAI', wanhai],
      ['ZIM', zim],
      ['HAPAG', manualBrowserOnly],
      ['CMA', manualBrowserOnly],
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

  /** 将 Excel 当前记录镜像到 PostgreSQL；Excel 仍保留为导入/导出文件。 */
  async syncDatabaseFromWorkbook() {
    if (!this.database || !(await this.store.exists())) return;
    const { sheet, headerMap } = await this.store.open();
    const records = this.store.readRecords(sheet, headerMap);
    await this.database.transaction(async (client) => {
      await client.query('DELETE FROM shipments WHERE workspace_id = $1', [this.workspaceId]);
      for (const record of records) {
        await client.query(
          `INSERT INTO shipments (workspace_id, source_row, carrier_hint, bill_no, container_no, arrival_time, discharge_time, vessel_state, manual_mark, last_updated, note, progress, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [this.workspaceId, record.rowNumber, record.carrierHint, record.billNo, record.containerNo, publicTime(record.arrivalTime), publicTime(record.dischargeTime), record.vesselState, record.manualMark, record.lastUpdated, record.note, record.progress],
        );
      }
    });
  }

  private trackingDetailKey(record: WorkbookRecord) {
    return sourceTrackingDetailKey(record.billNo, record.containerNo);
  }

  private async saveTrackingDetail(record: WorkbookRecord, result: import('./types.js').TrackingResult) {
    const detail = result.trackingDetail;
    if (!detail || !result.rawPageText) return null;
    const carrierCode = safeSourceCode(detail.carrierCode);
    const key = this.trackingDetailKey(record);
    const filePath = sourceTrackingDetailPath(this.store.dataDirectory, carrierCode, key);
    const stored: StoredTrackingDetail = {
      carrierCode,
      billNo: record.billNo,
      containerNo: record.containerNo,
      sourceUrl: result.sourceUrl,
      capturedAt: detail.capturedAt,
      trackingDetail: detail,
      rawPageText: result.rawPageText,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeJsonAtomic(filePath, stored);
    return sourceTrackingDetailUrl(carrierCode, key);
  }

  private async removeTrackingDetail(record: WorkbookRecord, carrierCode?: string) {
    const code = carrierCode || (() => {
      try { return resolveCarrierRule(record).code; } catch { return ''; }
    })();
    if (!code) return;
    const filePath = sourceTrackingDetailPath(this.store.dataDirectory, code, this.trackingDetailKey(record));
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }

  async readTrackingDetail(carrierCode: string, fileName: string) {
    const code = safeSourceCode(carrierCode);
    const expectedCarrier = code === carrierCode.trim().toUpperCase();
    const safeName = path.basename(fileName);
    if (!expectedCarrier || safeName !== fileName || !/\.json$/i.test(safeName)) throw new RequestValidationError('轨迹详情路径不合法');
    const filePath = sourceTrackingDetailPath(this.store.dataDirectory, code, safeName.replace(/\.json$/i, ''));
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as StoredTrackingDetail;
  }

  async listRuns(): Promise<RunSummary[]> {
    if (this.database) {
      const result = await this.database.query<{ payload: RunSummary }>('SELECT payload FROM automation_runs WHERE workspace_id = $1 ORDER BY finished_at DESC LIMIT 30', [this.workspaceId]);
      if (result.rows.length) {
        return result.rows.map(({ payload }) => ({ ...payload, failedBills: payload.failedBills || [], failedDetails: payload.failedDetails || [] }));
      }
      // 首次启用数据库时，将已有本地运行记录导入数据库。
    }
    try {
      const runs = JSON.parse(await fs.readFile(this.runLogPath, 'utf8')) as RunSummary[];
      const normalized = runs.map((run) => ({ ...run, failedBills: run.failedBills || [], failedDetails: run.failedDetails || [] }));
      if (this.database && normalized.length) {
        await this.database.transaction(async (client) => {
          for (const run of normalized.slice(0, 30)) {
            await client.query(
              `INSERT INTO automation_runs (id, workspace_id, payload, started_at, finished_at) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (id) DO NOTHING`,
              [run.id, this.workspaceId, JSON.stringify(run), run.startedAt, run.finishedAt],
            );
          }
        });
      }
      return normalized;
    } catch {
      return [];
    }
  }

  async deleteRuns(ids: string[]) {
    return this.withWorkspaceWrite(async () => {
    const requested = new Set(ids.filter(Boolean));
    if (this.database && requested.size) {
      await this.database.query('DELETE FROM automation_runs WHERE workspace_id = $1 AND id = ANY($2::text[])', [this.workspaceId, [...requested]]);
      return this.listRuns();
    }
    const runs = await this.listRuns();
    const kept = runs.filter((run) => !requested.has(run.id));
    await this.store.initialize();
    await writeJsonAtomic(this.runLogPath, kept);
    return kept;
    });
  }

  async listTasks(): Promise<AutomationTask[]> {
    if (this.database) {
      const result = await this.database.query<{ payload: AutomationTask }>('SELECT payload FROM automation_tasks WHERE workspace_id = $1 ORDER BY created_at', [this.workspaceId]);
      if (result.rows.length) return result.rows.map(({ payload }) => ({ ...payload, scheduleTime: payload.scheduleTime || null }));
    }
    try {
      const tasks = JSON.parse(await fs.readFile(this.tasksPath, 'utf8')) as AutomationTask[];
      const normalized = Array.isArray(tasks) ? tasks.map((task) => ({ ...task, scheduleTime: task.scheduleTime || null })) : [];
      if (this.database && normalized.length) await this.saveTasks(normalized);
      return normalized;
    } catch {
      return [];
    }
  }

  private async saveTasks(tasks: AutomationTask[]) {
    await this.store.initialize();
    await writeJsonAtomic(this.tasksPath, tasks);
    if (this.database) {
      await this.database.transaction(async (client) => {
        await client.query('DELETE FROM automation_tasks WHERE workspace_id = $1', [this.workspaceId]);
        for (const task of tasks) {
          await client.query(
            `INSERT INTO automation_tasks (id, workspace_id, payload, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5)`,
            [task.id, this.workspaceId, JSON.stringify(task), task.createdAt, task.updatedAt],
          );
        }
      });
    }
  }

  async createTask(input: { name: string; scope: AutomationTaskScope; carrierCodes?: string[]; shipmentIds?: string[]; scheduleTime?: string | null }) {
    return this.withWorkspaceWrite(async () => {
    const name = input.name.trim();
    if (!name) throw new RequestValidationError('任务名称不能为空');
    if (name.length > 80) throw new RequestValidationError('任务名称不能超过 80 个字符');
    if (!['all', 'carrier', 'shipment'].includes(input.scope)) throw new RequestValidationError('任务范围不合法');
    const carrierCodes = [...new Set((input.carrierCodes || []).map((code) => code.trim().toUpperCase()).filter(Boolean))];
    const shipmentIds = [...new Set((input.shipmentIds || []).map((id) => id.trim()).filter(Boolean))];
    if (carrierCodes.length > 15 || shipmentIds.length > 200) throw new RequestValidationError('任务选择数量超过限制');
    const scheduleTime = input.scheduleTime?.trim() || null;
    if (scheduleTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new RequestValidationError('任务时间必须是 HH:mm 格式');
    if (input.scope === 'carrier' && !carrierCodes.length) throw new RequestValidationError('请选择至少一个船司');
    if (input.scope === 'shipment' && !shipmentIds.length) throw new RequestValidationError('请选择至少一条船期');
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
    });
  }

  async deleteTasks(ids: string[]) {
    return this.withWorkspaceWrite(async () => {
    const requested = new Set(ids.filter(Boolean));
    const tasks = await this.listTasks();
    const kept = tasks.filter((task) => !requested.has(task.id));
    await this.saveTasks(kept);
    return kept;
    });
  }

  async updateTask(id: string, patch: { enabled?: boolean }) {
    return this.withWorkspaceWrite(async () => {
    const tasks = await this.listTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new NotFoundError('自动化任务不存在');
    tasks[index] = { ...tasks[index], enabled: patch.enabled ?? tasks[index].enabled, updatedAt: new Date().toISOString() };
    await this.saveTasks(tasks);
    return tasks[index];
    });
  }

  async manualAppend(input: { billNo: string; containerNo?: string; carrierHint?: string; arrivalTime?: unknown; dischargeTime?: unknown; vesselState: unknown; note?: string }) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请稍后再进行人工补录');
    const billNo = input.billNo.trim().toUpperCase();
    if (!billNo) throw new RequestValidationError('提单号不能为空');
    if (billNo.length > 64) throw new RequestValidationError('提单号不能超过 64 个字符');
    if ((input.containerNo || '').length > 32) throw new RequestValidationError('柜号不能超过 32 个字符');
    if ((input.carrierHint || '').length > 40) throw new RequestValidationError('船司备注不能超过 40 个字符');
    if ((input.note || '').length > 1000) throw new RequestValidationError('备注不能超过 1000 个字符');
    const arrivalTime = manualTime(input.arrivalTime);
    const dischargeTime = manualTime(input.dischargeTime);
    const vesselState = deriveManualVesselState(arrivalTime, dischargeTime, manualState(input.vesselState));
    const note = input.note?.trim() ? `人工补录：${input.note.trim()}` : '人工补录数据';
    if (await this.store.exists()) {
      const opened = await this.store.open();
      if (this.store.readRecords(opened.sheet, opened.headerMap).some((record) => record.billNo === billNo)) {
        throw new ConflictError(`提单号已存在：${billNo}`);
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
    if (result.duplicates.length) throw new ConflictError(`提单号已存在：${result.duplicates.join('、')}`);
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
    await this.syncDatabaseFromWorkbook();
    return { ...result, backupPath };
    });
  }

  async manualUpdate(rowNumber: number, input: { arrivalTime?: unknown; dischargeTime?: unknown; vesselState: unknown; note?: string }) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请稍后再进行人工补录');
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new RequestValidationError('船期记录编号不合法');
    const arrivalTime = manualTime(input.arrivalTime);
    const dischargeTime = manualTime(input.dischargeTime);
    const vesselState = deriveManualVesselState(arrivalTime, dischargeTime, manualState(input.vesselState));
    if ((input.note || '').length > 1000) throw new RequestValidationError('备注不能超过 1000 个字符');
    const opened = await this.store.open();
    const records = this.store.readRecords(opened.sheet, opened.headerMap);
    const record = records.find((item) => item.rowNumber === rowNumber);
    if (!record) throw new NotFoundError('找不到对应船期记录');
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
    await this.syncDatabaseFromWorkbook();
    return { record, backupPath };
    });
  }

  /**
   * Apply a page collected from the user's ordinary Chrome/Edge tab.
   * CMA and Hapag-Lloyd are deliberately handled here instead of launching
   * Patchright, because their managed challenge is triggered before a query
   * form is rendered in automated profiles.
   */
  async applyManualBrowserCapture(rowNumber: number, input: {
    queryType: 'bill' | 'container';
    pageUrl: string;
    pageText: string;
    screenshot?: Buffer;
  }) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请等待当前任务完成');
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new RequestValidationError('船期记录编号不合法');
    if (!input.pageText.trim()) throw new RequestValidationError('采集页面没有可解析的文字内容');
    const opened = await this.store.open();
    const record = this.store.readRecords(opened.sheet, opened.headerMap).find((item) => item.rowNumber === rowNumber);
    if (!record) throw new NotFoundError('找不到对应船期记录');
    const rule = resolveCarrierRule(record);
    if (rule.code !== 'CMA' && rule.code !== 'HAPAG') throw new RequestValidationError('普通浏览器采集目前仅支持达飞和赫伯罗特');
    const query: import('./types.js').TrackingQuery = {
      rule,
      originalBillNo: record.billNo,
      queryBillNo: buildQueryBillNo(record.billNo, rule),
      containerNo: record.containerNo,
      queryType: input.queryType,
    };
    let evidencePath: string | undefined;
    if (input.screenshot?.length) {
      const reference = safeSourceCode(`${record.billNo}_${record.containerNo || input.queryType}`).slice(0, 80);
      const baseName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${rule.code}_${reference}_manual`;
      const directory = sourceEvidenceDirectory(this.store.dataDirectory, rule.code);
      await fs.mkdir(directory, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(directory, `${baseName}.png`), input.screenshot, { mode: 0o600 }),
        fs.writeFile(path.join(directory, `${baseName}.txt`), input.pageText.slice(0, 4 * 1024 * 1024), { mode: 0o600 }),
      ]);
      evidencePath = sourceEvidenceUrl(rule.code, `${baseName}.png`);
    }
    let parsed: import('./types.js').TrackingResult;
    try {
      parsed = rule.code === 'CMA'
        ? parseCmaTrackingText(input.pageText, query)
        : parseHapagTrackingText(input.pageText, query);
    } catch (error) {
      const failure = classifyTrackingError(error);
      throw trackingError(failure.category, failure.reason, { evidencePath, sourceUrl: input.pageUrl });
    }
    let result: import('./types.js').TrackingResult = {
      ...parsed,
      sourceUrl: input.pageUrl,
      rawPageText: input.pageText,
      rawSummary: `${parsed.rawSummary}；普通浏览器人工采集` ,
      evidencePath,
    };
    const backupPath = await this.store.backup('普通浏览器采集前备份');
    const previousArrival = record.arrivalTime;
    const previousDischarge = record.dischargeTime;
    record.carrierHint = rule.name;
    record.arrivalTime = result.arrivalTimeText || result.arrivalTime;
    const canPreservePreviousDischarge = Boolean(result.discharged && previousDischarge && !isSuspiciousArrivalAsDischarge(previousArrival, previousDischarge));
    record.dischargeTime = result.dischargeTimeText || result.dischargeTime || (canPreservePreviousDischarge ? previousDischarge : null);
    record.vesselState = result.discharged || result.dischargeTime || result.dischargeTimeText
      ? '已到港已卸船'
      : result.arrived
        ? '已到港未卸船'
        : '未到港未卸船';
    record.lastUpdated = new Date();
    record.progress = '已完成';
    const routeSummary = result.routeText ? `；运行线路=${result.routeText}` : '';
    record.note = `${result.arrivalKind ? `到港字段=${result.arrivalKind}；` : ''}${result.rawSummary}${routeSummary}；来源=${result.sourceUrl}${result.evidencePath ? `；成功证据=${result.evidencePath}` : ''}`;
    this.store.writeRecord(opened.sheet, opened.headerMap, record);
    try {
      await this.removeTrackingDetail(record, rule.code);
      if (result.trackingDetail && result.rawPageText) await this.saveTrackingDetail(record, result);
    } catch (error) {
      console.warn(`[AutomationEngine] ${record.billNo} 普通浏览器采集详情保存失败：`, error);
    }
    await this.store.save(opened.workbook);
    await this.syncDatabaseFromWorkbook();
    return { record, result, backupPath };
    });
  }

  async updateManualMark(rowNumber: number, value: unknown, expected?: { billNo: string; containerNo: string }) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请稍后再修改人工标记');
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new RequestValidationError('船期记录编号不合法');
    const opened = await this.store.open();
    const record = this.store.readRecords(opened.sheet, opened.headerMap).find((item) => item.rowNumber === rowNumber);
    if (!record) throw new NotFoundError('找不到对应船期记录');
    if (expected && (record.billNo !== expected.billNo.trim().toUpperCase() || record.containerNo !== expected.containerNo.trim().toUpperCase())) {
      throw new ConflictError('船期记录已发生变化，请刷新页面后重试');
    }
    const nextMark = manualMark(value);
    const backupPath = await this.store.backup(nextMark === '已清关' ? '归档已清关记录前备份' : '修改人工标记前备份');
    if (nextMark === '已清关') {
      if (!backupPath) throw new ConflictError('当前 Excel 不存在，无法归档清关记录');
      let historyEntry: Awaited<ReturnType<ClearanceHistoryStore['archive']>> | null = null;
      try {
        historyEntry = await this.clearanceHistory.archive(record);
        await this.store.archiveRecord(rowNumber, historyEntry.id);
        await this.syncDatabaseFromWorkbook().catch((error) => console.warn('[AutomationEngine] 清关归档后 PostgreSQL 镜像同步失败：', error));
        return { record, historyEntry, archived: true, backupPath };
      } catch (error) {
        if (historyEntry) await this.clearanceHistory.remove([historyEntry.id]).catch(() => undefined);
        await fs.copyFile(backupPath, this.store.currentPath).catch(() => undefined);
        throw error;
      }
    }
    record.manualMark = nextMark;
    this.store.writeRecord(opened.sheet, opened.headerMap, record);
    await this.store.save(opened.workbook);
    await this.syncDatabaseFromWorkbook();
    return { record, archived: false, backupPath };
    });
  }

  async listClearanceHistory() {
    return this.clearanceHistory.snapshot();
  }

  async migrateClearedRecordsToHistory() {
    return this.withWorkspaceWrite(async () => {
    if (this.running || !(await this.store.exists())) return { migrated: 0 };
    const opened = await this.store.open();
    const cleared = this.store.readRecords(opened.sheet, opened.headerMap).filter((record) => record.manualMark === '已清关');
    if (!cleared.length) return { migrated: 0 };
    const backupPath = await this.store.backup('迁移旧版已清关记录前备份');
    if (!backupPath) throw new ConflictError('当前 Excel 不存在，无法迁移已清关记录');
    const existing = await this.clearanceHistory.snapshot();
    const createdIds: string[] = [];
    try {
      for (const record of cleared) {
        let historyEntry = existing.entries.find((entry) => entry.billNo === record.billNo && entry.containerNo === record.containerNo);
        if (!historyEntry) {
          historyEntry = await this.clearanceHistory.archive(record);
          createdIds.push(historyEntry.id);
          existing.entries.push(historyEntry);
        }
        await this.store.archiveRecord(record.rowNumber, historyEntry.id);
      }
      await this.syncDatabaseFromWorkbook().catch((error) => console.warn('[AutomationEngine] 旧版清关记录迁移后 PostgreSQL 镜像同步失败：', error));
      return { migrated: cleared.length, backupPath };
    } catch (error) {
      if (createdIds.length) await this.clearanceHistory.remove(createdIds).catch(() => undefined);
      await fs.copyFile(backupPath, this.store.currentPath).catch(() => undefined);
      throw error;
    }
    });
  }

  async setClearanceRetentionDays(retentionDays: ClearanceRetentionDays) {
    return this.withWorkspaceWrite(async () => {
    await this.clearanceHistory.setRetentionDays(retentionDays);
    await this.clearanceHistory.cleanupExpired();
    return this.clearanceHistory.snapshot();
    });
  }

  async cleanupClearanceHistory(now = new Date()) {
    return this.withWorkspaceWrite(async () => {
    const deleted = await this.clearanceHistory.cleanupExpired(now);
    return { deleted, history: await this.clearanceHistory.snapshot() };
    });
  }

  async deleteClearanceHistory(ids: string[]) {
    return this.withWorkspaceWrite(async () => {
    const deleted = await this.clearanceHistory.remove(ids);
    return { deleted, history: await this.clearanceHistory.snapshot() };
    });
  }

  async restoreClearanceHistory(id: string) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请稍后再恢复历史记录');
    const history = await this.clearanceHistory.snapshot();
    const entry = history.entries.find((item) => item.id === id);
    if (!entry) throw new NotFoundError('找不到对应清关历史记录');
    const backupPath = await this.store.backup('恢复清关历史前备份');
    if (!backupPath) throw new ConflictError('当前 Excel 不存在，无法恢复历史记录');
    const restored = await this.store.restoreRecord({
      carrierHint: entry.carrierHint,
      billNo: entry.billNo,
      containerNo: entry.containerNo,
      arrivalTime: entry.arrivalTime,
      dischargeTime: entry.dischargeTime,
      vesselState: entry.vesselState,
      manualMark: '',
      lastUpdated: entry.lastUpdated ? new Date(entry.lastUpdated) : null,
      note: entry.note,
      progress: entry.progress,
    }, { preferredRowNumber: entry.originalRowNumber, historyId: entry.id });
    try {
      const deleted = await this.clearanceHistory.remove([id]);
      if (deleted !== 1) throw new ConflictError('清关历史记录状态已变化，请刷新后重试');
      await this.syncDatabaseFromWorkbook().catch((error) => console.warn('[AutomationEngine] 清关历史恢复后 PostgreSQL 镜像同步失败：', error));
      return { record: restored, backupPath, history: await this.clearanceHistory.snapshot() };
    } catch (error) {
      await fs.copyFile(backupPath, this.store.currentPath).catch(() => undefined);
      throw error;
    }
    });
  }

  async deleteShipments(rowNumbers: number[]) {
    return this.withWorkspaceWrite(async () => {
    if (this.running) throw new ConflictError('自动更新正在执行，请稍后再删除船期记录');
    const opened = await this.store.open();
    const targets = this.store.readRecords(opened.sheet, opened.headerMap).filter((record) => rowNumbers.includes(record.rowNumber));
    const backupPath = await this.store.backup('删除船期记录前备份');
    const result = await this.store.deleteRecords(rowNumbers);
    await Promise.all(targets.map((record) => this.removeTrackingDetail(record)));
    await this.syncDatabaseFromWorkbook();
    return { ...result, backupPath };
    });
  }

  async settings(): Promise<AutomationSettings> {
    const fallback: AutomationSettings = {
      enabled: true,
      browserAutomationEnabled: true,
      schedule: [],
      timezone: 'Asia/Shanghai',
      wechatWebhookUrl: this.defaultWechatWebhookUrl ?? (process.env.WECHAT_WEBHOOK_URL?.trim() || ''),
    };
    if (this.database) {
      const result = await this.database.query<{ payload: AutomationSettings }>('SELECT payload FROM automation_settings WHERE workspace_id = $1 AND id = 1', [this.workspaceId]);
      if (result.rows[0]?.payload) return { ...fallback, ...result.rows[0].payload, schedule: [], wechatWebhookUrl: result.rows[0].payload.wechatWebhookUrl ?? fallback.wechatWebhookUrl };
    }
    try {
      const saved = JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) as Partial<AutomationSettings>;
      const normalized = { ...fallback, ...saved, schedule: [], wechatWebhookUrl: saved.wechatWebhookUrl ?? fallback.wechatWebhookUrl };
      if (this.database) await this.saveSettings(normalized);
      return normalized;
    } catch {
      await this.store.initialize();
      await writeJsonAtomic(this.settingsPath, fallback);
      if (this.database) await this.saveSettings(fallback);
      return fallback;
    }
  }

  private async saveSettings(settings: AutomationSettings) {
    await this.store.initialize();
    await writeJsonAtomic(this.settingsPath, settings);
    if (this.database) {
      await this.database.query(
        `INSERT INTO automation_settings (workspace_id, id, payload, updated_at) VALUES ($1, 1, $2::jsonb, NOW())
         ON CONFLICT (workspace_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [this.workspaceId, JSON.stringify(settings)],
      );
    }
  }

  async updateSettings(patch: Partial<Pick<AutomationSettings, 'enabled' | 'browserAutomationEnabled' | 'wechatWebhookUrl'>>) {
    return this.withWorkspaceWrite(async () => {
    const current = await this.settings();
    const next = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      browserAutomationEnabled: patch.browserAutomationEnabled ?? current.browserAutomationEnabled,
      wechatWebhookUrl: patch.wechatWebhookUrl ?? current.wechatWebhookUrl,
    };
    await this.saveSettings(next);
    return next;
    });
  }

  private async saveRun(summary: RunSummary) {
    await this.store.initialize();
    if (this.database) {
      await this.database.query(
        `INSERT INTO automation_runs (id, workspace_id, payload, started_at, finished_at) VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, finished_at = EXCLUDED.finished_at`,
        [summary.id, this.workspaceId, JSON.stringify(summary), summary.startedAt, summary.finishedAt],
      );
      await this.database.query(`DELETE FROM automation_runs WHERE workspace_id = $1 AND id NOT IN (SELECT id FROM automation_runs WHERE workspace_id = $1 ORDER BY finished_at DESC LIMIT 30)`, [this.workspaceId]);
      const runs = await this.listRuns();
      await writeJsonAtomic(this.runLogPath, runs);
      return;
    }
    const runs = await this.listRuns();
    await writeJsonAtomic(this.runLogPath, [summary, ...runs].slice(0, 30));
  }

  private async executeRun(reason: RunSummary['reason'], selection?: { carrierCodes?: string[]; shipmentIds?: string[]; skipCompleted?: boolean }): Promise<RunSummary> {
    if (this.running) throw new ConflictError('已有更新任务正在执行');
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
      await this.syncDatabaseFromWorkbook();
      const selectedCarrierCodes = selection?.carrierCodes?.length ? new Set(selection.carrierCodes.map((code) => code.toUpperCase())) : null;
      const selectedShipmentIds = selection?.shipmentIds?.length ? new Set(selection.shipmentIds) : null;
      const skipCompleted = selection?.skipCompleted !== false;
      const records = allRecords.filter((record) => {
        if (selectedShipmentIds) {
          const rowId = `XLSX-${record.rowNumber}`;
          if (!selectedShipmentIds.has(rowId) && !selectedShipmentIds.has(record.billNo)) return false;
          // 显式点选更新时，不因“已到港已卸船”等历史状态跳过；仅保留已清关保护。
          if (record.manualMark === '已清关') return false;
        } else if (skipCompleted ? !isQueryable(record) : record.manualMark === '已清关') {
          return false;
        }
        if (selectedCarrierCodes) {
          try {
            if (!selectedCarrierCodes.has(resolveCarrierRule(record).code)) return false;
          } catch {
            return false;
          }
        }
        // These records are collected from a user-controlled ordinary browser
        // tab. Skipping them here prevents scheduled/full syncs from launching
        // an automated Chrome or erasing a previously verified manual result.
        try {
          if (isManualCollectionCarrier(resolveCarrierRule(record).code)) return false;
        } catch { /* unsupported prefixes are still reported by the normal run */ }
        return true;
      });
      this.currentRun.total = records.length;
      this.currentRun.skipped = allRecords.length - records.length;
      backupPath = await this.store.backup(`${reason === 'manual' ? '手动' : '定时'}更新前备份`);
      provider = this.provider(settings);
      const activeProvider = new CachedTrackingProvider(provider);
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
      const batchPlan = checkAndPlanCarrierBatches(records);

      for (const record of records) {
        record.progress = '查询中';
        this.store.writeRecord(sheet, headerMap, record);
      }
      await this.store.save(workbook);
      await this.syncDatabaseFromWorkbook();
      this.currentRun.phase = 'querying';
      const carrierCircuitBreakers = new Map<string, FailedTrackingDetail>();

      const worker = async () => {
        // 按船司集中处理，保证同一 Provider 的页面、Cookie、接口会话和
        // 后续缓存可以连续复用；每条记录仍按行号写回，不改变工作表顺序。
        for (const batch of batchPlan.batches) {
          for (const record of batch.records) {
          let carrier = record.carrierHint || '未知船司';
          try {
            carrier = resolveCarrierRule(record).name;
          } catch { /* 前缀错误会在查询结果中记录 */ }

          const batchCarrierCode = batch.rule?.code;
          const circuit = batchCarrierCode ? carrierCircuitBreakers.get(batchCarrierCode) : undefined;
          if (circuit && batchCarrierCode) {
            const detail: FailedTrackingDetail = {
              carrier,
              carrierCode: batchCarrierCode,
              billNo: record.billNo,
              containerNo: record.containerNo,
              category: '验证码或风控',
              reason: `同一批次的上一条${carrier}记录已触发验证或风控，剩余订单已暂停；请完成验证后重新执行该船司任务`,
              sourceUrl: circuit.sourceUrl,
            };
            clearAutomaticTrackingResult(record);
            await this.removeTrackingDetail(record, detail.carrierCode);
            record.lastUpdated = new Date();
            record.progress = '失败';
            record.note = failedNote(detail);
            failedDetails.push(detail);
            this.store.writeRecord(sheet, headerMap, record);
            if (this.currentRun) {
              this.currentRun.completed += 1;
              this.currentRun.failed = failedDetails.length;
            }
            continue;
          }
          const activeBill = { billNo: record.billNo, carrier };
          this.currentRun?.currentBills.push(activeBill);

          try {
            const previouslyVerifiedArrival = record.arrivalTime;
            const previouslyVerifiedDischarge = record.dischargeTime;
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
                  trackingDetail: captured.result.trackingDetail || result.trackingDetail,
                  rawPageText: captured.result.rawPageText || result.rawPageText,
                };
                if (!result.evidencePath) evidenceWarning = '；成功页面未生成截图证据';
              } catch (captureError) {
                const captureFailure = classifyTrackingError(captureError);
                evidenceWarning = `；成功页面截图采集失败（${captureFailure.category}）`;
                console.warn(`[AutomationEngine] ${record.billNo} 成功证据采集失败：${captureFailure.reason}`);
              }
            }
            // 官网页面无法截图（例如官网维护），但官方接口已经返回可核验数据时，
            // 仍生成带来源域名和原始响应哈希的视觉凭证。凭证会明确标注并非网页截图。
            if (!result.evidencePath) {
              try {
                result = { ...result, evidencePath: await createApiEvidence(this.store.dataDirectory, record, rule, result) };
                evidenceWarning = evidenceWarning
                  ? '；官网成功页截图不可用，已保存官方接口采集凭证'
                  : '；已保存官方接口采集凭证';
              } catch (apiEvidenceError) {
                evidenceWarning = '；采集证据保存失败，请查看后端日志';
                console.warn(`[AutomationEngine] ${record.billNo} 官方接口凭证保存失败：`, apiEvidenceError);
              }
            }
            record.carrierHint = rule.name;
            record.arrivalTime = result.arrivalTimeText || result.arrivalTime;
            // 一些官网摘要只返回“已提货/已配送”等最新事件，会覆盖此前返回过的
            // 精确卸船时刻。只要最新结果仍明确确认已卸船，就保留上一次官网已核验
            // 的卸船时间，避免一次更新把真实历史事件降级为“未卸船”。
            const canPreservePreviousDischarge = result.discharged
              && previouslyVerifiedDischarge
              && !isSuspiciousArrivalAsDischarge(previouslyVerifiedArrival, previouslyVerifiedDischarge);
            record.dischargeTime = result.dischargeTimeText || result.dischargeTime
              || (canPreservePreviousDischarge ? previouslyVerifiedDischarge : null);
            record.vesselState = result.discharged || result.dischargeTime || result.dischargeTimeText
              ? '已到港已卸船'
              : result.arrived
                ? '已到港未卸船'
                : '未到港未卸船';
            record.lastUpdated = new Date();
            record.progress = '已完成';
            const routeSummary = result.routeText && !/(?:运行线路|已识别运行线路)=/.test(result.rawSummary)
              ? `；运行线路=${result.routeText}`
              : '';
            let detailWarning = '';
            try {
              await this.removeTrackingDetail(record, rule.code);
              if (result.trackingDetail && result.rawPageText) await this.saveTrackingDetail(record, result);
            } catch (detailError) {
              detailWarning = '；完整轨迹详情保存失败，请查看后端日志';
              console.warn(`[AutomationEngine] ${record.billNo} 完整轨迹详情保存失败：`, detailError);
            }
            record.note = `${result.arrivalKind ? `到港字段=${result.arrivalKind}；` : ''}${result.rawSummary}${routeSummary}${evidenceWarning}${detailWarning}；来源=${result.sourceUrl}${result.evidencePath ? `；成功证据=${result.evidencePath}` : ''}`;
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
            clearAutomaticTrackingResult(record);
            await this.removeTrackingDetail(record, carrierCode);
            record.lastUpdated = new Date();
            record.progress = '失败';
            record.note = failedNote(detail);
            failedDetails.push(detail);
            if (
              carrierCode !== 'UNKNOWN'
              && (failure.category === '验证码或风控' || failure.category === '官网拒绝访问')
              && !carrierCircuitBreakers.has(carrierCode)
            ) {
              carrierCircuitBreakers.set(carrierCode, detail);
            }
          }
          this.store.writeRecord(sheet, headerMap, record);
          if (this.currentRun) {
            this.currentRun.completed += 1;
            this.currentRun.success = success;
            this.currentRun.failed = failedDetails.length;
            this.currentRun.currentBills = this.currentRun.currentBills.filter((item) => item !== activeBill);
          }
          }
        }
      };
      // 浏览器会话、人工验证提示和证据截图必须共用一个顺序上下文；并发打开多个船司验证页
      // 会让前端只能显示最后一个验证提示，也会让验证码等待时间相互叠加。官方接口同样保持
      // 单线程，优先保证 Excel 写回、浏览器 Cookie 和人工验证状态的一致性。
      await worker();
      this.currentRun.phase = 'saving';
      await this.store.save(workbook);
      await this.syncDatabaseFromWorkbook();

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

  /**
   * 所有入口统一进入单进程队列。这样多个用户同时点击时会等待前一个任务完成，
   * 而不会互相覆盖 Excel、浏览器上下文或运行记录。
   */
  async run(
    reason: RunSummary['reason'],
    selection?: { carrierCodes?: string[]; shipmentIds?: string[]; skipCompleted?: boolean },
    idempotencyKey?: string,
  ): Promise<RunSummary> {
    const key = idempotencyKey?.trim();
    if (key) {
      const existing = this.idempotentRuns.get(key);
      if (existing && Date.now() - existing.createdAt < 10 * 60 * 1000) return existing.promise;
      for (const [storedKey, stored] of this.idempotentRuns) {
        if (Date.now() - stored.createdAt >= 10 * 60 * 1000) this.idempotentRuns.delete(storedKey);
      }
    }
    const promise = new Promise<RunSummary>((resolve, reject) => {
      this.runQueue.push({ reason, selection, resolve, reject });
      void this.processRunQueue();
    });
    if (key) this.idempotentRuns.set(key, { createdAt: Date.now(), promise });
    return promise;
  }

  private async processRunQueue() {
    if (this.processingQueue) return;
    this.processingQueue = true;
    try {
      while (this.runQueue.length) {
        const next = this.runQueue.shift()!;
        try {
          this.waitingForRunCoordinator = true;
          next.resolve(await this.runCoordinator.run(async () => {
            this.waitingForRunCoordinator = false;
            return this.withWorkspaceWrite(() => this.executeRun(next.reason, next.selection));
          }));
        } catch (error) {
          next.reject(error);
        } finally {
          this.waitingForRunCoordinator = false;
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async executeTask(id: string) {
    const task = (await this.listTasks()).find((item) => item.id === id);
    if (!task) throw new NotFoundError('自动化任务不存在');
    if (!task.enabled) throw new ConflictError('自动化任务已停用');
    const selection = task.scope === 'carrier'
      ? { carrierCodes: task.carrierCodes }
      : task.scope === 'shipment'
        ? { shipmentIds: task.shipmentIds }
        : undefined;
    const run = await this.run('manual', selection);
    await this.withWorkspaceWrite(async () => {
      const tasks = await this.listTasks();
      const index = tasks.findIndex((item) => item.id === id);
      if (index >= 0) {
        tasks[index] = { ...tasks[index], lastRunAt: run.finishedAt, lastRunId: run.id, updatedAt: run.finishedAt };
        await this.saveTasks(tasks);
      }
    });
    return run;
  }

  async runTask(id: string, idempotencyKey?: string) {
    const key = idempotencyKey?.trim();
    if (!key) return this.executeTask(id);
    const storedKey = `${id}:${key}`;
    const existing = this.idempotentTaskRuns.get(storedKey);
    if (existing && Date.now() - existing.createdAt < 10 * 60 * 1000) return existing.promise;
    const promise = this.executeTask(id);
    this.idempotentTaskRuns.set(storedKey, { createdAt: Date.now(), promise });
    return promise;
  }

  async status() {
    const workbookMetadata = await this.store.metadata();
    // 运行状态会直接返回给浏览器和普通用户，不能把本机绝对路径
    // （例如 /Users/.../data/current.xlsx）暴露到 API 响应中。
    const workbook = workbookMetadata ? { ...workbookMetadata, path: '' } : null;
    const runs = await this.listRuns();
    // Run summaries are persisted before being sent to the API. Older
    // installations may therefore still contain an absolute backup path;
    // normalize it here as well so every status response is safe to expose.
    const lastRun = runs[0]
      ? { ...runs[0], backupPath: runs[0].backupPath ? path.basename(runs[0].backupPath) : null }
      : null;
    const settings = await this.settings();
    return {
      running: this.running,
      queuedRuns: this.queuedRuns,
      currentRun: this.currentRun ? { ...this.currentRun, currentBills: [...this.currentRun.currentBills] } : null,
      mode: 'live' as const,
      enabled: settings.enabled,
      browserAutomationEnabled: settings.browserAutomationEnabled,
      workbook,
      schedule: settings.schedule,
      timezone: settings.timezone,
      notificationConfigured: Boolean(settings.wechatWebhookUrl),
      // DisabledDatabase 仍是一个对象，不能用 Boolean(this.database)
      // 判断是否真的启用了 PostgreSQL。
      databaseConfigured: Boolean(this.database?.enabled),
      lastRun,
      supportedCarriers: 15,
    };
  }

  async dashboardRecords() {
    if (!(await this.store.exists())) return [];
    const { sheet, headerMap } = await this.store.open();
    const records = this.store.readRecords(sheet, headerMap);
    return Promise.all(records.map(async (record) => {
      let carrier = record.carrierHint || '未知船司';
      let carrierCode = 'UNKNOWN';
      let sourceUrl = '';
      let verificationNo = record.billNo;
      try {
        const rule = resolveCarrierRule(record);
        carrier = rule.name;
        carrierCode = rule.code;
        sourceUrl = rule.url;
        verificationNo = rule.code === 'HAPAG' && record.containerNo
          ? record.containerNo
          : rule.code === 'SMLINE' && record.containerNo && record.note.includes('本次通道=柜号')
            ? record.containerNo
            : buildQueryBillNo(record.billNo, rule);
      } catch { /* 错误展示在 Excel 备注中 */ }
      const detailKey = this.trackingDetailKey(record);
      let trackingDetail: StoredTrackingDetail['trackingDetail'] | undefined;
      let trackingDetailUrl: string | undefined;
      if (carrierCode !== 'UNKNOWN') {
        try {
          const stored = await this.readTrackingDetail(carrierCode, `${detailKey}.json`);
          trackingDetail = stored.trackingDetail;
          trackingDetailUrl = sourceTrackingDetailUrl(carrierCode, detailKey);
        } catch {
          // 详情文件可能尚未采集，不能因此影响总览列表。
        }
      }
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
        failureEvidencePath: failureEvidencePathFromNote(record.note),
        verificationNo,
        route: routeTextFromNote(record.note),
        trackingDetail,
        trackingDetailUrl,
      };
    }));
  }
}
