import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.AUTH_ENABLED = 'true';
process.env.AUTH_ADMIN_PASSWORD = 'test-admin-password-123';
process.env.AUTH_ADMIN_USERNAME = 'admin-test';

const { AuthService } = await import('../auth.js');

test('登录生成 Session、CSRF token 并可读取用户角色', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  const session = await auth.login('admin-test', 'test-admin-password-123', 'test-client');
  assert.equal(session.user.role, 'admin');
  assert.ok(session.token);
  assert.ok(session.csrfToken);
  const req = { headers: { cookie: `port_ops_session=${encodeURIComponent(session.token)}` }, method: 'GET' } as never;
  assert.deepEqual(auth.sessionFromRequest(req)?.user, session.user);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('错误密码会被限流', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  for (let index = 0; index < 10; index += 1) await assert.rejects(() => auth.login('admin-test', 'wrong', 'same-client'), /用户名或密码错误/);
  await assert.rejects(() => auth.login('admin-test', 'wrong', 'same-client'), /登录失败次数过多/);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});
