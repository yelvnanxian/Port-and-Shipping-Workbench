import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import path from 'node:path';
import type { QueryProgress, TrackingTime, VesselState, WorkbookRecord } from './types.js';

export const REQUIRED_HEADERS = ['船司', '到港时间', '提单号', '柜号', '卸船时间', '船只状态', '最后更新时间', '备注', '进度'] as const;

type HeaderName = (typeof REQUIRED_HEADERS)[number];

const COLUMN_WIDTHS: Record<HeaderName, number> = {
  船司: 14,
  到港时间: 21,
  提单号: 22,
  柜号: 18,
  卸船时间: 25,
  船只状态: 18,
  最后更新时间: 21,
  备注: 72,
  进度: 12,
};

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value && value !== '未卸船') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asTrackingTime(value: unknown, displayedText: string): TrackingTime {
  const parsed = asDate(value);
  if (parsed) return parsed;
  const text = displayedText.trim();
  return text && text !== '未卸船' ? text : null;
}

async function normalizeNamespacePrefixes(filePath: string) {
  const input = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(input);
  let changed = false;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !(entry.name.endsWith('.xml') || entry.name.endsWith('.rels'))) continue;
    const xml = await entry.async('string');
    const normalized = xml
      .replace(/<(\/?)x:/g, '<$1')
      .replace(/xmlns:x=/g, 'xmlns=')
      .replace(/Target="\/xl\/tables\//g, 'Target="../tables/');
    if (normalized !== xml) {
      zip.file(entry.name, normalized);
      changed = true;
    }
  }
  if (changed) await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

export class WorkbookStore {
  readonly dataDirectory: string;
  readonly currentPath: string;
  readonly backupDirectory: string;
  readonly uploadDirectory: string;

  constructor(rootDirectory = process.cwd()) {
    this.dataDirectory = path.resolve(rootDirectory, 'data');
    this.currentPath = path.join(this.dataDirectory, 'current.xlsx');
    this.backupDirectory = path.join(this.dataDirectory, 'backups');
    this.uploadDirectory = path.join(this.dataDirectory, 'uploads');
  }

  async initialize() {
    await Promise.all([
      fs.mkdir(this.dataDirectory, { recursive: true }),
      fs.mkdir(this.backupDirectory, { recursive: true }),
      fs.mkdir(this.uploadDirectory, { recursive: true }),
    ]);
  }

  async exists() {
    try {
      await fs.access(this.currentPath);
      return true;
    } catch {
      return false;
    }
  }

  async install(uploadedPath: string) {
    await this.initialize();
    if (await this.exists()) await this.backup('上传替换');
    await normalizeNamespacePrefixes(uploadedPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(uploadedPath);
    this.validate(workbook);
    await fs.copyFile(uploadedPath, this.currentPath);
    await fs.rm(uploadedPath, { force: true });
    return this.metadata();
  }

  async backup(reason = '自动更新') {
    if (!(await this.exists())) return null;
    const target = path.join(this.backupDirectory, `船期数据_${timestampForFile()}.xlsx`);
    await fs.copyFile(this.currentPath, target);
    await fs.writeFile(`${target}.json`, JSON.stringify({ reason, createdAt: new Date().toISOString() }, null, 2));
    return target;
  }

  async open() {
    if (!(await this.exists())) throw new Error('尚未导入 Excel 文件');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(this.currentPath);
    const headerMap = this.validate(workbook);
    return { workbook, sheet: workbook.worksheets[0], headerMap };
  }

  validate(workbook: ExcelJS.Workbook) {
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('Excel 中没有工作表');
    const headerMap = new Map<HeaderName, number>();
    sheet.getRow(1).eachCell((cell, column) => {
      const value = cell.text.trim() as HeaderName;
      if (REQUIRED_HEADERS.includes(value)) headerMap.set(value, column);
    });
    const missing = REQUIRED_HEADERS.filter((header) => !headerMap.has(header));
    if (missing.length) throw new Error(`Excel 缺少表头：${missing.join('、')}`);
    return headerMap;
  }

  readRecords(sheet: ExcelJS.Worksheet, headerMap: Map<HeaderName, number>) {
    const records: WorkbookRecord[] = [];
    const text = (row: ExcelJS.Row, header: HeaderName) => row.getCell(headerMap.get(header)!).text.trim();
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const billNo = text(row, '提单号').toUpperCase();
      const containerNo = text(row, '柜号').toUpperCase();
      if (!billNo && !containerNo) continue;
      records.push({
        rowNumber,
        carrierHint: text(row, '船司'),
        billNo,
        containerNo,
        arrivalTime: asTrackingTime(row.getCell(headerMap.get('到港时间')!).value, text(row, '到港时间')),
        dischargeTime: asTrackingTime(row.getCell(headerMap.get('卸船时间')!).value, text(row, '卸船时间')),
        vesselState: text(row, '船只状态') as VesselState | '',
        lastUpdated: asDate(row.getCell(headerMap.get('最后更新时间')!).value),
        note: text(row, '备注'),
        progress: text(row, '进度') as QueryProgress | '',
      });
    }
    return records;
  }

  writeRecord(sheet: ExcelJS.Worksheet, headerMap: Map<HeaderName, number>, record: WorkbookRecord) {
    const row = sheet.getRow(record.rowNumber);
    const set = (header: HeaderName, value: ExcelJS.CellValue) => {
      row.getCell(headerMap.get(header)!).value = value;
    };
    set('船司', record.carrierHint);
    set('到港时间', record.arrivalTime ?? null);
    set('卸船时间', record.dischargeTime ?? '未卸船');
    set('船只状态', record.vesselState || null);
    set('最后更新时间', record.lastUpdated ?? null);
    set('备注', record.note || null);
    set('进度', record.progress || null);
    for (const header of REQUIRED_HEADERS) {
      const column = sheet.getColumn(headerMap.get(header)!);
      column.width = Math.max(column.width || 0, COLUMN_WIDTHS[header]);
    }
    const noteCell = row.getCell(headerMap.get('备注')!);
    noteCell.alignment = { ...noteCell.alignment, wrapText: true, vertical: 'middle' };
    const noteLines = Math.max(1, Math.ceil(record.note.length / 52));
    row.height = Math.max(row.height || 0, Math.min(120, noteLines * 18));
    for (const header of ['到港时间', '卸船时间', '最后更新时间'] as HeaderName[]) {
      const cell = row.getCell(headerMap.get(header)!);
      cell.numFmt = cell.value instanceof Date ? 'yyyy-mm-dd hh:mm' : 'General';
    }
  }

  async save(workbook: ExcelJS.Workbook) {
    await workbook.xlsx.writeFile(this.currentPath);
  }

  async metadata() {
    if (!(await this.exists())) return null;
    const stat = await fs.stat(this.currentPath);
    const { sheet, headerMap } = await this.open();
    const records = this.readRecords(sheet, headerMap);
    return {
      path: this.currentPath,
      fileName: path.basename(this.currentPath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      records: records.length,
      queryable: records.filter((record) => !record.vesselState || record.vesselState !== '已到港已卸船').length,
    };
  }

  async listBackups() {
    await this.initialize();
    const entries = await fs.readdir(this.backupDirectory);
    const files = entries.filter((name) => name.endsWith('.xlsx'));
    return Promise.all(files.map(async (name) => {
      const filePath = path.join(this.backupDirectory, name);
      const stat = await fs.stat(filePath);
      let reason = '自动备份';
      try {
        const metadata = JSON.parse(await fs.readFile(`${filePath}.json`, 'utf8')) as { reason?: string };
        reason = metadata.reason || reason;
      } catch { /* 兼容没有元数据的旧备份 */ }
      return { name, size: stat.size, createdAt: stat.mtime.toISOString(), reason };
    })).then((items) => items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  backupPath(name: string) {
    const safeName = path.basename(name);
    if (safeName !== name || !safeName.endsWith('.xlsx')) throw new Error('备份文件名不合法');
    return path.join(this.backupDirectory, safeName);
  }

  async restore(name: string) {
    const backupPath = this.backupPath(name);
    await fs.access(backupPath);
    if (await this.exists()) await this.backup('恢复备份前自动备份');
    await fs.copyFile(backupPath, this.currentPath);
    return this.metadata();
  }

  async appendRecords(entries: Array<{ billNo: string; containerNo?: string; carrierHint?: string }>) {
    await this.initialize();
    let workbook: ExcelJS.Workbook;
    let sheet: ExcelJS.Worksheet;
    let headerMap: Map<HeaderName, number>;
    if (await this.exists()) {
      const opened = await this.open();
      workbook = opened.workbook;
      sheet = opened.sheet;
      headerMap = opened.headerMap;
    } else {
      workbook = new ExcelJS.Workbook();
      sheet = workbook.addWorksheet('船期追踪', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.addRow([...REQUIRED_HEADERS]);
      sheet.columns = [{ width: 18 }, { width: 21 }, { width: 20 }, { width: 18 }, { width: 21 }, { width: 19 }, { width: 21 }, { width: 38 }, { width: 13 }];
      const header = sheet.getRow(1);
      header.height = 30;
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0B3347' } };
        cell.font = { bold: true, color: { argb: 'FFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      headerMap = new Map(REQUIRED_HEADERS.map((headerName, index) => [headerName, index + 1] as [HeaderName, number]));
    }
    const existing = new Set(this.readRecords(sheet, headerMap).map((record) => record.billNo));
    const added: WorkbookRecord[] = [];
    const duplicates: string[] = [];
    for (const entry of entries) {
      const billNo = entry.billNo.trim().toUpperCase();
      if (!billNo) continue;
      if (existing.has(billNo)) {
        duplicates.push(billNo);
        continue;
      }
      const row = sheet.addRow([entry.carrierHint?.trim() || '', '', billNo, entry.containerNo?.trim().toUpperCase() || '', '未卸船', '未到港未卸船', '', '已加入单号库，等待查询', '待查询']);
      row.height = 29;
      if (row.number % 2 === 0) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F3F8F7' } }; });
      row.getCell(headerMap.get('备注')!).alignment = { wrapText: true, vertical: 'middle' };
      existing.add(billNo);
      added.push({ rowNumber: row.number, carrierHint: entry.carrierHint?.trim() || '', billNo, containerNo: entry.containerNo?.trim().toUpperCase() || '', arrivalTime: null, dischargeTime: null, vesselState: '未到港未卸船', lastUpdated: null, note: '已加入单号库，等待查询', progress: '待查询' });
    }
    await this.save(workbook);
    return { metadata: await this.metadata(), added, duplicates };
  }
}
