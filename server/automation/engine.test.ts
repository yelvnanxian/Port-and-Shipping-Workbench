import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationEngine, evidencePathFromNote } from './engine.js';
import type { TrackingProvider } from './tracker.js';
import { WorkbookStore } from './workbook.js';

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待运行进度更新超时');
}

test('从成功备注中解析浏览器采集证据', () => {
  const evidencePath = '/api/browser-evidence/2026-08-19_MSC_MEDUPN815212_success.png';
  assert.equal(
    evidencePathFromNote(`到港字段=ETA；查询成功；来源=https://example.com/track；成功证据=${evidencePath}`),
    evidencePath,
  );
});

test('失败截图不会被当作成功采集证据', () => {
  assert.equal(
    evidencePathFromNote('失败分类=验证码或风控；浏览器证据=/api/browser-evidence/failure.png'),
    '',
  );
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
