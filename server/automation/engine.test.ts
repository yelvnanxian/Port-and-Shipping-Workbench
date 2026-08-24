import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationEngine, deriveManualVesselState, evidencePathFromNote, failureEvidencePathFromNote } from './engine.js';
import type { TrackingProvider } from './tracker.js';
import { trackingError } from './errors.js';
import { WorkbookStore } from './workbook.js';
import { SerialExecutionCoordinator } from './concurrency.js';

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待运行进度更新超时');
}

test('等待其他账号任务时状态会显示排队数量', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-global-queue-'));
  const coordinator = new SerialExecutionCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = coordinator.run(() => gate);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const engine = new AutomationEngine(new WorkbookStore(root), undefined, { runCoordinator: coordinator });
    const run = engine.run('manual').catch(() => undefined);
    await waitFor(async () => (await engine.status()).queuedRuns === 1);
    const status = await engine.status();
    assert.equal(status.running, false);
    assert.equal(status.queuedRuns, 1);
    release();
    await Promise.all([blocker, run]);
  } finally {
    release();
    await blocker.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('从成功备注中解析浏览器采集证据', () => {
  const evidencePath = '/api/browser-evidence/2026-08-19_MSC_MEDUPN815212_success.png';
  assert.equal(
    evidencePathFromNote(`到港字段=ETA；查询成功；来源=https://example.com/track；成功证据=${evidencePath}`),
    evidencePath,
  );
});

test('总览能识别浏览器结果中的已识别运行线路', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-route-note-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'COSU6503130310', containerNo: 'OOCU0872637', carrierHint: '中远海运' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.note = '中远海运浏览器模拟查询成功；已识别运行线路=Xingang, CN → Houston, US';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);
    const [dashboardRecord] = await new AutomationEngine(store).dashboardRecords();
    assert.equal(dashboardRecord.route, 'Xingang, CN → Houston, US');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('COSCO 成功查询会持久化完整轨迹并在总览返回结构化详情', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-tracking-detail-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'COSU6503130310', containerNo: 'OOCU0872637' }]);
    const engine = new AutomationEngine(store);
    const provider: TrackingProvider = {
      async query(input) {
        return {
          arrivalTime: new Date('2026-08-06T16:07:44.000Z'),
          arrivalKind: 'ATA' as const,
          arrived: true,
          discharged: true,
          dischargeTime: null,
          rawSummary: '中远海运真实页面查询成功',
          sourceUrl: input.rule.url,
          trackingDetail: {
            carrierCode: 'COSCO',
            queryType: input.queryType,
            queryValue: input.queryBillNo,
            capturedAt: '2026-08-22T00:00:00.000Z',
            routeStops: [{ name: 'Xingang', role: 'loading' as const }, { name: 'Houston', role: 'discharge' as const }],
            events: [{ label: '实际到港', eventType: 'arrival' as const, location: 'Houston', time: '2026-08-06T16:07:44.000Z', actual: true, cargoState: 'laden' as const }],
          },
          rawPageText: '提单号 6503130310\nXingang\nHouston\n实际到港 2026-08-06 11:07:44 CDT',
        };
      },
    };
    Object.defineProperty(engine, 'provider', { value: () => provider });
    const summary = await engine.run('manual');
    assert.equal(summary.success, 1);
    const dashboard = await engine.dashboardRecords();
    assert.equal(dashboard[0].trackingDetail?.routeStops[1].name, 'Houston');
    assert.equal(dashboard[0].record.vesselState, '已到港已卸船');
    assert.equal(dashboard[0].record.dischargeTime, null);
    assert.ok(dashboard[0].trackingDetailUrl?.endsWith('.json'));
    const fileName = dashboard[0].trackingDetailUrl!.split('/').at(-1)!;
    const stored = await engine.readTrackingDetail('COSCO', fileName);
    assert.match(stored.rawPageText, /实际到港/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('COSCO 查询失败会移除旧的轨迹详情，避免展示过期线路', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-tracking-detail-failure-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'COSU6503130310', containerNo: 'OOCU0872637' }]);
    const engine = new AutomationEngine(store);
    const successProvider: TrackingProvider = {
      async query(input) {
        return {
          arrivalTime: new Date('2026-08-06T16:07:44.000Z'), arrivalKind: 'ATA' as const, arrived: true, dischargeTime: null,
          rawSummary: '成功', sourceUrl: input.rule.url,
          trackingDetail: { carrierCode: 'COSCO', queryType: input.queryType, queryValue: input.queryBillNo, capturedAt: new Date().toISOString(), routeStops: [{ name: 'Houston', role: 'discharge' as const }], events: [] },
          rawPageText: '提单号 6503130310 Houston 实际到港',
        };
      },
    };
    Object.defineProperty(engine, 'provider', { value: () => successProvider, configurable: true });
    await engine.run('manual');
    Object.defineProperty(engine, 'provider', { value: () => ({ async query() { throw new Error('官网暂时不可用'); } }), configurable: true });
    const failure = await engine.run('manual', { skipCompleted: false });
    assert.equal(failure.failed, 1);
    assert.equal((await engine.dashboardRecords())[0].trackingDetail, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('失败截图不会被当作成功采集证据', () => {
  const note = '失败分类=验证码或风控；浏览器证据=/api/browser-evidence/failure.png';
  assert.equal(
    evidencePathFromNote(note),
    '',
  );
  assert.equal(failureEvidencePathFromNote(note), '/api/browser-evidence/failure.png');
});

test('达飞普通浏览器采集会解析真实页面并写回 Excel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-manual-browser-cma-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'CMDUNGP4005669', containerNo: 'TDSU8099791' }]);
    const engine = new AutomationEngine(store);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    const result = await engine.applyManualBrowserCapture(record.rowNumber, {
      queryType: 'bill',
      pageUrl: 'https://www.cma-cgm.com/ebusiness/tracking',
      pageText: [
        'Bill of Lading CMDUNGP4005669',
        'Container TDSU8099791',
        'Port of Loading SHANGHAI, CN',
        'Port of Discharge LOS ANGELES, US',
        'Actual arrival at destination 20 Aug 2026 09:30',
        'LOS ANGELES, US',
        'Discharged from vessel 20 Aug 2026 15:20',
        'LOS ANGELES, US',
      ].join('\n'),
      screenshot: Buffer.from('fake-png'),
    });
    assert.equal(result.record.vesselState, '已到港已卸船');
    assert.equal(result.record.arrivalTime, '20 Aug 2026 09:30');
    assert.equal(result.record.dischargeTime, '20 Aug 2026 15:20');
    assert.match(result.record.note, /普通浏览器人工采集/);
    assert.match(result.result.evidencePath || '', /\/api\/browser-evidence\/CMA\//);
    const dashboard = await engine.dashboardRecords();
    assert.equal(dashboard[0].route, 'SHANGHAI, CN → LOS ANGELES, US');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('官网仅确认已卸船时不会继续沿用与 ATA 完全相同的可疑卸船时间', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-suspicious-discharge-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'COSU6503130310', containerNo: 'OOCU0872637', carrierHint: '中远海运' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.arrivalTime = '2026-08-06 11:07:44（官网当地时间）';
    record.dischargeTime = '2026-08-06 11:07:44（官网当地时间）';
    record.vesselState = '已到港已卸船';
    record.progress = '已完成';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);

    const engine = new AutomationEngine(store);
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query(input: { rule: { url: string } }) {
        return {
          arrivalTime: null,
          arrivalTimeText: '2026-08-06 11:07:44 CDT（官网当地时间）',
          arrivalKind: 'ATA' as const,
          arrived: true,
          discharged: true,
          dischargeTime: null,
          rawSummary: '官网后续提货事件确认已卸船，但未提供精确卸船时刻',
          sourceUrl: input.rule.url,
        };
      },
    }) });
    const summary = await engine.run('manual', { shipmentIds: [`XLSX-${record.rowNumber}`] });
    assert.equal(summary.success, 1);
    const refreshed = await store.open();
    const [updated] = store.readRecords(refreshed.sheet, refreshed.headerMap);
    assert.equal(updated.dischargeTime, null);
    assert.equal(updated.vesselState, '已到港已卸船');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automation status exposes live per-record progress', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-progress-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([
      { billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' },
      { billNo: 'EGLV1234567890', containerNo: 'EGHU1234567' },
    ]);
    const engine = new AutomationEngine(store);
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const provider: TrackingProvider = {
      async query(input) {
        if (input.originalBillNo.startsWith('EGLV')) await secondGate;
        return {
          arrivalTime: new Date('2026-08-19T00:00:00.000Z'),
          arrivalKind: 'ATA',
          arrived: true,
          dischargeTime: new Date('2026-08-19T02:00:00.000Z'),
          rawSummary: '测试官网结果',
          sourceUrl: input.rule.url,
        };
      },
    };
    Object.defineProperty(engine, 'provider', { value: () => provider });

    const running = engine.run('manual');
    await waitFor(async () => (await engine.status()).currentRun?.completed === 1);
    const status = await engine.status();
    assert.equal(status.running, true);
    assert.equal(status.currentRun?.phase, 'querying');
    assert.equal(status.currentRun?.total, 2);
    assert.equal(status.currentRun?.completed, 1);
    assert.equal(status.currentRun?.success, 1);
    assert.equal(status.currentRun?.failed, 0);
    assert.deepEqual(status.currentRun?.currentBills, [{ billNo: 'EGLV1234567890', carrier: '长荣' }]);

    releaseSecond();
    const summary = await running;
    assert.equal(summary.success, 2);
    assert.equal((await engine.status()).currentRun, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automation run completes when every workbook record is skipped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-skipped-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.vesselState = '已到港已卸船';
    record.progress = '已完成';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);

    const engine = new AutomationEngine(store);
    const summary = await engine.run('manual');
    assert.equal(summary.total, 0);
    assert.equal(summary.skipped, 1);
    assert.equal((await engine.status()).running, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('查询失败时清理上一次自动结果，避免失败进度与旧状态矛盾', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-failure-clears-stale-result-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887', carrierHint: '东方海外' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.arrivalTime = new Date('2026-08-13T06:31:00.000Z');
    record.dischargeTime = new Date('2026-08-13T06:31:00.000Z');
    record.vesselState = '已到港已卸船';
    record.progress = '已完成';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);

    const engine = new AutomationEngine(store);
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query() {
        throw new Error('模拟官网暂时不可用');
      },
    }) });
    const summary = await engine.run('manual', { skipCompleted: false });
    assert.equal(summary.failed, 1);

    const refreshed = await store.open();
    const [failed] = store.readRecords(refreshed.sheet, refreshed.headerMap);
    assert.equal(failed.arrivalTime, null);
    assert.equal(failed.dischargeTime, null);
    assert.equal(failed.vesselState, '');
    assert.equal(failed.progress, '失败');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('同一船司触发风控后暂停剩余订单，但其他船司继续查询', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-carrier-circuit-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([
      { billNo: 'OOLU0000000001', containerNo: 'OOCU0000001', carrierHint: '东方海外' },
      { billNo: 'OOLU0000000002', containerNo: 'OOCU0000002', carrierHint: '东方海外' },
      { billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329', carrierHint: '合德' },
    ]);
    const engine = new AutomationEngine(store);
    const calls: string[] = [];
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query(input: { originalBillNo: string; rule: { code: string; url: string } }) {
        calls.push(input.originalBillNo);
        if (input.rule.code === 'OOCL') throw trackingError('验证码或风控', '模拟东方海外图形验证');
        return {
          arrivalTime: new Date('2026-08-20T00:00:00.000Z'),
          arrivalKind: 'ATA' as const,
          arrived: true,
          dischargeTime: null,
          rawSummary: '合德测试结果',
          sourceUrl: input.rule.url,
        };
      },
    }) });
    const summary = await engine.run('manual');
    assert.equal(summary.success, 1);
    assert.equal(summary.failed, 2);
    assert.deepEqual(calls, ['OOLU0000000001', 'HDUJGLA26BZ04040']);
    const opened = await store.open();
    const rows = store.readRecords(opened.sheet, opened.headerMap);
    assert.match(rows[0].note, /模拟东方海外图形验证/);
    assert.match(rows[1].note, /上一条东方海外记录已触发验证或风控/);
    assert.equal(rows[2].progress, '已完成');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('关闭跳过已完成选项时会重新查询已完成卸船记录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-refresh-completed-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.vesselState = '已到港已卸船';
    record.progress = '已完成';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);
    const engine = new AutomationEngine(store);
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query(input: { rule: { url: string } }) {
        return { arrivalTime: new Date('2026-08-21T00:00:00.000Z'), arrivalKind: 'ATA' as const, arrived: true, dischargeTime: new Date('2026-08-21T02:00:00.000Z'), rawSummary: '重新查询结果', sourceUrl: input.rule.url };
      },
    }) });
    const summary = await engine.run('manual', { skipCompleted: false });
    assert.equal(summary.total, 1);
    assert.equal(summary.success, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('显式更新已完成记录时不会被历史状态过滤', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-explicit-refresh-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.vesselState = '已到港已卸船';
    record.progress = '已完成';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);
    const engine = new AutomationEngine(store);
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query(input: { rule: { url: string } }) {
        return { arrivalTime: new Date('2026-08-20T00:00:00.000Z'), arrivalKind: 'ATA' as const, arrived: true, dischargeTime: null, rawSummary: '显式更新结果', sourceUrl: input.rule.url };
      },
    }) });
    const summary = await engine.run('manual', { shipmentIds: [`XLSX-${record.rowNumber}`] });
    assert.equal(summary.total, 1);
    assert.equal(summary.success, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('自定义任务按船司范围运行并支持删除', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-task-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([
      { billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' },
      { billNo: 'EGLV1234567890', containerNo: 'EGHU1234567' },
    ]);
    const engine = new AutomationEngine(store);
    Object.defineProperty(engine, 'provider', { value: () => ({
      async query(input: { rule: { url: string } }) {
        return { arrivalTime: new Date('2026-08-19T00:00:00.000Z'), arrivalKind: 'ATA' as const, arrived: true, dischargeTime: null, rawSummary: '测试官网结果', sourceUrl: input.rule.url };
      },
    }) });
    const task = await engine.createTask({ name: '只更新合德', scope: 'carrier', carrierCodes: ['HEDE'] });
    const run = await engine.runTask(task.id);
    assert.equal(run.total, 1);
    assert.equal(run.success, 1);
    const savedTask = (await engine.listTasks())[0];
    assert.equal(savedTask.lastRunId, run.id);
    await engine.deleteTasks([task.id]);
    assert.deepEqual(await engine.listTasks(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('人工补录和人工修改会写回状态、时间并创建备份', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-manual-'));
  try {
    const store = new WorkbookStore(root);
    const engine = new AutomationEngine(store);
    const created = await engine.manualAppend({
      billNo: 'HDUJGLA26BZ04040',
      containerNo: 'SEKU6633329',
      arrivalTime: '2026-08-20T10:00',
      dischargeTime: '2026-08-20T12:00',
      vesselState: '已到港已卸船',
      note: '码头回执确认',
    });
    assert.equal(created.added.length, 1);
    const opened = await engine.store.open();
    assert.equal(opened.sheet.getCell(2, opened.headerMap.get('船只状态')!).text, '已到港已卸船');
    assert.match(opened.sheet.getCell(2, opened.headerMap.get('备注')!).text, /人工补录/);
    const updated = await engine.manualUpdate(2, {
      arrivalTime: '2026-08-20T11:00',
      dischargeTime: null,
      vesselState: '已到港未卸船',
      note: '卸船尚未完成',
    });
    assert.equal(updated.record.vesselState, '已到港未卸船');
    assert.equal(updated.record.dischargeTime, null);
    assert.match(updated.record.note, /人工修改/);
    assert.ok((await engine.store.listBackups()).length >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('人工时间状态按北京时间判断未来事件，不会提前标记已到港或已卸船', () => {
  const now = new Date('2026-08-24T00:00:00.000Z'); // 北京时间 2026-08-24 08:00
  assert.equal(
    deriveManualVesselState('2026-08-29T10:00', null, '已到港未卸船', now),
    '未到港未卸船',
  );
  assert.equal(
    deriveManualVesselState('2026-08-23T10:00', null, '未到港未卸船', now),
    '已到港未卸船',
  );
  assert.equal(
    deriveManualVesselState('2026-08-23T10:00', '2026-08-29T10:00', '已到港已卸船', now),
    '已到港未卸船',
  );
  assert.equal(
    deriveManualVesselState(null, '2026-08-23T10:00', '未到港未卸船', now),
    '已到港已卸船',
  );
  assert.equal(
    deriveManualVesselState('2026-08-29T10:00', '2026-08-30T10:00', '已到港已卸船', now),
    '未到港未卸船',
  );
  assert.equal(
    deriveManualVesselState(null, null, '已到港已卸船', now),
    '已到港已卸船',
  );
});

test('人工补录保存时会重新校验未来时间对应的船只状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-manual-future-'));
  try {
    const engine = new AutomationEngine(new WorkbookStore(root));
    await engine.manualAppend({
      billNo: 'HDUJGLA26BZ04041',
      arrivalTime: '2099-08-29T10:00',
      dischargeTime: '2099-08-30T10:00',
      vesselState: '已到港已卸船',
    });
    const opened = await engine.store.open();
    assert.equal(opened.sheet.getCell(2, opened.headerMap.get('船只状态')!).text, '未到港未卸船');
    await engine.manualUpdate(2, {
      arrivalTime: '2099-09-01T10:00',
      dischargeTime: '2099-09-02T10:00',
      vesselState: '已到港已卸船',
    });
    const updated = await engine.store.open();
    assert.equal(updated.sheet.getCell(2, updated.headerMap.get('船只状态')!).text, '未到港未卸船');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('标记已清关后移入独立历史并可恢复到船期追踪', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-cleared-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' }]);
    const engine = new AutomationEngine(store);
    let calls = 0;
    Object.defineProperty(engine, 'provider', { value: () => ({ async query() { calls += 1; throw new Error('不应查询已清关记录'); } }) });

    await assert.rejects(
      engine.updateManualMark(2, '已清关', { billNo: 'OOLU0000000000', containerNo: 'OOCU7496887' }),
      /船期记录已发生变化/,
    );
    const archived = await engine.updateManualMark(2, '已清关', { billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' });
    const summary = await engine.run('manual');

    assert.equal(archived.archived, true);
    assert.equal(summary.total, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(calls, 0);
    assert.equal((await store.metadata())?.records, 0);
    assert.equal((await store.metadata())?.queryable, 0);
    const archivedWorkbook = await store.open();
    assert.equal(archivedWorkbook.sheet.getRow(2).hidden, true);
    const history = await engine.listClearanceHistory();
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].billNo, 'OOLU2171963250');
    assert.equal(history.entries[0].manualMark, '已清关');

    await engine.restoreClearanceHistory(history.entries[0].id);
    const restoredWorkbook = await store.open();
    const restored = store.readRecords(restoredWorkbook.sheet, restoredWorkbook.headerMap);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].rowNumber, 2);
    assert.equal(restoredWorkbook.sheet.getRow(2).hidden, false);
    assert.equal(restored[0].manualMark, '');
    assert.equal((await engine.listClearanceHistory()).entries.length, 0);
    assert.ok((await store.listBackups()).length >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('清关历史按 3 天或 7 天保留周期清理到期记录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-clearance-retention-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    const engine = new AutomationEngine(store);
    await engine.setClearanceRetentionDays(3);
    await engine.clearanceHistory.archive(record, new Date('2026-08-01T00:00:00.000Z'));
    const cleanup = await engine.cleanupClearanceHistory(new Date('2026-08-05T00:00:00.000Z'));
    assert.equal(cleanup.deleted, 1);
    assert.equal(cleanup.history.retentionDays, 3);
    assert.equal(cleanup.history.entries.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('旧版 Excel 中已有的已清关标记会自动迁移且不会重复归档', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-clearance-migration-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887', manualMark: '已清关' }]);
    const engine = new AutomationEngine(store);
    const first = await engine.migrateClearedRecordsToHistory();
    const second = await engine.migrateClearedRecordsToHistory();
    assert.equal(first.migrated, 1);
    assert.equal(second.migrated, 0);
    assert.equal((await store.metadata())?.records, 0);
    assert.equal((await engine.listClearanceHistory()).entries.length, 1);
    assert.equal((await store.open()).sheet.getRow(2).hidden, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('达飞和赫伯罗特自动更新会安全跳过并保留已有真实数据', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-manual-browser-only-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'CMDUNGP4005669', containerNo: 'TDSU8099791' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.arrivalTime = '20 Aug 2026 09:30';
    record.vesselState = '已到港未卸船';
    record.progress = '已完成';
    record.note = '到港字段=ATA；普通浏览器人工采集';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);

    const engine = new AutomationEngine(store);
    let providerCalls = 0;
    Object.defineProperty(engine, 'provider', { value: () => ({ async query() { providerCalls += 1; throw new Error('不应启动自动化浏览器'); } }) });
    const summary = await engine.run('manual', { shipmentIds: [`XLSX-${record.rowNumber}`] });

    assert.equal(summary.total, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(providerCalls, 0);
    const refreshed = await store.open();
    const [preserved] = store.readRecords(refreshed.sheet, refreshed.headerMap);
    assert.ok(preserved.arrivalTime instanceof Date);
    assert.equal(preserved.arrivalTime.toISOString(), '2026-08-20T01:30:00.000Z');
    assert.equal(preserved.vesselState, '已到港未卸船');
    assert.match(preserved.note, /普通浏览器人工采集/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('删除船期前创建备份并只删除指定记录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-delete-shipment-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([
      { billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' },
      { billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' },
    ]);
    const engine = new AutomationEngine(store);

    const result = await engine.deleteShipments([2]);
    const opened = await store.open();
    const records = store.readRecords(opened.sheet, opened.headerMap);

    assert.equal(result.deleted, 1);
    assert.deepEqual(records.map((record) => record.billNo), ['HDUJGLA26BZ04040']);
    assert.equal((await store.listBackups()).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
