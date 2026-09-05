import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearBrowserProfileCaches } from './browser-lifecycle.js';

test('清理自动化 Profile 时只删除缓存目录并保留验证状态', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-profile-'));
  const profile = path.join(dataDirectory, 'browser-profile', 'OOCL_PATCHRIGHT');
  await fs.mkdir(path.join(profile, 'Default', 'Cache'), { recursive: true });
  await fs.mkdir(path.join(profile, 'Default', 'Local Storage'), { recursive: true });
  await fs.writeFile(path.join(profile, 'Default', 'Cache', 'entry'), 'cache');
  await fs.writeFile(path.join(profile, 'Default', 'Local Storage', 'state'), 'verified');

  const result = await clearBrowserProfileCaches([dataDirectory]);
  assert.equal(result.cacheDirectories, 1);
  await assert.rejects(fs.access(path.join(profile, 'Default', 'Cache')));
  assert.equal(await fs.readFile(path.join(profile, 'Default', 'Local Storage', 'state'), 'utf8'), 'verified');
});
