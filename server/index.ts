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
import { legacyEvidenceDirectory, safeSourceCode, sourceEvidenceDirectory } from './automation/source-storage.js';
import { AuthService } from './auth.js';
import type { CarrierSource, Shipment } from './types.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.APP_HOST || '127.0.0.1';
const engine = new AutomationEngine();
await engine.store.initialize();
const auth = new AuthService(engine.store.dataDirectory);
startScheduler(engine);

const upload = multer({
  dest: engine.store.uploadDirectory,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    callback(null, /\.xlsx$/i.test(file.originalname));
  },
});

app.disable('x-powered-by');
app.set('trust proxy', process.env.APP_TRUST_PROXY === 'true' ? 1 : false);
app.use(securityHeaders);
app.use(cors({ origin: (origin, callback) => callback(null, corsOrigin(origin)), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
// 留出前端每秒轮询自动化进度的空间；登录和危险操作的更严格限流会在认证阶段单独增加。
app.use(createRateLimiter({ windowMs: 5 * 60 * 1000, max: 1000, name: 'all' }));
app.use('/api', createRateLimiter({ windowMs: 5 * 60 * 1000, max: 600, name: 'api' }));

let lastSync = new Date().toISOString();

app.get('/api/auth/session', (req, res) => {
  const current = auth.sessionFromRequest(req);
  res.json({ enabled: auth.enabled, authenticated: Boolean(current), user: current?.user || null, csrfToken: current?.csrfToken || '' });
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!auth.enabled) { res.json({ enabled: false, authenticated: true, user: { id: 'local-admin', username: 'local-admin', role: 'admin' }, csrfToken: '' }); return; }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
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
    const user = await auth.createUser({
      username: typeof req.body?.username === 'string' ? req.body.username : '',
      password: typeof req.body?.password === 'string' ? req.body.password : '',
      role: req.body?.role,
    });
    res.status(201).json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/auth/users/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    if (req.body?.role !== undefined && typeof req.body.role !== 'string') throw new Error('用户角色不合法');
    if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') throw new Error('账号状态不合法');
    const user = await auth.updateUser(String(req.params.id), {
      role: req.body?.role,
      enabled: req.body?.enabled,
    }, req.authUser!.id);
    res.json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/users/:id/password', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const user = await auth.resetPassword(String(req.params.id), typeof req.body?.password === 'string' ? req.body.password : '', req.authUser!.id);
    res.json({ user, users: await auth.listUsers() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/auth/users/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    res.json({ users: await auth.deleteUser(String(req.params.id), req.authUser!.id) });
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

app.get('/api/automation/settings', async (_req, res, next) => {
  try {
    res.json(publicSettings(await engine.settings()));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/automation/settings', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const patch: { enabled?: boolean; browserAutomationEnabled?: boolean; wechatWebhookUrl?: string } = {};
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      patch.enabled = req.body.enabled;
    }
    if (req.body?.browserAutomationEnabled !== undefined) {
      if (typeof req.body.browserAutomationEnabled !== 'boolean') throw new Error('browserAutomationEnabled 必须是布尔值');
      patch.browserAutomationEnabled = req.body.browserAutomationEnabled;
    }
    if (req.body?.wechatWebhookUrl !== undefined) {
      if (typeof req.body.wechatWebhookUrl !== 'string') throw new Error('企业微信 Webhook 必须是文本');
      const webhook = req.body.wechatWebhookUrl.trim();
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
    const configured = typeof req.body?.wechatWebhookUrl === 'string' ? req.body.wechatWebhookUrl.trim() : (await engine.settings()).wechatWebhookUrl;
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
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (!ids.length) throw new Error('请选择要删除的任务记录');
    res.json({ runs: await engine.deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/runs/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (!ids.length) throw new Error('请选择要删除的任务记录');
    res.json({ runs: await engine.deleteRuns(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/runs/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    res.json({ runs: await engine.deleteRuns([String(req.params.id)]) });
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
    const task = await engine.createTask({
      name: typeof req.body?.name === 'string' ? req.body.name : '',
      scope: req.body?.scope,
      carrierCodes: Array.isArray(req.body?.carrierCodes) ? req.body.carrierCodes.filter((value: unknown): value is string => typeof value === 'string') : [],
      shipmentIds: Array.isArray(req.body?.shipmentIds) ? req.body.shipmentIds.filter((value: unknown): value is string => typeof value === 'string') : [],
      scheduleTime: typeof req.body?.scheduleTime === 'string' ? req.body.scheduleTime : null,
    });
    res.json({ task, tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/automation/tasks/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    res.json({ task: await engine.updateTask(String(req.params.id), { enabled: req.body.enabled }), tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (!ids.length) throw new Error('请选择要删除的自动化任务');
    res.json({ tasks: await engine.deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (!ids.length) throw new Error('请选择要删除的自动化任务');
    res.json({ tasks: await engine.deleteTasks(ids) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/automation/tasks/:id', auth.requireRole('admin'), async (req, res, next) => {
  try {
    res.json({ tasks: await engine.deleteTasks([String(req.params.id)]) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/:id/run', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const run = await engine.runTask(String(req.params.id));
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(), automation: await engine.status(), tasks: await engine.listTasks() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/tasks/run-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (!ids.length) throw new Error('请选择要执行的自动化任务');
    const runs = [];
    for (const id of ids) {
      runs.push(await engine.runTask(id));
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
    const name = String(req.params.name);
    const filePath = engine.store.backupPath(name);
    res.download(filePath, name);
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
    const names: string[] = Array.isArray(req.body?.names) ? req.body.names.filter((name: unknown): name is string => typeof name === 'string') : [];
    if (!names.length) throw new Error('请选择要删除的备份文件');
    for (const name of [...new Set(names)]) await engine.store.deleteBackup(name);
    res.json({ ok: true, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/:name/restore', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const workbook = await engine.store.restore(String(req.params.name));
    lastSync = new Date().toISOString();
    res.json({ workbook, backups: await engine.store.listBackups(), dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/backups/:name', auth.requireRole('admin'), async (req, res, next) => {
  try {
    await engine.store.deleteBackup(String(req.params.name));
    res.json({ ok: true, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/intake', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!entries.length) throw new Error('请至少提供一个提单号');
    const normalized = entries.map((entry: { billNo?: string; containerNo?: string; carrierHint?: string }) => ({
      billNo: entry.billNo || '',
      containerNo: entry.containerNo || '',
      carrierHint: entry.carrierHint || '',
    }));
    const result = await engine.store.appendRecords(normalized);
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
    const result = await engine.updateManualMark(workbookRowId(req.params.id), req.body?.manualMark);
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/delete-batch', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const rowNumbers = ids.map(workbookRowId);
    const result = await engine.deleteShipments(rowNumbers);
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/export', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
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
    const result = await engine.manualAppend({
      billNo: typeof req.body?.billNo === 'string' ? req.body.billNo : '',
      containerNo: typeof req.body?.containerNo === 'string' ? req.body.containerNo : '',
      carrierHint: typeof req.body?.carrierHint === 'string' ? req.body.carrierHint : '',
      arrivalTime: req.body?.arrivalTime,
      dischargeTime: req.body?.dischargeTime,
      vesselState: req.body?.vesselState,
      note: typeof req.body?.note === 'string' ? req.body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/shipments/:id/manual', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const result = await engine.manualUpdate(workbookRowId(req.params.id), {
      arrivalTime: req.body?.arrivalTime,
      dischargeTime: req.body?.dischargeTime,
      vesselState: req.body?.vesselState,
      note: typeof req.body?.note === 'string' ? req.body.note : '',
    });
    res.json({ ...result, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/run', async (req, res, next) => {
  try {
    const carrierCodes = Array.isArray(req.body?.carrierCodes) ? req.body.carrierCodes.filter((value: unknown): value is string => typeof value === 'string') : undefined;
    const shipmentIds = Array.isArray(req.body?.shipmentIds) ? req.body.shipmentIds.filter((value: unknown): value is string => typeof value === 'string') : undefined;
    const run = await engine.run('manual', carrierCodes?.length || shipmentIds?.length ? { carrierCodes, shipmentIds } : undefined);
    lastSync = run.finishedAt;
    res.json({ run, dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync', async (_req, res, next) => {
  try {
    if (!(await engine.store.exists())) throw new Error('请先导入 Excel 或新增单号');
    const run = await engine.run('manual');
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

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ message: error.message || '采集失败，请检查数据源配置' });
});

app.listen(port, host, () => {
  console.log(`Port operations API listening on http://${host}:${port}`);
  console.log('Schedules enabled: 09:00, 11:00, 17:30 Asia/Shanghai');
});
