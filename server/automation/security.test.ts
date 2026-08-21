import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { corsOrigin, createRateLimiter, securityHeaders } from '../security.js';

test('security headers include baseline browser protections', async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cors origin allows configured origins and rejects unknown origins', () => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://ship.example.com,http://localhost:5173';
  try {
    assert.equal(corsOrigin(undefined), true);
    assert.equal(corsOrigin('https://ship.example.com'), 'https://ship.example.com');
    assert.equal(corsOrigin('https://attacker.example'), false);
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  }
});

test('rate limiter rejects requests over the configured window quota', async () => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, max: 1, name: 'test' }));
  app.get('/limited', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/limited`;
    assert.equal((await fetch(url)).status, 200);
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).message, '请求过于频繁，请稍后再试');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
