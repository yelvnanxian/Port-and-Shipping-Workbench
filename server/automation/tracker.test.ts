import assert from 'node:assert/strict';
import test from 'node:test';
import { CachedTrackingProvider } from './tracker.js';
import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery } from './types.js';

const input: TrackingQuery = {
  rule: { prefix: 'ONEY', code: 'ONE', name: '海洋网联', removePrefix: true, queryMode: 'bill-or-container', url: 'https://example.com', integration: 'ready', integrationMessage: '' },
  originalBillNo: 'ONEY0000001',
  queryBillNo: '0000001',
  containerNo: 'ONEU0000001',
  queryType: 'bill',
};

function result(query: TrackingQuery) {
  return {
    arrivalTime: null,
    arrivalKind: null,
    arrived: false,
    dischargeTime: null,
    rawSummary: query.queryType,
    sourceUrl: query.rule.url,
  } as const;
}

test('批量查询缓存复用同一查询并合并并发请求', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner: TrackingProvider = {
    async query(query) {
      calls += 1;
      await gate;
      return result(query);
    },
  };
  const provider = new CachedTrackingProvider(inner);
  const first = provider.query(input);
  const second = provider.query({ ...input });
  assert.equal(calls, 1);
  release();
  assert.equal((await first).rawSummary, 'bill');
  assert.equal((await second).rawSummary, 'bill');
  assert.equal(calls, 1);
  assert.equal((await provider.query(input)).rawSummary, 'bill');
  assert.equal(calls, 1);
});

test('批量查询缓存按查询类型区分提单号和柜号，失败不缓存', async () => {
  let calls = 0;
  const inner: TrackingProvider = {
    async query(query) {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return result(query);
    },
  };
  const provider = new CachedTrackingProvider(inner);
  await assert.rejects(provider.query(input), /temporary/);
  const container = await provider.query({ ...input, queryType: 'container' });
  assert.equal(container.rawSummary, 'container');
  await provider.query(input);
  assert.equal(calls, 3);
});

test('批量查询缓存只短暂复用明确无结果，验证码和网络异常不缓存', async () => {
  let missCalls = 0;
  const missProvider = new CachedTrackingProvider({
    async query() {
      missCalls += 1;
      throw trackingError('订单号验证失败', '官网明确无此提单号');
    },
  }, 50);
  await assert.rejects(missProvider.query(input), /官网明确无此提单号/);
  await assert.rejects(missProvider.query(input), /官网明确无此提单号/);
  assert.equal(missCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(missProvider.query(input), /官网明确无此提单号/);
  assert.equal(missCalls, 2);

  let blockedCalls = 0;
  const blockedProvider = new CachedTrackingProvider({
    async query() {
      blockedCalls += 1;
      throw trackingError('验证码或风控', '官网要求人工验证');
    },
  });
  await assert.rejects(blockedProvider.query(input), /官网要求人工验证/);
  await assert.rejects(blockedProvider.query(input), /官网要求人工验证/);
  assert.equal(blockedCalls, 2);
});
