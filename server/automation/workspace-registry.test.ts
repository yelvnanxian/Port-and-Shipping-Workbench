import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceRegistry } from '../workspace-registry.js';

test('同一用户的并发首次请求只初始化一个工作区', async () => {
  let created = 0;
  const registry = new WorkspaceRegistry(async (key) => {
    created += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { key, sequence: created };
  });

  const [dashboardEngine, automationEngine] = await Promise.all([
    registry.get('user-concurrent'),
    registry.get('user-concurrent'),
  ]);
  assert.equal(created, 1);
  assert.equal(dashboardEngine, automationEngine);
  assert.deepEqual(registry.values(), [dashboardEngine]);
});
