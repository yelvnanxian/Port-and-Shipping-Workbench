import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  legacyStatePath,
  safeSourceCode,
  sourceEvidenceDirectory,
  sourceEvidenceUrl,
  sourceStatePath,
  saveEvidenceScreenshot,
} from './source-storage.js';

test('船司运行目录使用安全且稳定的代码隔离', () => {
  assert.equal(safeSourceCode('oocl'), 'OOCL');
  assert.equal(safeSourceCode('../cookies'), '___COOKIES');
  assert.equal(sourceEvidenceDirectory('/tmp/data', 'oocl'), '/tmp/data/sources/OOCL/evidence');
  assert.equal(sourceStatePath('/tmp/data', 'oocl'), '/tmp/data/sources/OOCL/browser-state/OOCL.json');
  assert.equal(legacyStatePath('/tmp/data', 'oocl'), '/tmp/data/browser-state/OOCL.json');
  assert.equal(sourceEvidenceUrl('oocl', 'capture.png'), '/api/browser-evidence/OOCL/capture.png');
});

test('同一船司和同一提单/柜号只保留最新证据', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-evidence-'));
  const page = { screenshot: async ({ path: target }: { path: string; fullPage: boolean }) => fs.writeFile(target, 'capture') };
  const first = await saveEvidenceScreenshot(page, root, 'ONE', 'ONEY123_CONTAINER1234567', 'success');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await saveEvidenceScreenshot(page, root, 'ONE', 'ONEY123_CONTAINER1234567', 'success');
  const files = await fs.readdir(path.join(root, 'sources', 'ONE'));
  assert.equal(files.length, 1);
  assert.notEqual(first, second);
  assert.match(second || '', /\/api\/browser-evidence\/ONE\//);
});
