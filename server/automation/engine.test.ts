import assert from 'node:assert/strict';
import test from 'node:test';
import { evidencePathFromNote } from './engine.js';

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
