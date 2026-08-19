import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationEngine } from './engine.js';
import { WorkbookStore } from './workbook.js';

test('automation settings persist across engine instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-settings-'));
  try {
    const store = new WorkbookStore(root);
    const first = new AutomationEngine(store);
    assert.equal((await first.settings()).enabled, true);
    await first.updateSettings({ enabled: false });
    const second = new AutomationEngine(new WorkbookStore(root));
    assert.equal((await second.settings()).enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('restoring a backup replaces the workbook and creates a safety backup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-restore-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' }]);
    const backup = await store.backup('测试恢复');
    assert.ok(backup);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' }]);
    assert.equal((await store.metadata())?.records, 2);
    await store.restore(path.basename(backup!));
    assert.equal((await store.metadata())?.records, 1);
    assert.equal((await store.listBackups()).length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
