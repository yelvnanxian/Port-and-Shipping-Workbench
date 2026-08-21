import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

export type UserRole = 'admin' | 'user';
export interface AuthUser { id: string; username: string; role: UserRole }
interface StoredUser extends AuthUser { salt: string; passwordHash: string; enabled: boolean }
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

  constructor(dataDirectory: string) {
    this.usersPath = path.join(dataDirectory, 'users.json');
  }

  private async loadUsers() {
    if (this.users) return this.users;
    const adminPassword = process.env.AUTH_ADMIN_PASSWORD?.trim();
    const userPassword = process.env.AUTH_USER_PASSWORD?.trim();
    // 环境变量是管理员部署时的权威配置，允许在不手工编辑 users.json 的情况下轮换密码。
    if (adminPassword || userPassword) {
      const users: StoredUser[] = [];
      if (adminPassword) users.push({ id: 'user-admin', username: process.env.AUTH_ADMIN_USERNAME?.trim() || 'admin', role: 'admin', enabled: true, ...hashPassword(adminPassword) });
      if (userPassword) users.push({ id: 'user-standard', username: process.env.AUTH_USER_USERNAME?.trim() || 'operator', role: 'user', enabled: true, ...hashPassword(userPassword) });
      this.users = users;
      await fs.mkdir(path.dirname(this.usersPath), { recursive: true });
      await fs.writeFile(this.usersPath, JSON.stringify(users, null, 2), { mode: 0o600 });
      return users;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.usersPath, 'utf8')) as StoredUser[];
      if (Array.isArray(parsed) && parsed.length) {
        this.users = parsed;
        return parsed;
      }
    } catch { /* 首次启动按环境变量初始化 */ }
    this.users = [];
    return this.users;
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
      throw new Error('用户名或密码错误');
    }
    this.failedLogins.delete(clientKey);
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const publicUser = { id: user.id, username: user.username, role: user.role } satisfies AuthUser;
    this.sessions.set(token, { token, csrfToken, user: publicUser, expiresAt: Date.now() + SESSION_TTL_MS });
    return { user: publicUser, csrfToken, token };
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

export { SESSION_COOKIE };
