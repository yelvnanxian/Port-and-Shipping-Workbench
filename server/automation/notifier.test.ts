import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWeComRunContent, summarizeFailures } from './notifier.js';
import type { FailedTrackingDetail, RunSummary } from './types.js';

function failedDetail(overrides: Partial<FailedTrackingDetail> = {}): FailedTrackingDetail {
  return {
    carrier: '东方海外',
    carrierCode: 'OOCL',
    billNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    category: '验证码或风控',
    reason: 'Cloudflare 验证失败，具体错误不应出现在企业微信',
    sourceUrl: 'https://example.com/private-query',
    evidencePath: '/tmp/browser-evidence/failure.png',
    ...overrides,
  };
}

function runSummary(failedDetails: FailedTrackingDetail[]): RunSummary {
  return {
    id: 'test-run',
    reason: 'manual',
    startedAt: '2026-08-20T01:00:00.000Z',
    finishedAt: '2026-08-20T01:05:00.000Z',
    total: 5,
    success: 1,
    unfinished: 1,
    failed: failedDetails.length,
    skipped: 0,
    failedBills: failedDetails.map((detail) => detail.billNo),
    failedDetails,
    backupPath: null,
    notification: 'skipped',
  };
}

test('failure summary groups by carrier and category without detailed diagnostics', () => {
  const details = [
    failedDetail(),
    failedDetail({ billNo: 'OOLU2171963251', containerNo: 'OOCU7496888' }),
    failedDetail({ carrier: '达飞', carrierCode: 'CMA CGM', billNo: 'CMDU1234567890', category: '官网接口异常' }),
  ];

  const content = buildWeComRunContent(runSummary(details));

  assert.match(content, /失败概况：/);
  assert.match(content, /东方海外 2 票（验证码或风控）：OOLU2171963250、OOLU2171963251/);
  assert.match(content, /达飞 1 票（官网接口异常）：CMDU1234567890/);
  assert.doesNotMatch(content, /OOCU7496887|Cloudflare|example\.com|browser-evidence/);
});

test('failure summary limits bill examples and reports no failures clearly', () => {
  const details = Array.from({ length: 5 }, (_, index) => failedDetail({ billNo: `OOLU217196325${index}` }));

  assert.equal(
    summarizeFailures(details),
    '东方海外 5 票（验证码或风控）：OOLU2171963250、OOLU2171963251、OOLU2171963252 等 5 票',
  );
  assert.equal(summarizeFailures([]), '无');
});
