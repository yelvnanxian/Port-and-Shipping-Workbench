import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from './rate-limiter.js';

test('速率限制器：不同船司之间独立限流', async () => {
  const limiter = new RateLimiter(60);  // 默认 60 次/分钟 = 1000ms 间隔
  const start = Date.now();

  await limiter.throttle('WANHAI');
  await limiter.throttle('ZIM');
  await limiter.throttle('CMA');

  const elapsed = Date.now() - start;
  // 不同船司之间不互相等待
  assert.ok(elapsed < 500, `不同船司之间不应互相等待，实际耗时 ${elapsed}ms`);
});

test('速率限制器：同一船司的并发请求也会排队', async () => {
  const limiter = new RateLimiter(60);  // 默认 60 次/分钟 = 1000ms 间隔
  const start = Date.now();

  await Promise.all([
    limiter.throttle('TEST_CARRIER'),
    limiter.throttle('TEST_CARRIER'),
  ]);

  const elapsed = Date.now() - start;
  // 即使两个 worker 同时调用，第二个请求也需要等待约 1000ms。
  assert.ok(elapsed >= 900, `同一船司并发请求应有间隔，实际耗时 ${elapsed}ms`);
  assert.ok(elapsed < 1500, `等待时间不应超过限流间隔太多，实际耗时 ${elapsed}ms`);
});

test('速率限制器：万海使用严格的 3 次/分钟限流', () => {
  const limiter = new RateLimiter(10);
  assert.equal(limiter.getLimit('WANHAI'), 3);
});

test('速率限制器：未配置的船司使用默认限流', () => {
  const limiter = new RateLimiter(12);
  assert.equal(limiter.getLimit('UNKNOWN_CARRIER'), 12);
});

test('速率限制器：reset 后不再等待', async () => {
  const limiter = new RateLimiter(60);
  await limiter.throttle('WANHAI');
  limiter.reset('WANHAI');

  const start = Date.now();
  await limiter.throttle('WANHAI');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `reset 后不应等待，实际耗时 ${elapsed}ms`);
});
