import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialExecutionCoordinator } from './concurrency.js';

test('共享执行协调器会按进入顺序串行处理不同账号任务', async () => {
  const coordinator = new SerialExecutionCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = coordinator.run(async () => {
    events.push('admin:start');
    await firstGate;
    events.push('admin:end');
  });
  const second = coordinator.run(async () => {
    events.push('user:start');
    events.push('user:end');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['admin:start']);
  assert.equal(coordinator.active, 1);
  assert.equal(coordinator.waiting, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['admin:start', 'admin:end', 'user:start', 'user:end']);
});

test('同一调用链中的嵌套写操作复用锁且不会死锁', async () => {
  const coordinator = new SerialExecutionCoordinator();
  const events: string[] = [];
  await coordinator.run(async () => {
    events.push('outer:start');
    await coordinator.run(async () => { events.push('inner'); });
    events.push('outer:end');
  });
  assert.deepEqual(events, ['outer:start', 'inner', 'outer:end']);
  assert.equal(coordinator.active, 0);
  assert.equal(coordinator.waiting, 0);
});
