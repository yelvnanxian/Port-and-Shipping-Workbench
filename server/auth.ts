import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { AppDatabase } from './database.js';
import { auditLog } from './audit.js';

export type UserRole = 'admin' | 'user';
export interface AuthUser { id: string; username: string; role: UserRole }
export interface AuthUserView extends AuthUser { enabled: boolean; createdAt: string; updatedAt: string }
interface StoredUser extends AuthUserView { salt: string; passwordHash: string }
interface Session { token: string; csrfToken: string; user: AuthUser; expiresAt: number }

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'port_ops_session';

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function matchesPassword(password: string, stored: StoredUser) {
  const actual = Buffer.from(hashPassword(password, stored.salt).passwordHash, 'hex');
  const expected = Buffer.from(stored.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function authEnabled() {
  if (process.env.AUTH_ENABLED === 'false') return false;
  return process.env.AUTH_ENABLED === 'true' || Boolean(process.env.AUTH_ADMIN_PASSWORD?.trim());
}

function cookieValue(req: Request, name: string) {
  const item = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : undefined;
}

function cleanUsername(value: string) {
  const username = value.trim();
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new Error('用户名需为 2-32 位字母、数字或中文字符');
  return username;
}

function cleanPassword(value: string) {
  if (value.length < 12 || value.length > 128) throw new Error('密码长度必须为 12-128 位');
  return value;
}

function toAuthUser(user: StoredUser): AuthUser {
  return { id: user.id, username: user.username, role: user.role };
}

declare global {
  namespace Express {
    interface Request { authUser?: AuthUser; authCsrfToken?: string }
  }
}

export class AuthService {
  private users: StoredUser[] | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly failedLogins = new Map<string, { count: number; resetAt: number }>();
  readonly enabled = authEnabled();
  readonly usersPath: string;
  private readonly database?: AppDatabase;

  constructor(dataDirectory: string, database?: AppDatabase) {
    this.usersPath = path.join(dataDirectory, 'users.json');
    this.database = database?.enabled ? database : undefined;
  }

  private async loadUsers() {
    if (this.users) return this.users;
    if (this.database) {
      const result = await this.database.query<StoredUser>(`SELECT id, username, role, enabled, created_at AS "createdAt", updated_at AS "updatedAt", salt, password_hash AS "passwordHash" FROM auth_users ORDER BY username`);
      if (result.rows.length) {
        this.users = result.rows.map((user) => ({ ...user, enabled: user.enabled !== false }));
        return this.users;
      }
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.usersPath, 'utf8')) as StoredUser[];
      if (Array.isArray(parsed) && parsed.length) {
        this.users = parsed.map((user) => ({
          ...user,
          createdAt: user.createdAt || new Date().toISOString(),
          updatedAt: user.updatedAt || new Date().toISOString(),
          enabled: user.enabled !== false,
        }));
        return this.users;
      }
    } catch { /* 首次启动按环境变量初始化 */ }
    const now = new Date().toISOString();
    const users: StoredUser[] = [];
    const adminPassword = process.env.AUTH_ADMIN_PASSWORD?.trim();
    const userPassword = process.env.AUTH_USER_PASSWORD?.trim();
    if (adminPassword) users.push({ id: 'user-admin', username: process.env.AUTH_ADMIN_USERNAME?.trim() || 'admin', role: 'admin', enabled: true, createdAt: now, updatedAt: now, ...hashPassword(cleanPassword(adminPassword)) });
    if (userPassword) users.push({ id: 'user-standard', username: process.env.AUTH_USER_USERNAME?.trim() || 'operator', role: 'user', enabled: true, createdAt: now, updatedAt: now, ...hashPassword(cleanPassword(userPassword)) });
    this.users = users;
    if (users.length) await this.saveUsers();
    return this.users;
  }

  private async saveUsers() {
    await fs.mkdir(path.dirname(this.usersPath), { recursive: true });
    const temporaryPath = `${this.usersPath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryPath, JSON.stringify(this.users || [], null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, this.usersPath);
    if (this.database) {
      await this.database.transaction(async (client) => {
        await client.query('DELETE FROM auth_users');
        for (const user of this.users || []) {
          await client.query(
            `INSERT INTO auth_users (id, username, role, enabled, created_at, updated_at, salt, password_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [user.id, user.username, user.role, user.enabled, user.createdAt, user.updatedAt, user.salt, user.passwordHash],
          );
        }
      });
    }
  }

  private async usersOrThrow() {
    return this.users || await this.loadUsers();
  }

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const, secure: process.env.APP_HTTPS === 'true', maxAge: SESSION_TTL_MS, path: '/' };
  }

  async login(username: string, password: string, clientKey = 'unknown') {
    const now = Date.now();
    const attempt = this.failedLogins.get(clientKey);
    if (attempt && attempt.resetAt > now && attempt.count >= 10) throw new Error('登录失败次数过多，请 15 分钟后重试');
    const user = (await this.loadUsers()).find((item) => item.enabled && item.username === username && matchesPassword(password, item));
    if (!user) {
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + 15 * 60 * 1000 };
      this.failedLogins.set(clientKey, { count: current.count + 1, resetAt: current.resetAt });
      await auditLog(path.dirname(this.usersPath), 'auth.login.failure', { clientKey, attempt: current.count + 1 });
      throw new Error('用户名或密码错误');
    }
    this.failedLogins.delete(clientKey);
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const sessionUser = toAuthUser(user);
    this.sessions.set(token, { token, csrfToken, user: sessionUser, expiresAt: Date.now() + SESSION_TTL_MS });
    await auditLog(path.dirname(this.usersPath), 'auth.login.success', { userId: sessionUser.id, username: sessionUser.username, clientKey });
    return { user: sessionUser, csrfToken, token };
  }

  sessionFromRequest(req: Request) {
    if (!this.enabled) return { user: { id: 'local-admin', username: 'local-admin', role: 'admin' as const }, csrfToken: '' };
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { user: session.user, csrfToken: session.csrfToken };
  }

  setSessionCookie(res: Response, token: string) {
    const options = this.cookieOptions();
    const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, `Max-Age=${Math.floor(options.maxAge / 1000)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (options.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  clearSessionCookie(res: Response) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${process.env.APP_HTTPS === 'true' ? '; Secure' : ''}`);
  }
  logout(req: Request) {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) this.sessions.delete(token);
  }

  async listUsers(): Promise<AuthUserView[]> {
    const users = await this.usersOrThrow();
    return users.map(({ salt: _salt, passwordHash: _passwordHash, ...view }) => view);
  }

  async createUser(input: { username: string; password: string; role: UserRole }) {
    if (!this.enabled) throw new Error('请先在 .env 中设置 AUTH_ENABLED=true 后再管理登录账号');
    const users = await this.usersOrThrow();
    const username = cleanUsername(input.username);
    const password = cleanPassword(input.password);
    if (input.role !== 'admin' && input.role !== 'user') throw new Error('用户角色不合法');
    if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new Error('用户名已存在');
    const now = new Date().toISOString();
    const user: StoredUser = { id: `user-${crypto.randomBytes(8).toString('hex')}`, username, role: input.role, enabled: true, createdAt: now, updatedAt: now, ...hashPassword(password) };
    users.push(user);
    await this.saveUsers();
    await auditLog(path.dirname(this.usersPath), 'auth.user.create', { userId: user.id, username: user.username, role: user.role });
    return publicUserView(user);
  }

  async updateUser(id: string, patch: { role?: UserRole; enabled?: boolean }, actorId: string) {
    const users = await this.usersOrThrow();
    const user = users.find((item) => item.id === id);
    if (!user) throw new Error('用户不存在');
    if (patch.role !== undefined && patch.role !== 'admin' && patch.role !== 'user') throw new Error('用户角色不合法');
    const nextRole = patch.role || user.role;
    const nextEnabled = patch.enabled ?? user.enabled;
    const roleChanged = nextRole !== user.role;
    if (user.id === actorId && (!nextEnabled || nextRole !== 'admin')) throw new Error('不能停用或降级当前登录的管理员账号');
    if (user.role === 'admin' && (nextRole !== 'admin' || !nextEnabled) && users.filter((item) => item.role === 'admin' && item.enabled).length <= 1) throw new Error('至少需要保留一个启用的管理员账号');
    user.role = nextRole;
    user.enabled = nextEnabled;
    user.updatedAt = new Date().toISOString();
    await this.saveUsers();
    if (!nextEnabled || roleChanged) this.revokeUserSessions(id);
    await auditLog(path.dirname(this.usersPath), 'auth.user.update', { actorId, userId: id, role: nextRole, enabled: nextEnabled });
    return publicUserView(user);
  }

  async resetPassword(id: string, password: string, actorId: string) {
    const users = await this.usersOrThrow();
    const user = users.find((item) => item.id === id);
    if (!user) throw new Error('用户不存在');
    const passwordData = hashPassword(cleanPassword(password));
    user.salt = passwordData.salt;
    user.passwordHash = passwordData.passwordHash;
    user.updatedAt = new Date().toISOString();
    await this.saveUsers();
    if (id !== actorId) this.revokeUserSessions(id);
    await auditLog(path.dirname(this.usersPath), 'auth.user.password_reset', { actorId, userId: id });
    return publicUserView(user);
  }

  async deleteUser(id: string, actorId: string) {
    const users = await this.usersOrThrow();
    const index = users.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('用户不存在');
    if (id === actorId) throw new Error('不能删除当前登录账号');
    const user = users[index];
    if (user.role === 'admin' && user.enabled && users.filter((item) => item.role === 'admin' && item.enabled).length <= 1) throw new Error('至少需要保留一个启用的管理员账号');
    users.splice(index, 1);
    await this.saveUsers();
    this.revokeUserSessions(id);
    await auditLog(path.dirname(this.usersPath), 'auth.user.delete', { actorId, userId: id, username: user.username });
    return this.listUsers();
  }

  private revokeUserSessions(userId: string) {
    for (const [token, session] of this.sessions) if (session.user.id === userId) this.sessions.delete(token);
  }

  requireSession = (req: Request, res: Response, next: NextFunction) => {
    const current = this.sessionFromRequest(req);
    if (!current) { res.status(401).json({ message: '请先登录', code: 'AUTH_REQUIRED' }); return; }
    req.authUser = current.user;
    req.authCsrfToken = current.csrfToken;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && this.enabled && req.get('x-csrf-token') !== current.csrfToken) {
      res.status(403).json({ message: 'CSRF 校验失败，请刷新后重试', code: 'CSRF_INVALID' }); return;
    }
    next();
  };

  requireRole(role: UserRole) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.authUser?.role !== role) { res.status(403).json({ message: '当前账号没有执行此操作的权限', code: 'FORBIDDEN' }); return; }
      next();
    };
  }
}

function publicUserView(user: StoredUser): AuthUserView {
  return { id: user.id, username: user.username, role: user.role, enabled: user.enabled, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

export { SESSION_COOKIE };
