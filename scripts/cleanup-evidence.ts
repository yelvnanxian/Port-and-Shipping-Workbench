import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkbookStore } from '../server/automation/workbook.js';

type EvidenceFile = {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  key: string;
};

const projectRoot = path.resolve(import.meta.dirname, '..');
const dataDirectory = path.resolve(process.env.PORT_OPS_DATA_DIR?.trim() || path.join(projectRoot, 'data'));
const retentionDays = Number(process.env.EVIDENCE_RETENTION_DAYS || 30);
const maxPerKey = Number(process.env.EVIDENCE_MAX_PER_KEY || 3);
const apply = process.argv.includes('--apply');

function evidenceReference(value: string) {
  const match = value.match(/(?:^|[\\/])([^\\/]+\.png)$/i);
  return match?.[1] || '';
}

function referencedFileNames(value: unknown, target: Set<string>) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(/(?:\/api\/browser-evidence\/|browser-evidence[\\/])([^?\s；"']+\.png)/gi)) {
    const name = decodeURIComponent(match[1]);
    target.add(evidenceReference(name));
  }
}

async function collectReferencedEvidence() {
  const referenced = new Set<string>();
  const store = new WorkbookStore(projectRoot, dataDirectory);
  if (await store.exists()) {
    const { sheet, headerMap } = await store.open();
    for (const record of store.readRecords(sheet, headerMap)) referencedFileNames(record.note, referenced);
  }
  try {
    const runs = JSON.parse(await fs.readFile(path.join(dataDirectory, 'runs.json'), 'utf8')) as unknown;
    const serialized = JSON.stringify(runs);
    referencedFileNames(serialized, referenced);
  } catch {
    // 没有本地运行记录时继续清理未引用证据。
  }
  return referenced;
}

async function walkEvidence(directory: string): Promise<EvidenceFile[]> {
  const files: EvidenceFile[] = [];
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkEvidence(target));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
    const stat = await fs.stat(target);
    // 新版文件名：时间_船司_单号_success|failure.png；旧版文件名没有结果后缀。
    const normalized = entry.name.replace(/\.png$/i, '');
    const parts = normalized.split('_');
    // 把 success/failure 作为分组的一部分，避免失败证据挤掉成功证据的保留名额。
    const key = parts.slice(1).join('_');
    files.push({ path: target, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size, key });
  }
  return files;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('EVIDENCE_RETENTION_DAYS 必须是大于 0 的数字');
  if (!Number.isFinite(maxPerKey) || maxPerKey < 1) throw new Error('EVIDENCE_MAX_PER_KEY 必须是大于 0 的数字');

  const [files, referenced] = await Promise.all([
    Promise.all([
      walkEvidence(path.join(dataDirectory, 'browser-evidence')),
      walkEvidence(path.join(dataDirectory, 'sources')),
    ]).then((items) => items.flat()),
    collectReferencedEvidence(),
  ]);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const grouped = new Map<string, EvidenceFile[]>();
  files.forEach((file) => grouped.set(file.key, [...(grouped.get(file.key) || []), file]));
  const candidates: EvidenceFile[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.mtimeMs - a.mtimeMs);
    group.forEach((file, index) => {
      if (referenced.has(file.name)) return;
      if (file.mtimeMs < cutoff || index >= maxPerKey) candidates.push(file);
    });
  }
  const bytes = candidates.reduce((sum, file) => sum + file.size, 0);
  console.log(`证据文件总数：${files.length}`);
  console.log(`保留引用文件：${referenced.size}`);
  console.log(`清理策略：${retentionDays} 天，单号每类最多 ${maxPerKey} 个文件`);
  console.log(`${apply ? '将删除' : '预计删除'}：${candidates.length} 个文件，${formatBytes(bytes)}`);
  if (!apply) {
    console.log('当前为预览模式；确认结果后执行：npm run cleanup:evidence -- --apply');
    return;
  }
  for (const file of candidates) await fs.rm(file.path, { force: true });
  console.log(`已删除：${candidates.length} 个文件，释放 ${formatBytes(bytes)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
