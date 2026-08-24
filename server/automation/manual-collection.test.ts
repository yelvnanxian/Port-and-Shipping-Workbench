import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationEngine } from './engine.js';
import { ManualCollectionRegistry, manualCollectionHostAllowed } from './manual-collection.js';

function createSession(registry: ManualCollectionRegistry, ttlMs = 15 * 60_000) {
  return registry.create({
    userId: 'user-1',
    engine: {} as AutomationEngine,
    carrierCode: 'CMA',
    carrierName: '达飞',
    shipmentId: 'XLSX-2',
    rowNumber: 2,
    billNo: 'CMDUNGP4005669',
    queryBillNo: 'NGP4005669',
    containerNo: 'TDSU8099791',
    queryType: 'bill',
    sourceUrl: 'https://www.cma-cgm.com/ebusiness/tracking',
  }, ttlMs);
}

test('普通浏览器采集令牌绑定用户且过期后立即失效', () => {
  const registry = new ManualCollectionRegistry();
  const active = createSession(registry);
  assert.equal(registry.findById(active.id, 'user-1')?.id, active.id);
  assert.equal(registry.findById(active.id, 'user-2'), undefined);
  assert.equal(registry.findByToken(active.token)?.shipmentId, 'XLSX-2');

  const expired = createSession(registry, -1);
  assert.equal(registry.findByToken(expired.token), undefined);
});

test('普通浏览器采集只接受对应船司的 HTTPS 官网', () => {
  assert.equal(manualCollectionHostAllowed('CMA', 'https://www.cma-cgm.com/ebusiness/tracking'), true);
  assert.equal(manualCollectionHostAllowed('CMA', 'https://cma-cgm.com.attacker.example/tracking'), false);
  assert.equal(manualCollectionHostAllowed('CMA', 'http://www.cma-cgm.com/ebusiness/tracking'), false);
  assert.equal(manualCollectionHostAllowed('HAPAG', 'https://www.hapag-lloyd.com/en/online-business/track.html'), true);
  assert.equal(manualCollectionHostAllowed('HAPAG', 'https://www.hapag-lloyd.cn/en/online-business/track.html'), true);
  assert.equal(manualCollectionHostAllowed('HAPAG', 'https://www.cma-cgm.com/ebusiness/tracking'), false);
});
