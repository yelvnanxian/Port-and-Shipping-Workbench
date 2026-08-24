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

test('同一账号在新设备登录后会替换旧 Session', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  const first = await auth.login('admin-test', 'test-admin-password-123', 'device-a');
  const firstRequest = { headers: { cookie: `port_ops_session=${encodeURIComponent(first.token)}` }, method: 'GET' } as never;
  assert.equal(auth.sessionFromRequest(firstRequest)?.user.id, first.user.id);

  const second = await auth.login('admin-test', 'test-admin-password-123', 'device-b');
  const secondRequest = { headers: { cookie: `port_ops_session=${encodeURIComponent(second.token)}` }, method: 'GET' } as never;
  assert.equal(auth.sessionFromRequest(firstRequest), null);
  assert.equal(auth.sessionIssueFromRequest(firstRequest), 'replaced');
  assert.equal(auth.sessionFromRequest(secondRequest)?.user.id, second.user.id);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('错误密码会被限流', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  for (let index = 0; index < 10; index += 1) await assert.rejects(() => auth.login('admin-test', 'wrong', 'same-client'), /用户名或密码错误/);
  await assert.rejects(() => auth.login('admin-test', 'wrong', 'same-client'), /登录失败次数过多/);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('管理员可以创建、停用、重置和删除普通账号', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  const created = await auth.createUser({ username: 'operator-test', password: 'operator-password-123', role: 'user' });
  assert.equal(created.role, 'user');
  assert.equal((await auth.listUsers()).length, 2);
  const disabled = await auth.updateUser(created.id, { enabled: false }, 'user-admin');
  assert.equal(disabled.enabled, false);
  await assert.rejects(() => auth.login('operator-test', 'operator-password-123', 'operator-client'), /用户名或密码错误/);
  await auth.updateUser(created.id, { enabled: true }, 'user-admin');
  await auth.resetPassword(created.id, 'operator-password-456', 'user-admin');
  assert.ok(await auth.login('operator-test', 'operator-password-456', 'operator-client-2'));
  assert.equal((await auth.deleteUser(created.id, 'user-admin')).length, 1);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('并发创建不同账号时不会覆盖账号列表', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'port-ops-auth-'));
  const auth = new AuthService(dataDirectory);
  await Promise.all([
    auth.createUser({ username: 'operator-a', password: 'operator-password-a', role: 'user' }),
    auth.createUser({ username: 'operator-b', password: 'operator-password-b', role: 'user' }),
  ]);
  const usernames = (await auth.listUsers()).map((user) => user.username).sort();
  assert.deepEqual(usernames, ['admin-test', 'operator-a', 'operator-b']);
  await fs.rm(dataDirectory, { recursive: true, force: true });
});
