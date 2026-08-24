import assert from 'node:assert/strict';
import test from 'node:test';
import { renderApiEvidenceSvg } from './api-evidence.js';
import { resolveCarrierRule } from './carriers.js';
import type { TrackingResult, WorkbookRecord } from './types.js';

test('官方接口凭证转义外部文本并包含可核验摘要', () => {
  const record: WorkbookRecord = { rowNumber: 2, carrierHint: '美森', billNo: 'MATS7419163000', containerNo: 'MATU2362806', arrivalTime: null, dischargeTime: null, vesselState: '', manualMark: '', lastUpdated: null, note: '', progress: '' };
  const result: TrackingResult = {
    arrivalTime: null,
    arrivalTimeText: '17-Aug-2026 08:48 AM',
    arrivalKind: 'ETA',
    arrived: false,
    dischargeTime: null,
    rawSummary: '<script>alert(1)</script>',
    sourceUrl: 'https://api.cargo.chinamatson.com/test',
    routeText: 'SHEKOU & CSL → LONG BEACH <CA>',
    rawPageText: '{"safe":true}',
  };
  const svg = renderApiEvidenceSvg(record, resolveCarrierRule(record), result, '2026-08-22T12:00:00.000Z');
  assert.match(svg, /官方接口采集凭证/);
  assert.match(svg, /api\.cargo\.chinamatson\.com/);
  assert.match(svg, /SHEKOU &amp; CSL/);
  assert.doesNotMatch(svg, /LONG BEACH <CA>/);
  assert.match(svg, /原始响应 SHA-256：[a-f0-9]{64}/);
});
