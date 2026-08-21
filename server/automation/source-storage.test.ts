import assert from 'node:assert/strict';
import test from 'node:test';
import {
  legacyStatePath,
  safeSourceCode,
  sourceEvidenceDirectory,
  sourceEvidenceUrl,
  sourceStatePath,
} from './source-storage.js';

test('船司运行目录使用安全且稳定的代码隔离', () => {
  assert.equal(safeSourceCode('oocl'), 'OOCL');
  assert.equal(safeSourceCode('../cookies'), '___COOKIES');
  assert.equal(sourceEvidenceDirectory('/tmp/data', 'oocl'), '/tmp/data/sources/OOCL/evidence');
  assert.equal(sourceStatePath('/tmp/data', 'oocl'), '/tmp/data/sources/OOCL/browser-state/OOCL.json');
  assert.equal(legacyStatePath('/tmp/data', 'oocl'), '/tmp/data/browser-state/OOCL.json');
  assert.equal(sourceEvidenceUrl('oocl', 'capture.png'), '/api/browser-evidence/OOCL/capture.png');
});
