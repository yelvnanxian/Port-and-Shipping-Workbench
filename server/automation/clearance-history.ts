import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCarrierRule } from './carriers.js';
import type { QueryProgress, TrackingTime, VesselState, WorkbookRecord } from './types.js';

export type ClearanceRetentionDays = 3 | 7;

export interface ClearanceHistoryEntry {
  id: string;
  archivedAt: string;
  originalRowNumber: number;
  carrier: string;
  carrierCode: string;
  carrierHint: string;
  billNo: string;
  containerNo: string;
  arrivalTime: string | null;
  dischargeTime: string | null;
  vesselState: VesselState | '';
  manualMark: '已清关';
  lastUpdated: string | null;
  note: string;
  progress: QueryProgress | '';
}

export interface ClearanceHistorySnapshot {
  retentionDays: ClearanceRetentionDays;
  lastCleanupAt: string | null;
  entries: ClearanceHistoryEntry[];
}

interface ClearanceHistoryFile extends ClearanceHistorySnapshot {
  version: 1;
}

function serializedTime(value: TrackingTime) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function emptyHistory(): ClearanceHistoryFile {
  return { version: 1, retentionDays: 7, lastCleanupAt: null, entries: [] };
}

function validDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

function normalizeEntry(value: unknown): ClearanceHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<ClearanceHistoryEntry>;
  if (typeof item.id !== 'string' || typeof item.archivedAt !== 'string') return null;
  if (typeof item.billNo !== 'string' || typeof item.containerNo !== 'string') return null;
  if (!validDate(item.archivedAt)) return null;
  return {
    id: item.id,
    archivedAt: item.archivedAt,
    originalRowNumber: Number.isInteger(item.originalRowNumber) ? Number(item.originalRowNumber) : 0,
    carrier: typeof item.carrier === 'string' ? item.carrier : '未知船司',
    carrierCode: typeof item.carrierCode === 'string' ? item.carrierCode : 'UNKNOWN',
    carrierHint: typeof item.carrierHint === 'string' ? item.carrierHint : '',
    billNo: item.billNo.toUpperCase(),
    containerNo: item.containerNo.toUpperCase(),
    arrivalTime: typeof item.arrivalTime === 'string' ? item.arrivalTime : null,
    dischargeTime: typeof item.dischargeTime === 'string' ? item.dischargeTime : null,
    vesselState: item.vesselState === '未到港未卸船' || item.vesselState === '已到港未卸船' || item.vesselState === '已到港已卸船' ? item.vesselState : '',
    manualMark: '已清关',
    lastUpdated: validDate(item.lastUpdated),
    note: typeof item.note === 'string' ? item.note : '',
    progress: item.progress === '待查询' || item.progress === '查询中' || item.progress === '已完成' || item.progress === '失败' ? item.progress : '',
  };
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class ClearanceHistoryStore {
  readonly filePath: string;
  private mutation = Promise.resolve();

  constructor(private readonly dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'clearance-history.json');
  }

  private async readFile(): Promise<ClearanceHistoryFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<ClearanceHistoryFile>;
      const entries = Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter((item): item is ClearanceHistoryEntry => Boolean(item)) : [];
      return {
        version: 1,
        retentionDays: parsed.retentionDays === 3 ? 3 : 7,
        lastCleanupAt: validDate(parsed.lastCleanupAt),
        entries: entries.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)).slice(0, 20_000),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return emptyHistory();
    }
  }

  private async mutate<T>(operation: (state: ClearanceHistoryFile) => T | Promise<T>) {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.mutation = this.mutation.then(async () => {
      try {
        await fs.mkdir(this.dataDirectory, { recursive: true });
        const state = await this.readFile();
        const value = await operation(state);
        await writeJsonAtomic(this.filePath, state);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async snapshot(): Promise<ClearanceHistorySnapshot> {
    await this.mutation;
    const state = await this.readFile();
    return { retentionDays: state.retentionDays, lastCleanupAt: state.lastCleanupAt, entries: state.entries };
  }

  async archive(record: WorkbookRecord, now = new Date()) {
    return this.mutate((state) => {
      let carrier = record.carrierHint || '未知船司';
      let carrierCode = 'UNKNOWN';
      try {
        const rule = resolveCarrierRule(record);
        carrier = rule.name;
        carrierCode = rule.code;
      } catch {
        // 不支持的前缀仍允许归档，保留 Excel 中的船司备注供人工识别。
      }
      let id = '';
      do {
        id = `CLR-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      } while (state.entries.some((item) => item.id === id));
      const entry: ClearanceHistoryEntry = {
        id,
        archivedAt: now.toISOString(),
        originalRowNumber: record.rowNumber,
        carrier,
        carrierCode,
        carrierHint: record.carrierHint,
        billNo: record.billNo,
        containerNo: record.containerNo,
        arrivalTime: serializedTime(record.arrivalTime),
        dischargeTime: serializedTime(record.dischargeTime),
        vesselState: record.vesselState,
        manualMark: '已清关',
        lastUpdated: record.lastUpdated?.toISOString() || null,
        note: record.note,
        progress: record.progress,
      };
      state.entries.unshift(entry);
      return entry;
    });
  }

  async remove(ids: string[]) {
    const requested = new Set(ids);
    return this.mutate((state) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) => !requested.has(entry.id));
      return before - state.entries.length;
    });
  }

  async setRetentionDays(retentionDays: ClearanceRetentionDays) {
    return this.mutate((state) => {
      state.retentionDays = retentionDays;
      return retentionDays;
    });
  }

  async cleanupExpired(now = new Date()) {
    return this.mutate((state) => {
      const cutoff = now.getTime() - state.retentionDays * 24 * 60 * 60 * 1000;
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) => new Date(entry.archivedAt).getTime() > cutoff);
      state.lastCleanupAt = now.toISOString();
      return before - state.entries.length;
    });
  }
}
