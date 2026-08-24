import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envExamplePath = path.join(projectDirectory, '.env.example');
const envPath = path.join(projectDirectory, '.env');
const dataDirectory = path.join(projectDirectory, 'data');

const runtimeDirectories = [
  dataDirectory,
  path.join(dataDirectory, 'backups'),
  path.join(dataDirectory, 'uploads'),
  path.join(dataDirectory, 'browser-profile'),
  path.join(dataDirectory, 'browser-evidence'),
  path.join(dataDirectory, 'browser-state'),
  path.join(dataDirectory, 'sources'),
  path.join(dataDirectory, 'workspaces'),
  path.join(dataDirectory, 'db-backups'),
];

function generatedPassword() {
  return crypto.randomBytes(18).toString('base64url').slice(0, 20);
}

async function ensureEnv() {
  try {
    await fs.access(envPath);
    return { created: false, password: '' };
  } catch {
    const example = await fs.readFile(envExamplePath, 'utf8');
    const password = generatedPassword();
    const content = example.replace(/^AUTH_ADMIN_PASSWORD=.*$/m, `AUTH_ADMIN_PASSWORD=${password}`);
    await fs.writeFile(envPath, content, { flag: 'wx', mode: 0o600 });
    return { created: true, password };
  }
}

function valueFromEnvText(text, key) {
  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || '';
}

await Promise.all(runtimeDirectories.map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
const env = await ensureEnv();

console.log('港航工作台本地初始化完成。');
console.log(`运行目录：${dataDirectory}`);
if (env.created) {
  const example = await fs.readFile(envExamplePath, 'utf8');
  const username = valueFromEnvText(example, 'AUTH_ADMIN_USERNAME') || 'admin';
  console.log(`已创建 .env，管理员账号：${username}，密码=${env.password}`);
  console.log('请立即保存这组密码；后续不会再次显示。');
} else {
  console.log('检测到已有 .env，未覆盖现有配置。');
}
console.log('首次使用以星、东方海外或万海的人工验证时，请将 BROWSER_HEADLESS=false。');
console.log('下一步执行：npm run preflight && npm run dev');
