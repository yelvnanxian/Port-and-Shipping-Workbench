import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createAppDatabase } from '../database.js';
import { AutomationEngine } from './engine.js';
import { WorkbookStore } from './workbook.js';

test('PostgreSQL 按 workspace_id 隔离设置和自动化任务', async (t) => {
  const testDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) {
    t.skip('未配置 POSTGRES_TEST_DATABASE_URL，跳过 PostgreSQL 隔离集成测试');
    return;
  }

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl;
  const database = createAppDatabase();
  assert.equal(database.enabled, true);
  await database.migrate();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceA = `test-a-${suffix}`;
  const workspaceB = `test-b-${suffix}`;
  const directoryA = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-db-a-'));
  const directoryB = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-db-b-'));
  const engineA = new AutomationEngine(new WorkbookStore(directoryA, directoryA), database, { workspaceId: workspaceA });
  const engineB = new AutomationEngine(new WorkbookStore(directoryB, directoryB), database, { workspaceId: workspaceB });

  try {
    const writeWorkbook = async (directory: string, billNo: string, containerNo: string) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('船期');
      sheet.addRow(['船司', '到港时间', '提单号', '柜号', '卸船时间', '船只状态', '人工标记', '最后更新时间', '备注', '进度']);
      sheet.addRow(['东方海外', '', billNo, containerNo, '未卸船', '未到港未卸船', '', '', '', '待查询']);
      await workbook.xlsx.writeFile(path.join(directory, 'current.xlsx'));
    };
    await writeWorkbook(directoryA, `TEST-A-${suffix}`, `TSTA${suffix.replace(/\D/g, '').slice(-7).padStart(7, '0')}`);
    await writeWorkbook(directoryB, `TEST-B-${suffix}`, `TSTB${suffix.replace(/\D/g, '').slice(-7).padStart(7, '0')}`);
    await engineA.syncDatabaseFromWorkbook();
    await engineB.syncDatabaseFromWorkbook();

    await engineA.updateSettings({ browserAutomationEnabled: false });
    await engineA.createTask({ name: '隔离测试任务', scope: 'all', scheduleTime: '08:30' });

    assert.equal((await engineA.settings()).browserAutomationEnabled, false);
    assert.equal((await engineB.settings()).browserAutomationEnabled, true);
    assert.equal((await engineA.listTasks()).length, 1);
    assert.equal((await engineB.listTasks()).length, 0);

    const shipmentRows = await database.query<{ workspace_id: string; bill_no: string }>(
      'SELECT workspace_id, bill_no FROM shipments WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id',
      [[workspaceA, workspaceB]],
    );
    assert.deepEqual(shipmentRows.rows.map((row) => row.workspace_id), [workspaceA, workspaceB].sort());
    assert.equal(shipmentRows.rows.some((row) => row.bill_no.startsWith('TEST-A-')), true);
    assert.equal(shipmentRows.rows.some((row) => row.bill_no.startsWith('TEST-B-')), true);

    const settingsRows = await database.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM automation_settings WHERE workspace_id = ANY($1::text[]) ORDER BY workspace_id',
      [[workspaceA, workspaceB]],
    );
    assert.deepEqual(settingsRows.rows.map((row) => row.workspace_id), [workspaceA, workspaceB].sort());
    const taskRows = await database.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM automation_tasks WHERE workspace_id = ANY($1::text[])',
      [[workspaceA, workspaceB]],
    );
    assert.deepEqual(taskRows.rows.map((row) => row.workspace_id), [workspaceA]);
  } finally {
    await database.query('DELETE FROM automation_settings WHERE workspace_id = ANY($1::text[])', [[workspaceA, workspaceB]]);
    await database.query('DELETE FROM automation_tasks WHERE workspace_id = ANY($1::text[])', [[workspaceA, workspaceB]]);
    await database.query('DELETE FROM automation_runs WHERE workspace_id = ANY($1::text[])', [[workspaceA, workspaceB]]);
    await database.query('DELETE FROM shipments WHERE workspace_id = ANY($1::text[])', [[workspaceA, workspaceB]]);
    await database.close();
    await Promise.all([
      fs.rm(directoryA, { recursive: true, force: true }),
      fs.rm(directoryB, { recursive: true, force: true }),
    ]);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
