import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationEngine } from './engine.js';
import { WorkbookStore } from './workbook.js';

test('opening a legacy workbook adds the manual mark column without losing data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-legacy-mark-'));
  try {
    const store = new WorkbookStore(root);
    await store.initialize();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('船期追踪');
    sheet.addRow(['船司', '到港时间', '提单号', '柜号', '卸船时间', '船只状态', '最后更新时间', '备注', '进度']);
    sheet.addRow(['东方海外', '', 'OOLU2171963250', 'OOCU7496887', '未卸船', '未到港未卸船', '', '真实订单', '待查询']);
    await workbook.xlsx.writeFile(store.currentPath);

    const opened = await store.open();
    const records = store.readRecords(opened.sheet, opened.headerMap);

    assert.ok(opened.headerMap.has('人工标记'));
    assert.equal(records[0].billNo, 'OOLU2171963250');
    assert.equal(records[0].manualMark, '');
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(store.currentPath);
    assert.ok((reopened.worksheets[0].getRow(1).values as ExcelJS.CellValue[]).includes('人工标记'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automation settings persist across engine instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-settings-'));
  try {
    const store = new WorkbookStore(root);
    const first = new AutomationEngine(store);
    assert.equal((await first.settings()).enabled, true);
    await first.updateSettings({ enabled: false, wechatWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test' });
    const second = new AutomationEngine(new WorkbookStore(root));
    const settings = await second.settings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.browserAutomationEnabled, true);
    assert.equal(settings.wechatWebhookUrl, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workbook store supports isolated per-user data directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-workspaces-'));
  try {
    const admin = new WorkbookStore(root);
    const user = new WorkbookStore(root, path.join(root, 'data', 'workspaces', 'user-a'));
    await admin.appendRecords([{ billNo: 'OOLU2171963250' }]);
    await user.appendRecords([{ billNo: 'HDUJGLA26BZ04040' }]);
    assert.equal((await admin.metadata())?.records, 1);
    assert.equal((await user.metadata())?.records, 1);
    assert.notEqual(admin.currentPath, user.currentPath);
    assert.match(user.currentPath, /workspaces[\\/]user-a[\\/]current\.xlsx$/);
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

test('deleting a backup also removes its metadata and rejects unsafe names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-delete-backup-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' }]);
    const backup = await store.backup('测试删除');
    assert.ok(backup);
    const name = path.basename(backup!);
    await fs.access(`${backup}.json`);

    await store.deleteBackup(name);

    assert.equal((await store.listBackups()).length, 0);
    await assert.rejects(() => fs.access(backup!));
    await assert.rejects(() => fs.access(`${backup}.json`));
    await assert.rejects(() => store.deleteBackup('../current.xlsx'), /备份文件名不合法/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writing results preserves empty cells and makes failure details readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-layout-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([{ billNo: 'OOLU2171963250', containerNo: 'OOCU7496887', carrierHint: '东方海外' }]);
    const opened = await store.open();
    const [record] = store.readRecords(opened.sheet, opened.headerMap);
    record.arrivalTime = null;
    record.vesselState = '';
    record.note = '失败分类=官网接口异常；船司=东方海外；提单号=OOLU2171963250；柜号=OOCU7496887；原因=官方查询暂不可用';
    record.progress = '失败';
    store.writeRecord(opened.sheet, opened.headerMap, record);
    await store.save(opened.workbook);

    const saved = await store.open();
    const row = saved.sheet.getRow(2);
    assert.equal(row.getCell(saved.headerMap.get('到港时间')!).value, null);
    assert.equal(row.getCell(saved.headerMap.get('船只状态')!).value, null);
    assert.ok(saved.sheet.getColumn(saved.headerMap.get('备注')!).width! >= 72);
    assert.ok(row.height! >= 36);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('filtered export contains only requested workbook rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-workbench-filter-export-'));
  try {
    const store = new WorkbookStore(root);
    await store.appendRecords([
      { billNo: 'OOLU2171963250', containerNo: 'OOCU7496887' },
      { billNo: 'HDUJGLA26BZ04040', containerNo: 'SEKU6633329' },
    ]);

    const buffer = await store.exportRecords([3]);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(new Uint8Array(buffer).buffer);
    const sheet = exported.worksheets[0];

    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getRow(2).getCell(3).text, 'HDUJGLA26BZ04040');
    assert.equal(sheet.getRow(2).getCell(7).text, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
