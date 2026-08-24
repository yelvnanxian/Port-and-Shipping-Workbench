import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ALL_CARRIER_RULES, buildQueryBillNo, resolveCarrierRule } from './automation/carriers.js';
import { AutomationEngine } from './automation/engine.js';
import { notifyWeComTest } from './automation/notifier.js';
import { startScheduler } from './automation/scheduler.js';
import { corsOrigin, createRateLimiter, securityHeaders } from './security.js';
import { auditLog, auditMiddleware } from './audit.js';
import { assertBodyObject, backupNamePattern, clearanceHistoryIdPattern, optionalString, optionalStringArray, recordIds, requiredString, runIdPattern, shipmentIdPattern, taskIdPattern, userIdPattern, RequestValidationError } from './validation.js';
import { legacyEvidenceDirectory, safeSourceCode, sourceEvidenceDirectory } from './automation/source-storage.js';
import { AuthService } from './auth.js';
import { createAppDatabase } from './database.js';
import { WorkbookStore } from './automation/workbook.js';
import { shutdownBrowserAutomation } from './automation/browser-lifecycle.js';
import { ManualCollectionRegistry, isManualCollectionCarrier, manualCollectionHostAllowed, manualCollectionUserId } from './automation/manual-collection.js';
import { HAPAG_CONTAINER_SOURCE } from './automation/hapag.js';
import { SerialExecutionCoordinator } from './automation/concurrency.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import type { CarrierSource, Shipment } from './types.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.APP_HOST || '127.0.0.1';
const database = createAppDatabase();
await database.migrate();
const globalRunCoordinator = new SerialExecutionCoordinator();
const engine = new AutomationEngine(new WorkbookStore(), database, { runCoordinator: globalRunCoordinator });
await engine.store.initialize();
await engine.cleanupClearanceHistory();
await engine.migrateClearedRecordsToHistory();
await engine.syncDatabaseFromWorkbook();
const auth = new AuthService(engine.store.dataDirectory, database);
const manualCollections = new ManualCollectionRegistry();
if (auth.enabled && (await auth.listUsers()).length === 0) {
  throw new Error('已启用登录但没有可用管理员账号，请设置 AUTH_ADMIN_PASSWORD 或先初始化 PostgreSQL 用户');
}
const configuredOrigins = (process.env.APP_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
const hasPublicOrigin = configuredOrigins.some((origin) => !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin));
if (!auth.enabled && (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' || hasPublicOrigin)) {
  throw new Error('公网或反向代理访问必须启用 AUTH_ENABLED=true，不能以无登录模式启动');
}
// 管理员使用主工作区；普通账号按账号 ID 使用独立工作区，避免读取或修改管理员的 Excel、任务、备份和证据。
const workspaceRoot = path.join(engine.store.dataDirectory, 'workspaces');
const workspaceEngines = new WorkspaceRegistry<AutomationEngine>(async (safeUserId) => {
  const workspaceDirectory = path.join(engine.store.dataDirectory, 'workspaces', safeUserId);
  const workspace = new AutomationEngine(new WorkbookStore(process.cwd(), workspaceDirectory), undefined, {
    defaultWechatWebhookUrl: '',
    runCoordinator: globalRunCoordinator,
  });
  await workspace.store.initialize();
  await workspace.cleanupClearanceHistory();
  await workspace.migrateClearedRecordsToHistory();
  await workspace.syncDatabaseFromWorkbook();
  return workspace;
});
async function activeEngine(req: express.Request) {
  const user = req.authUser;
  if (!user || user.role === 'admin') return engine;
  return workspaceEngines.get(user.id.replace(/[^A-Za-z0-9_-]/g, '_'));
}
// 服务重启后恢复已有普通用户工作区，使其自定义定时任务无需先登录一次才会执行。
try {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^user-[A-Za-z0-9_-]+$/.test(entry.name)) await workspaceEngines.get(entry.name);
  }
} catch {
  // 尚未创建普通用户工作区时无需处理。
}
const scheduledTasks = startScheduler(engine, () => [engine, ...workspaceEngines.values()]);

const upload = multer({
  dest: engine.store.uploadDirectory,
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8, fieldNameSize: 64 },
  fileFilter: (_req, file, callback) => {
    if (!/\.xlsx$/i.test(file.originalname) || !/spreadsheetml|octet-stream/i.test(file.mimetype || '')) {
      callback(new RequestValidationError('只允许上传 .xlsx 格式的 Excel 文件'));
      return;
    }
    callback(null, true);
  },
});

const manualCollectionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, fieldNameSize: 80, fieldSize: 4 * 1024 * 1024 },
});

app.disable('x-powered-by');
app.set('trust proxy', process.env.APP_TRUST_PROXY === 'true' ? 1 : false);
app.use(securityHeaders);
app.use(cors({ origin: (origin, callback) => callback(null, corsOrigin(origin)), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('X-Request-Id', req.get('x-request-id')?.slice(0, 80) || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  if (req.method === 'TRACE' || req.method === 'CONNECT') {
    res.status(405).json({ message: '不支持该请求方法', code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  next();
});
// 留出前端每秒轮询自动化进度的空间；登录和危险操作的更严格限流会在认证阶段单独增加。
app.use(createRateLimiter({ windowMs: 5 * 60 * 1000, max: 1000, name: 'all' }));
app.use('/api', createRateLimiter({ windowMs: 5 * 60 * 1000, max: 600, name: 'api' }));
// 放在认证之前，连未授权和 CSRF 失败请求也能留下审计痕迹；响应结束时会读取已注入的 authUser。
app.use('/api', auditMiddleware(engine.store.dataDirectory));

let lastSync = new Date().toISOString();

app.get('/api/auth/session', (req, res) => {
  const current = auth.sessionFromRequest(req);
  const issue = current ? null : auth.sessionIssueFromRequest(req);
  res.json({
    enabled: auth.enabled,
    authenticated: Boolean(current),
    user: current?.user || null,
    csrfToken: current?.csrfToken || '',
    code: issue === 'replaced' ? 'AUTH_SESSION_REPLACED' : undefined,
    message: issue === 'replaced' ? '该账号已在其他设备登录，本设备已退出' : undefined,
  });
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (!auth.enabled) { res.json({ enabled: false, authenticated: true, user: { id: 'local-admin', username: 'local-admin', role: 'admin' }, csrfToken: '' }); return; }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw new Error('请输入用户名和密码');
    const session = await auth.login(username, password, req.ip || 'unknown');
    auth.setSessionCookie(res, session.token);
    res.json({ enabled: true, authenticated: true, user: session.user, csrfToken: session.csrfToken });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

function publicSettings(settings: Awaited<ReturnType<AutomationEngine['settings']>>) {
  const webhook = settings.wechatWebhookUrl;
  return {
    enabled: settings.enabled,
    browserAutomationEnabled: settings.browserAutomationEnabled,
    schedule: settings.schedule,
    timezone: settings.timezone,
    notificationConfigured: Boolean(webhook),
    webhookPreview: webhook ? `${webhook.slice(0, 38)}${webhook.length > 38 ? '…' : ''}` : '',
  };
}

function colorFor(code: string) {
  const colors: Record<string, string> = { COSCO: '#147d73', MAERSK: '#38a9d3', MSC: '#e2a51d', ONE: '#bd2e78', ZIM: '#2765ae', EVERGREEN: '#338356' };
  return colors[code] || '#6b858f';
}

function buildSources(shipments: Shipment[], syncAt: string): CarrierSource[] {
  const groups = new Map<string, Shipment[]>();
  shipments.forEach((item) => groups.set(item.carrierCode, [...(groups.get(item.carrierCode) || []), item]));
  return [...groups.entries()].map(([code, records]) => ({
    id: code.toLowerCase(),
    name: records[0].carrier,
    code,
    color: colorFor(code),
    mode: 'live',
    status: records.every((record) => record.progress === '已完成')
      ? 'online'
      : records.some((record) => record.progress === '失败')
        ? 'warning'
        : 'offline',
    lastSync: syncAt,
    recordCount: records.length,
  }));
}

async function dashboardPayload(target = engine) {
  const workbookRecords = await target.dashboardRecords();
  const automation = await target.status();
  const generatedAt = automation.lastRun?.finishedAt || lastSync;
  if (workbookRecords.length) {
    const shipments: Shipment[] = workbookRecords.map(({ record, carrier, carrierCode, sourceUrl, evidencePath, failureEvidencePath, verificationNo, route, trackingDetail, trackingDetailUrl }) => ({
      id: `XLSX-${record.rowNumber}`,
      carrier,
      carrierCode,
      billNo: record.billNo,
      containerNo: record.containerNo,
      vesselVoyage: 'Excel 自动追踪',
      terminal: '以船司官网为准',
      eta: record.arrivalTime || null,
      berthingTime: null,
      dischargeTime: record.dischargeTime || null,
      status: record.progress === '失败'
        ? '计划变更'
        : record.vesselState === '已到港已卸船'
          ? '已卸船'
          : record.vesselState === '已到港未卸船'
            ? '作业中'
            : '待靠泊',
      lastUpdated: record.lastUpdated?.toISOString() || new Date(0).toISOString(),
      note: compactPublicNote(record.note || (record.progress ? `进度：${record.progress}` : '待首次查询'), Boolean(record.dischargeTime)),
      vesselState: record.vesselState || '未到港未卸船',
      manualMark: record.manualMark,
      progress: record.progress || '待查询',
      sourceUrl,
      evidencePath,
      failureEvidencePath,
      verificationNo,
      route,
      trackingDetail,
      trackingDetailUrl,
    }));
    return { shipments, sources: buildSources(shipments, generatedAt), generatedAt };
  }
  return { shipments: [], sources: [], generatedAt };
}

function compactPublicNote(note: string, hasDischarge = false) {
  const value = note.trim();
  if (!value) return '';
  if (hasDischarge) return '已获取到港时间和实际卸船时间';
  const category = value.match(/(?:^|；)失败分类=([^；]+)/)?.[1];
  const reason = value.match(/(?:^|；)原因=([^；]+)/)?.[1];
  if (category || reason) return `失败：${category || '查询失败'}${reason ? `；${reason}` : ''}`.slice(0, 120);
  if (/人工补录|人工修改/.test(value)) return value.split('；')[0].slice(0, 120);
  if (/确认已卸船，但未提供精确卸船时刻/.test(value)) return '已确认卸船完成，官网未提供精确卸船时间';
  if (/已发现实际卸船事件|已发现卸船事件/.test(value)) return '已获取到港时间和实际卸船时间';
  const arrivalKind = value.match(/(?:^|；)到港字段=(ATA|ETA)/)?.[1];
  if (arrivalKind) return `已获取 ${arrivalKind}，尚未发现实际卸船时间`;
  const first = value.split('；').find((part) => !/^(?:来源|成功证据|运行线路)=/.test(part.trim())) || value;
  return first.slice(0, 120);
}

app.get('/api/health', async (_req, res) => {
  const current = auth.sessionFromRequest(_req);
  if (current?.user.role !== 'admin') {
    res.json({ ok: true });
    return;
  }
  res.json({ ok: true, lastSync, automation: await engine.status() });
});

/**
 * The browser extension submits a one-time token instead of a session cookie.
 * This route intentionally appears before the normal session middleware so a
 * Chrome extension origin can submit after the user has completed the check
 * in a regular browser tab. The token is scoped to one row/query and expires
 * after 15 minutes, so it is not a general API credential.
 */
app.post('/api/manual-collection/submit', manualCollectionUpload.single('screenshot'), async (req, res, next) => {
  const token = (req.get('x-manual-collection-token') || (typeof req.body?.token === 'string' ? req.body.token : '')).trim();
  const session = token ? manualCollections.findByToken(token) : undefined;
  if (!session) {
    res.status(401).json({ message: '采集令牌无效或已过期', code: 'MANUAL_COLLECTION_TOKEN_INVALID' });
    return;
  }
  if (session.status === 'success') {
    res.status(409).json({ message: '该采集令牌已经使用过', code: 'MANUAL_COLLECTION_ALREADY_USED', session: manualCollections.view(session) });
    return;
  }
  try {
    const pageUrl = requiredString(req.body?.pageUrl, '官网页面地址', 2000);
    const pageText = requiredString(req.body?.pageText, '官网页面文字', 4 * 1024 * 1024);
    const submittedQueryType = req.body?.queryType === 'container' ? 'container' : req.body?.queryType === 'bill' ? 'bill' : '';
    if (submittedQueryType && submittedQueryType !== session.queryType) throw new RequestValidationError('采集方式与当前令牌不一致，请重新创建采集会话');
    const queryType = session.queryType;
    if (!manualCollectionHostAllowed(session.carrierCode, pageUrl)) throw new RequestValidationError('官网页面域名与当前船司不一致');
    if (!req.file) throw new RequestValidationError('缺少官网结果页截图，请使用工作台浏览器扩展重新采集');
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (req.file.mimetype !== 'image/png' || req.file.buffer.length < pngSignature.length || !req.file.buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new RequestValidationError('采集证据必须是有效的 PNG 截图');
    }
    const applied = await session.engine.applyManualBrowserCapture(session.rowNumber, {
      queryType,
      pageUrl,
      pageText,
      screenshot: req.file.buffer,
    });
    manualCollections.markSuccess(session, {
      arrivalKind: applied.result.arrivalKind,
      arrived: applied.result.arrived,
      discharged: Boolean(applied.result.discharged || applied.result.dischargeTime || applied.result.dischargeTimeText),
      evidencePath: applied.result.evidencePath,
    });
    lastSync = new Date().toISOString();
    res.json({ ok: true, session: manualCollections.view(session), dashboard: await dashboardPayload(session.engine), automation: await session.engine.status() });
  } catch (error) {
    const message = (error instanceof Error ? error.message : '页面未能解析').slice(0, 500);
    manualCollections.markAttempt(session, message);
    res.status(error instanceof RequestValidationError ? 400 : 422).json({ message, code: 'MANUAL_COLLECTION_REJECTED', session: manualCollections.view(session) });
  }
});

// 除健康检查和登录接口外，所有业务 API 都要求有效 Session；写请求还要求 CSRF Token。
app.use('/api', auth.requireSession);

// 认证后的业务请求按账号选择工作区。账号管理和系统级设置仍由各自路由单独限制为管理员。

app.get('/api/auth/users', auth.requireRole('admin'), async (_req, res, next) => {
  try {
    res.json({ users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/users', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (body.role !== 'admin' && body.role !== 'user') throw new RequestValidationError('用户角色不合法');
    const user = await auth.createUser({
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : '',
      role: body.role,
    });
    res.status(201).json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/auth/users/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const id = requiredString(req.params.id, '用户编号', 60);
    if (!userIdPattern.test(id)) throw new RequestValidationError('用户编号不合法');
    if (body.role !== undefined && typeof body.role !== 'string') throw new RequestValidationError('用户角色不合法');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new RequestValidationError('账号状态不合法');
    if (body.role !== undefined && body.role !== 'admin' && body.role !== 'user') throw new RequestValidationError('用户角色不合法');
    const user = await auth.updateUser(id, {
      role: body.role as 'admin' | 'user' | undefined,
      enabled: body.enabled,
    }, req.authUser!.id);
    res.json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/users/:id/password', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const id = requiredString(req.params.id, '用户编号', 60);
    if (!userIdPattern.test(id)) throw new RequestValidationError('用户编号不合法');
    const user = await auth.resetPassword(id, typeof body.password === 'string' ? body.password : '', req.authUser!.id);
    res.json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/auth/users/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '用户编号', 60);
    if (!userIdPattern.test(id)) throw new RequestValidationError('用户编号不合法');
    res.json({ users: await auth.deleteUser(id, req.authUser!.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/dashboard', async (req, res, next) => {
  try {
    res.json(await dashboardPayload(await activeEngine(req)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation', async (req, res, next) => {
  try {
    res.json(await (await activeEngine(req)).status());
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/browser/cleanup', auth.requireRole('admin'), async (_req, res, next) => {
  try {
    const activeEngines = [engine, ...workspaceEngines.values()];
    if (activeEngines.some((item) => item.isRunning || item.queuedRuns > 0)) {
      throw new Error('当前有查询任务正在执行，请等待任务完成后再清理自动化 Chrome');
    }
    const cleanup = await shutdownBrowserAutomation(activeEngines.map((item) => item.store.dataDirectory));
    res.json({ ok: true, cleanup, automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

// 当前浏览器查询遇到人机验证时，允许登录用户跳过这条记录并继续后续队列。
// 验证通过则无需调用该接口，服务会自动检测页面状态并清除前端提示。
app.post('/api/automation/verification/skip', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    const skipped = target.skipVerification();
    if (!skipped) throw new Error('当前没有等待人工验证的查询记录');
    res.json({ ok: true, automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/settings', auth.requireRole('admin'), async (req, res, next) => {
  try {
    res.json(publicSettings(await (await activeEngine(req)).settings()));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/automation/settings', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const patch: { enabled?: boolean; browserAutomationEnabled?: boolean; wechatWebhookUrl?: string } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new RequestValidationError('enabled 必须是布尔值');
      patch.enabled = body.enabled;
    }
    if (body.browserAutomationEnabled !== undefined) {
      if (typeof body.browserAutomationEnabled !== 'boolean') throw new RequestValidationError('browserAutomationEnabled 必须是布尔值');
      patch.browserAutomationEnabled = body.browserAutomationEnabled;
    }
    if (body.wechatWebhookUrl !== undefined) {
      if (typeof body.wechatWebhookUrl !== 'string') throw new RequestValidationError('企业微信 Webhook 必须是文本');
      const webhook = body.wechatWebhookUrl.trim();
      if (webhook.length > 500) throw new RequestValidationError('企业微信 Webhook 地址过长');
      if (webhook) {
        const parsed = new URL(webhook);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'qyapi.weixin.qq.com' || !parsed.searchParams.get('key')) {
          throw new Error('请输入完整的企业微信机器人 Webhook 地址');
        }
      }
      patch.wechatWebhookUrl = webhook;
    }
    if (!Object.keys(patch).length) throw new Error('没有需要保存的设置');
    const settings = await engine.updateSettings(patch);
    res.json({ settings: publicSettings(settings), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/test-notification', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body || {});
    const configured = typeof body.wechatWebhookUrl === 'string' ? body.wechatWebhookUrl.trim() : (await engine.settings()).wechatWebhookUrl;
    if (!configured) throw new Error('请先填写企业微信 Webhook 地址');
    const result = await notifyWeComTest(configured);
    if (result === 'failed') throw new Error('企业微信测试消息发送失败，请检查 Webhook 或网络连接');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/runs', async (req, res, next) => {
  try {
    res.json({ runs: await (await activeEngine(req)).listRuns() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/runs', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '运行记录编号', runIdPattern);
    res.json({ runs: await (await activeEngine(req)).deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/runs/delete-batch', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '运行记录编号', runIdPattern);
    res.json({ runs: await (await activeEngine(req)).deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/runs/:id', async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '运行记录编号', 80);
    if (!runIdPattern.test(id)) throw new RequestValidationError('运行记录编号不合法');
    res.json({ runs: await (await activeEngine(req)).deleteRuns([id]) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/tasks', async (req, res, next) => {
  try {
    res.json({ tasks: await (await activeEngine(req)).listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (body.scope !== 'all' && body.scope !== 'carrier' && body.scope !== 'shipment') throw new RequestValidationError('任务范围不合法');
    const target = await activeEngine(req);
    const task = await target.createTask({
      name: typeof body.name === 'string' ? body.name : '',
      scope: body.scope,
      carrierCodes: optionalStringArray(body.carrierCodes, '船司编号', { maxItems: 15, maxLength: 24 }) || [],
      shipmentIds: optionalStringArray(body.shipmentIds, '船期编号', { maxItems: 100, maxLength: 40 }) || [],
      scheduleTime: body.scheduleTime === null ? null : optionalString(body.scheduleTime, '任务时间', 5) || null,
    });
    res.json({ task, tasks: await target.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/automation/tasks/:id', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    if (typeof body.enabled !== 'boolean') throw new RequestValidationError('enabled 必须是布尔值');
    const target = await activeEngine(req);
    res.json({ task: await target.updateTask(id, { enabled: body.enabled }), tasks: await target.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    res.json({ tasks: await (await activeEngine(req)).deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/delete-batch', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    res.json({ tasks: await (await activeEngine(req)).deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks/:id', async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    res.json({ tasks: await (await activeEngine(req)).deleteTasks([id]) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/:id/run', async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    const target = await activeEngine(req);
    const run = await target.runTask(id, req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(target), automation: await target.status(), tasks: await target.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/run-batch', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    const target = await activeEngine(req);
    const runs = [];
    for (const id of ids) {
      runs.push(await target.runTask(id, req.get('x-idempotency-key') ? `${req.get('x-idempotency-key')}:${id}` : undefined));
      lastSync = runs[runs.length - 1].finishedAt;
    }
    res.json({ runs, dashboard: await dashboardPayload(target), automation: await target.status(), tasks: await target.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/carriers', (_req, res) => {
  res.json({ carriers: ALL_CARRIER_RULES });
});

async function sendEvidence(res: express.Response, directory: string, requestedName: string) {
  const fileName = path.basename(requestedName);
  if (fileName !== requestedName || !/\.(?:png|svg)$/i.test(fileName)) {
    res.status(400).json({ error: '证据文件名不合法' });
    return;
  }
  const filePath = path.join(directory, fileName);
  try {
    await fs.access(filePath);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (/\.svg$/i.test(fileName)) {
      res.type('image/svg+xml');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: '证据文件不存在' });
  }
}

// 只暴露截图证据，不直接暴露 data/sources（其中包含 Cookie/storage state）。
app.get('/api/browser-evidence/:carrier/:filename', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    const carrier = safeSourceCode(req.params.carrier);
    if (carrier !== req.params.carrier.toUpperCase()) {
      res.status(400).json({ error: '船司标识不合法' });
      return;
    }
    await sendEvidence(res, sourceEvidenceDirectory(target.store.dataDirectory, carrier), req.params.filename);
  } catch (error) {
    next(error);
  }
});

// 兼容升级前已写入的扁平证据路径。
app.get('/api/browser-evidence/:filename', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    await sendEvidence(res, legacyEvidenceDirectory(target.store.dataDirectory), req.params.filename);
  } catch (error) {
    next(error);
  }
});

// 结构化轨迹详情只允许读取当前登录用户工作区内、按船司隔离保存的 JSON；
// 不暴露 data/sources 下的 Cookie、storage state 或其他运行文件。
app.get('/api/tracking-details/:carrier/:filename', async (req, res, next) => {
  try {
    const carrier = safeSourceCode(req.params.carrier);
    if (carrier !== req.params.carrier.toUpperCase() || !/^[A-Z0-9_-]+$/.test(carrier)) {
      res.status(400).json({ error: '船司标识不合法' });
      return;
    }
    const fileName = req.params.filename;
    if (path.basename(fileName) !== fileName || !/^[A-Z0-9_-]+\.json$/i.test(fileName)) {
      res.status(400).json({ error: '轨迹详情文件名不合法' });
      return;
    }
    const target = await activeEngine(req);
    res.json(await target.readTrackingDetail(carrier, fileName));
  } catch (error) {
    next(error);
  }
});

app.get('/api/backups', async (req, res, next) => {
  try {
    res.json({ backups: await (await activeEngine(req)).store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/backups/:name', async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    const filePath = (await activeEngine(req)).store.backupPath(name);
    await fs.access(filePath);
    res.download(filePath, name, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/create', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    if (!(await target.store.exists())) throw new Error('尚未导入 Excel，无法创建备份');
    const backupPath = await target.store.backup('手动创建备份');
    res.json({ backupPath, backups: await target.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/delete-batch', async (req, res, next) => {
  try {
    const names = recordIds(req.body?.names, '备份文件名', backupNamePattern, 100);
    const target = await activeEngine(req);
    for (const name of [...new Set(names)]) await target.store.deleteBackup(name);
    res.json({ ok: true, backups: await target.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/:name/restore', async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    const target = await activeEngine(req);
    await target.store.restore(name);
    await target.migrateClearedRecordsToHistory();
    await target.syncDatabaseFromWorkbook();
    const workbook = await target.store.metadata();
    lastSync = new Date().toISOString();
    res.json({ workbook, backups: await target.store.listBackups(), dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/backups/:name', async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    const target = await activeEngine(req);
    await target.store.deleteBackup(name);
    res.json({ ok: true, backups: await target.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/intake', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (!Array.isArray(body.entries) || body.entries.length === 0) throw new RequestValidationError('请至少提供一个提单号');
    if (body.entries.length > 200) throw new RequestValidationError('一次最多新增 200 条单号');
    const normalized = body.entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RequestValidationError(`第 ${index + 1} 条单号格式不正确`);
      const item = entry as Record<string, unknown>;
      return {
        billNo: typeof item.billNo === 'string' ? item.billNo.trim() : '',
        containerNo: typeof item.containerNo === 'string' ? item.containerNo.trim() : '',
        carrierHint: typeof item.carrierHint === 'string' ? item.carrierHint.trim().slice(0, 40) : '',
      };
    });
    if (normalized.some((entry) => !entry.billNo || entry.billNo.length > 64)) throw new RequestValidationError('提单号不能为空且不能超过 64 个字符');
    const target = await activeEngine(req);
    const result = await target.store.appendRecords(normalized);
    await target.syncDatabaseFromWorkbook();
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

function workbookRowId(value: unknown) {
  if (typeof value !== 'string') throw new Error('船期编号不合法');
  const match = value.match(/^XLSX-(\d+)$/);
  if (!match) throw new Error('船期编号不合法');
  return Number(match[1]);
}

app.post('/api/manual-collection/sessions', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const shipmentId = requiredString(body.shipmentId, '船期编号', 40);
    if (!shipmentIdPattern.test(shipmentId)) throw new RequestValidationError('船期编号不合法');
    const queryType = body.queryType === 'container' ? 'container' : body.queryType === 'bill' ? 'bill' : '';
    if (!queryType) throw new RequestValidationError('采集方式必须是 bill 或 container');
    const target = await activeEngine(req);
    const rowNumber = workbookRowId(shipmentId);
    const opened = await target.store.open();
    const record = target.store.readRecords(opened.sheet, opened.headerMap).find((item) => item.rowNumber === rowNumber);
    if (!record) throw new Error('找不到对应船期记录');
    const rule = resolveCarrierRule(record);
    if (!isManualCollectionCarrier(rule.code)) throw new Error('普通浏览器采集目前仅支持达飞和赫伯罗特');
    if (rule.code === 'HAPAG') {
      if (!record.containerNo) throw new RequestValidationError('赫伯罗特必须提供完整柜号后才能采集');
      if (queryType !== 'container') throw new RequestValidationError('赫伯罗特请使用完整柜号采集');
    }
    const session = manualCollections.create({
      userId: manualCollectionUserId(req.authUser),
      engine: target,
      carrierCode: rule.code,
      carrierName: rule.name,
      shipmentId,
      rowNumber,
      billNo: record.billNo,
      queryBillNo: buildQueryBillNo(record.billNo, rule),
      containerNo: record.containerNo,
      queryType,
      sourceUrl: rule.code === 'HAPAG' ? HAPAG_CONTAINER_SOURCE : rule.url,
    });
    res.status(201).json({
      session: manualCollections.view(session),
      instructions: {
        extensionDirectory: 'browser-extension',
        message: '请用普通 Chrome/Edge 打开官网并完成验证、查询和 Details 页面，然后在“船期采集器”扩展中粘贴令牌并点击采集。不要使用工作台自动打开的 Chrome。',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/manual-collection/sessions/:id', async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '采集会话编号', 100);
    const session = manualCollections.findById(id, manualCollectionUserId(req.authUser));
    if (!session) { res.status(404).json({ message: '采集会话不存在或已过期', code: 'MANUAL_COLLECTION_NOT_FOUND' }); return; }
    res.json({ session: manualCollections.view(session) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/shipments/:id/mark', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const target = await activeEngine(req);
    const billNo = optionalString(body.billNo, '提单号', 80);
    const containerNo = optionalString(body.containerNo, '柜号', 40);
    if (billNo === undefined || containerNo === undefined) throw new RequestValidationError('缺少船期记录核验信息，请刷新页面后重试');
    const result = await target.updateManualMark(workbookRowId(req.params.id), body.manualMark, { billNo, containerNo });
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/clearance-history', async (req, res, next) => {
  try {
    res.json(await (await activeEngine(req)).listClearanceHistory());
  } catch (error) {
    next(error);
  }
});

app.patch('/api/clearance-history/settings', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (body.retentionDays !== 3 && body.retentionDays !== 7) throw new RequestValidationError('历史记录保留天数只能选择 3 天或 7 天');
    res.json(await (await activeEngine(req)).setClearanceRetentionDays(body.retentionDays));
  } catch (error) {
    next(error);
  }
});

app.post('/api/clearance-history/:id/restore', async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '清关历史编号', 80);
    if (!clearanceHistoryIdPattern.test(id)) throw new RequestValidationError('清关历史编号不合法');
    const target = await activeEngine(req);
    const result = await target.restoreClearanceHistory(id);
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/clearance-history/delete-batch', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '清关历史编号', clearanceHistoryIdPattern, 500);
    res.json(await (await activeEngine(req)).deleteClearanceHistory(ids));
  } catch (error) {
    next(error);
  }
});

app.post('/api/clearance-history/cleanup', async (req, res, next) => {
  try {
    res.json(await (await activeEngine(req)).cleanupClearanceHistory());
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/delete-batch', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '船期编号', shipmentIdPattern, 200);
    const rowNumbers = ids.map(workbookRowId);
    const target = await activeEngine(req);
    const result = await target.deleteShipments(rowNumbers);
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/export', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '船期编号', shipmentIdPattern, 500);
    const buffer = await (await activeEngine(req)).store.exportRecords(ids.map(workbookRowId));
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('船期筛选结果.xlsx')}`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/manual', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const target = await activeEngine(req);
    const result = await target.manualAppend({
      billNo: typeof body.billNo === 'string' ? body.billNo : '',
      containerNo: typeof body.containerNo === 'string' ? body.containerNo : '',
      carrierHint: typeof body.carrierHint === 'string' ? body.carrierHint : '',
      arrivalTime: body.arrivalTime,
      dischargeTime: body.dischargeTime,
      vesselState: body.vesselState,
      note: typeof body.note === 'string' ? body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/shipments/:id/manual', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const target = await activeEngine(req);
    const result = await target.manualUpdate(workbookRowId(req.params.id), {
      arrivalTime: body.arrivalTime,
      dischargeTime: body.dischargeTime,
      vesselState: body.vesselState,
      note: typeof body.note === 'string' ? body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/run', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body || {});
    const carrierCodes = optionalStringArray(body.carrierCodes, '船司编号', { maxItems: 15, maxLength: 24 });
    const shipmentIds = optionalStringArray(body.shipmentIds, '船期编号', { maxItems: 200, maxLength: 40 });
    if (body.skipCompleted !== undefined && typeof body.skipCompleted !== 'boolean') throw new RequestValidationError('skipCompleted 必须是布尔值');
    for (const id of shipmentIds || []) if (!shipmentIdPattern.test(id)) throw new RequestValidationError('船期编号不合法');
    const hasSelection = carrierCodes?.length || shipmentIds?.length || body.skipCompleted !== undefined;
    const target = await activeEngine(req);
    const run = await target.run('manual', hasSelection ? { carrierCodes, shipmentIds, skipCompleted: body.skipCompleted } : undefined, req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(target), automation: await target.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    if (!(await target.store.exists())) throw new Error('请先导入 Excel 或新增单号');
    const run = await target.run('manual', undefined, req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json(await dashboardPayload(target));
  } catch (error) {
    next(error);
  }
});

app.post('/api/workbooks/upload', upload.single('workbook'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('请选择 .xlsx 文件');
    const target = await activeEngine(req);
    await target.store.install(req.file.path);
    await target.migrateClearedRecordsToHistory();
    await target.syncDatabaseFromWorkbook();
    const workbook = await target.store.metadata();
    res.json({ workbook, automation: await target.status(), dashboard: await dashboardPayload(target) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/workbooks/current', async (req, res, next) => {
  try {
    const target = await activeEngine(req);
    if (!(await target.store.exists())) throw new Error('尚未导入 Excel 文件');
    res.download(target.store.currentPath, '船期自动更新.xlsx');
  } catch (error) {
    next(error);
  }
});

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(serverDirectory, '../outputs/01a014e4-2b3b-7f43-9fa3-d1086c95abc9/船期自动抓取模板.xlsx');
app.get('/api/workbooks/template', (_req, res) => res.download(templatePath, '船期自动抓取模板.xlsx'));

const webDirectory = path.resolve(serverDirectory, '../dist');
app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));
app.use(express.static(webDirectory));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(webDirectory, 'index.html'));
});

app.use((error: Error & { code?: string; statusCode?: number; status?: number; type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  void auditLog(engine.store.dataDirectory, 'api.error', {
    method: req.method,
    path: req.path,
    status: error.statusCode || error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof SyntaxError ? 400 : 500),
    userId: req.authUser?.id || null,
    error: error.name,
  });
  const status = error.statusCode || error.status || (error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : /ENOENT|备份文件不存在|找不到/.test(error.message) ? 404 : 500);
  const message = error.code === 'LIMIT_FILE_SIZE'
    ? '上传文件不能超过 20MB'
    : error.type === 'entity.too.large'
      ? '请求体不能超过允许大小'
      : error instanceof SyntaxError
        ? '请求体 JSON 格式不正确'
    : error.code === 'LIMIT_UNEXPECTED_FILE'
      ? '只允许上传一个 Excel 文件'
      : (error.message || '采集失败，请检查数据源配置').replace(/\/(?:Users|home|var)\/[^\s；]+/g, '[内部路径]').slice(0, 500);
  res.status(status).json({ message, code: error.name === 'RequestValidationError' ? 'VALIDATION_ERROR' : error.code || 'INTERNAL_ERROR' });
});

const server = app.listen(port, host, () => {
  console.log(`Port operations API listening on http://${host}:${port}`);
  console.log('Custom task scheduler enabled: per-task times, Asia/Shanghai');
  console.log(`PostgreSQL: ${database.enabled ? 'enabled' : 'disabled (set DATABASE_URL to enable)'}`);
});
// 防止慢请求长期占用连接，浏览器抓取本身使用独立的 Playwright 超时。
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduledTasks.forEach((task) => task.stop());
  const engines = () => [engine, ...workspaceEngines.values()];
  if (engines().some((item) => item.isRunning || item.queuedRuns > 0)) {
    console.log('更新任务仍在执行，等待当前队列完成后再退出，避免 Excel 停留在“查询中”状态');
    while (engines().some((item) => item.isRunning || item.queuedRuns > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
    server.close(() => {
    void shutdownBrowserAutomation(engines().map((item) => item.store.dataDirectory))
      .catch((error) => console.error('Browser automation shutdown failed:', error))
      .finally(() => database.close())
      .finally(() => process.exit(0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void gracefulShutdown(); });
}
