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
