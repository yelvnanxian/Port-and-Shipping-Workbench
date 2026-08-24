import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectDirectory, '.env');
const dataDirectory = path.join(projectDirectory, 'data');
const errors = [];
const warnings = [];

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function report(label, detail) {
  console.log(`${label} ${detail}`);
}

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) errors.push(`Node.js 20 或更高版本是必需的，当前为 ${process.versions.node}`);
  else report('✓', `Node.js ${process.versions.node}`);
} catch {
  errors.push('无法读取 Node.js 版本');
}

let env = {};
try {
  env = parseEnv(await fs.readFile(envPath, 'utf8'));
  report('✓', '已找到 .env');
} catch {
  errors.push('没有找到 .env，请先运行 npm run setup');
}

const authEnabled = bool(env.AUTH_ENABLED, true);
const adminPassword = env.AUTH_ADMIN_PASSWORD || '';
if (authEnabled) {
  if (!env.AUTH_ADMIN_USERNAME?.trim()) errors.push('AUTH_ADMIN_USERNAME 不能为空');
  if (!adminPassword || /请替换|replace|change-me|password/i.test(adminPassword)) errors.push('AUTH_ADMIN_PASSWORD 仍是占位值，请修改 .env');
  else if (adminPassword.length < 16) errors.push('AUTH_ADMIN_PASSWORD 至少需要 16 位');
  else report('✓', '管理员登录配置有效');
}

const port = Number(env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT 必须是 1-65535 的整数');
else report('✓', `服务端口 ${port}`);

const publicHost = env.APP_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.APP_HOST);
const configuredOrigins = (env.APP_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
const publicOrigin = configuredOrigins.some((origin) => !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin));
if (!authEnabled && (publicHost || publicOrigin)) errors.push('公网或反向代理访问必须启用 AUTH_ENABLED=true');

try {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await fs.access(dataDirectory, fs.constants.R_OK | fs.constants.W_OK);
  report('✓', `数据目录可读写：${dataDirectory}`);
} catch {
  errors.push(`数据目录不可读写：${dataDirectory}`);
}

if (env.BROWSER_EXECUTABLE_PATH) {
  try {
    await fs.access(env.BROWSER_EXECUTABLE_PATH, fs.constants.X_OK);
    report('✓', '已找到配置的 Chrome/Edge 可执行文件');
  } catch {
    errors.push(`BROWSER_EXECUTABLE_PATH 不存在或不可执行：${env.BROWSER_EXECUTABLE_PATH}`);
  }
} else {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const available = [];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      available.push(candidate);
    } catch { /* 尝试下一个系统路径 */ }
  }
  if (available.length) report('✓', `检测到浏览器：${available[0]}`);
  else warnings.push('未检测到常见 Chrome/Edge 路径；需要在 .env 设置 BROWSER_EXECUTABLE_PATH');
}

if (bool(env.BROWSER_HEADLESS, true) && bool(env.BROWSER_HUMAN_VERIFY, true)) {
  warnings.push('当前为无头浏览器；遇到以星、东方海外或万海人工验证时，请临时设置 BROWSER_HEADLESS=false');
}
if (env.DATABASE_URL) report('✓', '已配置 PostgreSQL（启动时会执行数据库迁移）');
else warnings.push('未配置 DATABASE_URL，将使用本地文件保存数据；多实例部署时不要共享同一个 data 目录');

for (const warning of warnings) report('⚠', warning);
if (errors.length) {
  for (const error of errors) report('✗', error);
  process.exitCode = 1;
} else {
  report('✓', `系统检查通过（${os.platform()} ${os.arch()}）`);
}
