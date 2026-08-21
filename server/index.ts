import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ALL_CARRIER_RULES } from './automation/carriers.js';
import { AutomationEngine } from './automation/engine.js';
import { notifyWeComTest } from './automation/notifier.js';
import { startScheduler } from './automation/scheduler.js';
import { corsOrigin, createRateLimiter, securityHeaders } from './security.js';
import { auditLog, auditMiddleware } from './audit.js';
import { assertBodyObject, backupNamePattern, optionalString, optionalStringArray, recordIds, requiredString, runIdPattern, shipmentIdPattern, taskIdPattern, userIdPattern, RequestValidationError } from './validation.js';
import { legacyEvidenceDirectory, safeSourceCode, sourceEvidenceDirectory } from './automation/source-storage.js';
import { AuthService } from './auth.js';
import { createAppDatabase } from './database.js';
import { WorkbookStore } from './automation/workbook.js';
import type { CarrierSource, Shipment } from './types.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.APP_HOST || '127.0.0.1';
const database = createAppDatabase();
await database.migrate();
const engine = new AutomationEngine(new WorkbookStore(), database);
await engine.store.initialize();
await engine.syncDatabaseFromWorkbook();
const auth = new AuthService(engine.store.dataDirectory, database);
if (auth.enabled && (await auth.listUsers()).length === 0) {
  throw new Error('已启用登录但没有可用管理员账号，请设置 AUTH_ADMIN_PASSWORD 或先初始化 PostgreSQL 用户');
}
const configuredOrigins = (process.env.APP_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
const hasPublicOrigin = configuredOrigins.some((origin) => !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin));
if (!auth.enabled && (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' || hasPublicOrigin)) {
  throw new Error('公网或反向代理访问必须启用 AUTH_ENABLED=true，不能以无登录模式启动');
}
startScheduler(engine);

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
  res.json({ enabled: auth.enabled, authenticated: Boolean(current), user: current?.user || null, csrfToken: current?.csrfToken || '' });
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

async function dashboardPayload() {
  const workbookRecords = await engine.dashboardRecords();
  const automation = await engine.status();
  const generatedAt = automation.lastRun?.finishedAt || lastSync;
  if (workbookRecords.length) {
    const shipments: Shipment[] = workbookRecords.map(({ record, carrier, carrierCode, sourceUrl, evidencePath, verificationNo, route }) => ({
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
      note: record.note || (record.progress ? `进度：${record.progress}` : '待首次查询'),
      vesselState: record.vesselState || '未到港未卸船',
      manualMark: record.manualMark,
      progress: record.progress || '待查询',
      sourceUrl,
      evidencePath,
      verificationNo,
      route,
    }));
    return { shipments, sources: buildSources(shipments, generatedAt), generatedAt };
  }
  return { shipments: [], sources: [], generatedAt };
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, lastSync, automation: await engine.status() });
});

// 除健康检查和登录接口外，所有业务 API 都要求有效 Session；写请求还要求 CSRF Token。
app.use('/api', auth.requireSession);

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

app.get('/api/dashboard', async (_req, res, next) => {
  try {
    res.json(await dashboardPayload());
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation', async (_req, res, next) => {
  try {
    res.json(await engine.status());
  } catch (error) {
    next(error);
  }
});

// 当前浏览器查询遇到人机验证时，允许登录用户跳过这条记录并继续后续队列。
// 验证通过则无需调用该接口，服务会自动检测页面状态并清除前端提示。
app.post('/api/automation/verification/skip', async (_req, res, next) => {
  try {
    const skipped = engine.skipVerification();
    if (!skipped) throw new Error('当前没有等待人工验证的查询记录');
    res.json({ ok: true, automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/settings', async (_req, res, next) => {
  try {
    res.json(publicSettings(await engine.settings()));
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

app.get('/api/automation/runs', async (_req, res, next) => {
  try {
    res.json({ runs: await engine.listRuns() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/runs', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '运行记录编号', runIdPattern);
    res.json({ runs: await engine.deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/runs/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '运行记录编号', runIdPattern);
    res.json({ runs: await engine.deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/runs/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '运行记录编号', 80);
    if (!runIdPattern.test(id)) throw new RequestValidationError('运行记录编号不合法');
    res.json({ runs: await engine.deleteRuns([id]) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/tasks', async (_req, res, next) => {
  try {
    res.json({ tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    if (body.scope !== 'all' && body.scope !== 'carrier' && body.scope !== 'shipment') throw new RequestValidationError('任务范围不合法');
    const task = await engine.createTask({
      name: typeof body.name === 'string' ? body.name : '',
      scope: body.scope,
      carrierCodes: optionalStringArray(body.carrierCodes, '船司编号', { maxItems: 15, maxLength: 24 }) || [],
      shipmentIds: optionalStringArray(body.shipmentIds, '船期编号', { maxItems: 100, maxLength: 40 }) || [],
      scheduleTime: body.scheduleTime === null ? null : optionalString(body.scheduleTime, '任务时间', 5) || null,
    });
    res.json({ task, tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/automation/tasks/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    if (typeof body.enabled !== 'boolean') throw new RequestValidationError('enabled 必须是布尔值');
    res.json({ task: await engine.updateTask(id, { enabled: body.enabled }), tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    res.json({ tasks: await engine.deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    res.json({ tasks: await engine.deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    res.json({ tasks: await engine.deleteTasks([id]) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/:id/run', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const id = requiredString(req.params.id, '任务编号', 100);
    if (!taskIdPattern.test(id)) throw new RequestValidationError('任务编号不合法');
    const run = await engine.runTask(id, req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(), automation: await engine.status(), tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/run-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '任务编号', taskIdPattern);
    const runs = [];
    for (const id of ids) {
      runs.push(await engine.runTask(id, req.get('x-idempotency-key') ? `${req.get('x-idempotency-key')}:${id}` : undefined));
      lastSync = runs[runs.length - 1].finishedAt;
    }
    res.json({ runs, dashboard: await dashboardPayload(), automation: await engine.status(), tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/carriers', (_req, res) => {
  res.json({ carriers: ALL_CARRIER_RULES });
});

async function sendEvidence(res: express.Response, directory: string, requestedName: string) {
  const fileName = path.basename(requestedName);
  if (fileName !== requestedName || !/\.png$/i.test(fileName)) {
    res.status(400).json({ error: '证据文件名不合法' });
    return;
  }
  const filePath = path.join(directory, fileName);
  try {
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: '证据文件不存在' });
  }
}

// 只暴露截图证据，不直接暴露 data/sources（其中包含 Cookie/storage state）。
app.get('/api/browser-evidence/:carrier/:filename', async (req, res, next) => {
  try {
    const carrier = safeSourceCode(req.params.carrier);
    if (carrier !== req.params.carrier.toUpperCase()) {
      res.status(400).json({ error: '船司标识不合法' });
      return;
    }
    await sendEvidence(res, sourceEvidenceDirectory(engine.store.dataDirectory, carrier), req.params.filename);
  } catch (error) {
    next(error);
  }
});

// 兼容升级前已写入的扁平证据路径。
app.get('/api/browser-evidence/:filename', async (req, res, next) => {
  try {
    await sendEvidence(res, legacyEvidenceDirectory(engine.store.dataDirectory), req.params.filename);
  } catch (error) {
    next(error);
  }
});

app.get('/api/backups', async (_req, res, next) => {
  try {
    res.json({ backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/backups/:name', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    const filePath = engine.store.backupPath(name);
    await fs.access(filePath);
    res.download(filePath, name, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/create', auth.requireRole('admin'), async (_req, res, next) => {
  try {
    if (!(await engine.store.exists())) throw new Error('尚未导入 Excel，无法创建备份');
    const backupPath = await engine.store.backup('手动创建备份');
    res.json({ backupPath, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const names = recordIds(req.body?.names, '备份文件名', backupNamePattern, 100);
    for (const name of [...new Set(names)]) await engine.store.deleteBackup(name);
    res.json({ ok: true, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/:name/restore', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    const workbook = await engine.store.restore(name);
    await engine.syncDatabaseFromWorkbook();
    lastSync = new Date().toISOString();
    res.json({ workbook, backups: await engine.store.listBackups(), dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/backups/:name', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const name = requiredString(req.params.name, '备份文件名', 180);
    if (!backupNamePattern.test(name) || path.basename(name) !== name) throw new RequestValidationError('备份文件名不合法');
    await engine.store.deleteBackup(name);
    res.json({ ok: true, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/intake', auth.requireRole('admin'), async (req, res, next) => {
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
    const result = await engine.store.appendRecords(normalized);
    await engine.syncDatabaseFromWorkbook();
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
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

app.patch('/api/shipments/:id/mark', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const result = await engine.updateManualMark(workbookRowId(req.params.id), body.manualMark);
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '船期编号', shipmentIdPattern, 200);
    const rowNumbers = ids.map(workbookRowId);
    const result = await engine.deleteShipments(rowNumbers);
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/export', async (req, res, next) => {
  try {
    const ids = recordIds(req.body?.ids, '船期编号', shipmentIdPattern, 500);
    const buffer = await engine.store.exportRecords(ids.map(workbookRowId));
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('船期筛选结果.xlsx')}`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/manual', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const result = await engine.manualAppend({
      billNo: typeof body.billNo === 'string' ? body.billNo : '',
      containerNo: typeof body.containerNo === 'string' ? body.containerNo : '',
      carrierHint: typeof body.carrierHint === 'string' ? body.carrierHint : '',
      arrivalTime: body.arrivalTime,
      dischargeTime: body.dischargeTime,
      vesselState: body.vesselState,
      note: typeof body.note === 'string' ? body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/shipments/:id/manual', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body);
    const result = await engine.manualUpdate(workbookRowId(req.params.id), {
      arrivalTime: body.arrivalTime,
      dischargeTime: body.dischargeTime,
      vesselState: body.vesselState,
      note: typeof body.note === 'string' ? body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/run', async (req, res, next) => {
  try {
    const body = assertBodyObject(req.body || {});
    const carrierCodes = optionalStringArray(body.carrierCodes, '船司编号', { maxItems: 15, maxLength: 24 });
    const shipmentIds = optionalStringArray(body.shipmentIds, '船期编号', { maxItems: 200, maxLength: 40 });
    for (const id of shipmentIds || []) if (!shipmentIdPattern.test(id)) throw new RequestValidationError('船期编号不合法');
    const run = await engine.run('manual', carrierCodes?.length || shipmentIds?.length ? { carrierCodes, shipmentIds } : undefined, req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync', async (_req, res, next) => {
  try {
    if (!(await engine.store.exists())) throw new Error('请先导入 Excel 或新增单号');
    const run = await engine.run('manual', undefined, _req.get('x-idempotency-key'));
    lastSync = run.finishedAt;
    res.json(await dashboardPayload());
  } catch (error) {
    next(error);
  }
});

app.post('/api/workbooks/upload', auth.requireRole('admin'), upload.single('workbook'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('请选择 .xlsx 文件');
    const workbook = await engine.store.install(req.file.path);
    await engine.syncDatabaseFromWorkbook();
    res.json({ workbook, automation: await engine.status(), dashboard: await dashboardPayload() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/workbooks/current', async (_req, res, next) => {
  try {
    if (!(await engine.store.exists())) throw new Error('尚未导入 Excel 文件');
    res.download(engine.store.currentPath, '船期自动更新.xlsx');
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
  console.log('Schedules enabled: 09:00, 11:00, 17:30 Asia/Shanghai');
  console.log(`PostgreSQL: ${database.enabled ? 'enabled' : 'disabled (set DATABASE_URL to enable)'}`);
});
// 防止慢请求长期占用连接，浏览器抓取本身使用独立的 Playwright 超时。
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { void database.close().finally(() => process.exit(0)); });
  });
}
