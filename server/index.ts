import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CARRIER_RULES } from './automation/carriers.js';
import { AutomationEngine } from './automation/engine.js';
import { notifyWeComTest } from './automation/notifier.js';
import { startScheduler } from './automation/scheduler.js';
import type { CarrierSource, Shipment } from './types.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const engine = new AutomationEngine();
await engine.store.initialize();
startScheduler(engine);

const upload = multer({
  dest: engine.store.uploadDirectory,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    callback(null, /\.xlsx$/i.test(file.originalname));
  },
});

app.use(cors());
app.use(express.json());

let lastSync = new Date().toISOString();

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
    const shipments: Shipment[] = workbookRecords.map(({ record, carrier, carrierCode, sourceUrl, evidencePath, verificationNo }) => ({
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
      progress: record.progress || '待查询',
      sourceUrl,
      evidencePath,
      verificationNo,
    }));
    return { shipments, sources: buildSources(shipments, generatedAt), generatedAt };
  }
  return { shipments: [], sources: [], generatedAt };
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, lastSync, automation: await engine.status() });
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

app.patch('/api/automation/settings', async (req, res, next) => {
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

app.post('/api/automation/test-notification', async (req, res, next) => {
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

app.get('/api/carriers', (_req, res) => {
  res.json({ carriers: ALL_CARRIER_RULES });
});

app.use('/api/browser-evidence', express.static(path.join(engine.store.dataDirectory, 'browser-evidence'), {
  fallthrough: false,
  index: false,
}));

app.get('/api/backups', async (_req, res, next) => {
  try {
    res.json({ backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/backups/:name', async (req, res, next) => {
  try {
    const filePath = engine.store.backupPath(req.params.name);
    res.download(filePath, req.params.name);
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/create', async (_req, res, next) => {
  try {
    if (!(await engine.store.exists())) throw new Error('尚未导入 Excel，无法创建备份');
    const backupPath = await engine.store.backup('手动创建备份');
    res.json({ backupPath, backups: await engine.store.listBackups() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups/:name/restore', async (req, res, next) => {
  try {
    const workbook = await engine.store.restore(req.params.name);
    lastSync = new Date().toISOString();
    res.json({ workbook, backups: await engine.store.listBackups(), dashboard: await dashboardPayload(), automation: await engine.status() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/intake', async (req, res, next) => {
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

app.post('/api/automation/run', async (_req, res, next) => {
  try {
    const run = await engine.run('manual');
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

app.post('/api/workbooks/upload', upload.single('workbook'), async (req, res, next) => {
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

app.listen(port, () => {
  console.log(`Port operations API listening on http://localhost:${port}`);
  console.log('Schedules enabled: 09:00, 11:00, 17:30 Asia/Shanghai');
});
