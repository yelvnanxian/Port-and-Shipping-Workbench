import { execFile } from 'node:child_process';
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

let cleanupPromise: Promise<{ orphanedProcesses: number }> | null = null;

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
    return { orphanedProcesses };
  })();
  try {
    return await cleanupPromise;
  } finally {
    cleanupPromise = null;
  }
}
