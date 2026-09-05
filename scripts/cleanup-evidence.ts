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
const retentionDays = Number(process.env.EVIDENCE_RETENTION_DAYS || 7);
const maxPerKey = 1;
const apply = process.argv.includes('--apply');

function evidenceReference(value: string) {
  const match = value.match(/(?:^|[\\/])([^\\/]+\.(?:png|svg))$/i);
  return match?.[1] || '';
}

function referencedFileNames(value: unknown, target: Set<string>) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(/(?:\/api\/browser-evidence\/|browser-evidence[\\/])([^?\s；"']+\.(?:png|svg))/gi)) {
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
    if (!entry.isFile() || !/\.(?:png|svg)$/i.test(entry.name)) continue;
    const stat = await fs.stat(target);
    // 文件名：时间_船司_单号_success|failure.(png|svg)。同一单号不再按
    // success/failure 分组，始终只保留最后一次截图/凭证。
    const normalized = entry.name.replace(/\.(?:png|svg)$/i, '');
    const parts = normalized.split('_');
    const semantic = parts.slice(2).join('_').replace(/_(?:patchright-)?(?:success|failure|api-success)$/i, '');
    const key = parts.length >= 3 ? `${parts[1]}_${semantic}` : normalized;
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
      // Keep the newest currently referenced evidence so the active workbook
      // does not immediately expose a broken link. Older retries are removed
      // even when historical run records still reference them; otherwise the
      // retention rule could never reduce duplicate screenshots.
      if (index === 0 && referenced.has(file.name)) return;
      if (file.mtimeMs < cutoff || index >= maxPerKey) candidates.push(file);
    });
  }
  const bytes = candidates.reduce((sum, file) => sum + file.size, 0);
  console.log(`证据文件总数：${files.length}`);
  console.log(`保留引用文件：${referenced.size}`);
  console.log(`清理策略：${retentionDays} 天，同一船司/单号（或柜号）仅保留最新 1 个文件`);
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
