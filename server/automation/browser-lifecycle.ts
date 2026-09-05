import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { shutdownBrowser } from './browser.js';
import { shutdownHmmBrowser } from './hmm.js';
import { shutdownOoclPatchright } from './oocl-patchright.js';
import { shutdownWanhaiPatchright } from './wanhai-patchright.js';
import { shutdownZimPatchright } from './zim-patchright.js';

const execFileAsync = promisify(execFile);

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

let cleanupPromise: Promise<{ orphanedProcesses: number; cacheDirectories: number; cacheBytes: number }> | null = null;

function isChromeCommand(command: string) {
  return /Google Chrome|Chromium|Microsoft Edge|chrome-mac|msedge/i.test(command);
}

function isAutomationCommand(command: string, dataDirectories: string[]) {
  if (!isChromeCommand(command)) return false;
  // Playwright/patchright 使用临时 profile 或工作台的持久 profile；
  // 普通用户 Chrome 不带这些标记，因此不会被清理。
  if (/playwright_chromiumdev_profile-|patchright/i.test(command)) return true;
  const userDataDir = command.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i)?.[1]
    || command.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i)?.[2]
    || '';
  return Boolean(userDataDir && dataDirectories.some((directory) => userDataDir === directory || userDataDir.startsWith(`${directory}${path.sep}`)));
}

async function automationProcesses(dataDirectories: string[]) {
  if (process.platform === 'win32') return [] as ProcessInfo[];
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return [];
      const info = { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
      if (!Number.isSafeInteger(info.pid) || info.pid === process.pid) return [];
      return isAutomationCommand(info.command, dataDirectories) ? [info] : [];
    });
  } catch {
    return [] as ProcessInfo[];
  }
}

async function stopOrphanedAutomationProcesses(dataDirectories: string[]) {
  const processes = await automationProcesses(dataDirectories);
  if (!processes.length) return 0;
  const byParent = new Map<number, ProcessInfo[]>();
  for (const item of processes) byParent.set(item.ppid, [...(byParent.get(item.ppid) || []), item]);
  const targets = new Set<number>();
  const visit = (item: ProcessInfo) => {
    if (targets.has(item.pid)) return;
    targets.add(item.pid);
    for (const child of byParent.get(item.pid) || []) visit(child);
  };
  processes.forEach(visit);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程已退出 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  const remaining = new Set((await automationProcesses(dataDirectories)).map((item) => item.pid));
  for (const pid of targets) {
    if (!remaining.has(pid)) continue;
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  return targets.size;
}

const CACHE_DIRECTORY_NAMES = new Set([
  'cache', 'code cache', 'gpucache', 'graphitedawncache', 'dawncache',
  'shadercache', 'browsermetrics', 'cachestorage',
]);

function configuredProfileRoots(dataDirectory: string) {
  const roots = [
    path.join(dataDirectory, 'browser-profile'),
    process.env.OOCL_PATCHRIGHT_PROFILE_DIR,
    process.env.WANHAI_PATCHRIGHT_PROFILE_DIR,
    process.env.ZIM_PATCHRIGHT_PROFILE_DIR,
    process.env.HAPAG_PATCHRIGHT_PROFILE_DIR,
    process.env.CMA_PATCHRIGHT_PROFILE_DIR,
    process.env.HMM_BROWSER_USER_DATA_DIR,
  ];
  return [...new Set(roots.filter(Boolean).map((item) => path.resolve(item!)))];
}

async function directorySize(target: string): Promise<number> {
  let entries: import('node:fs').Dirent<string>[];
  try { entries = await fs.readdir(target, { withFileTypes: true, encoding: 'utf8' }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) {
      const stat = await fs.stat(child, { bigint: false }).catch(() => null);
      total += stat ? Number(stat.size) : 0;
    }
  }
  return total;
}

/**
 * Remove only Chromium cache directories inside workbench-owned profiles.
 * Cookies, Local Storage, Preferences and verification state are untouched.
 */
export async function clearBrowserProfileCaches(dataDirectories: string[]) {
  const roots = [...new Set(dataDirectories.flatMap(configuredProfileRoots))];
  let cacheDirectories = 0;
  let cacheBytes = 0;
  const visit = async (directory: string) => {
    let entries: import('node:fs').Dirent<string>[];
    try { entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (CACHE_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        cacheBytes += await directorySize(child);
        await fs.rm(child, { recursive: true, force: true }).catch(() => undefined);
        cacheDirectories += 1;
        continue;
      }
      await visit(child);
    }
  };
  await Promise.all(roots.map((root) => visit(root)));
  return { cacheDirectories, cacheBytes };
}

/**
 * 任务期间必须保留各船司的 Cookie/验证会话；只有 Node 服务正常退出时
 * 才统一关闭浏览器上下文，避免服务重启后残留 Chrome 根进程。
 */
export async function shutdownBrowserAutomation(dataDirectories: string[] = []) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await Promise.all([
      shutdownBrowser(),
      shutdownOoclPatchright(),
      shutdownWanhaiPatchright(),
      shutdownZimPatchright(),
      shutdownHmmBrowser(),
    ]);
    const directories = dataDirectories.map((directory) => path.resolve(directory));
    const orphanedProcesses = await stopOrphanedAutomationProcesses(directories);
    const cache = await clearBrowserProfileCaches(directories);
    return { orphanedProcesses, ...cache };
  })();
  try {
    return await cleanupPromise;
  } finally {
    cleanupPromise = null;
  }
}
