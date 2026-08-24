import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourceEvidenceDirectory, sourceEvidenceUrl } from './source-storage.js';
import type { CarrierRule, TrackingResult, WorkbookRecord } from './types.js';

function xml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sourceHost(value: string) {
  try { return new URL(value).host; } catch { return value || '未提供'; }
}

function shownTime(value: Date | string | null | undefined) {
  if (!value) return '未提供';
  return value instanceof Date ? value.toISOString() : value;
}

function wrap(value: string, size = 54) {
  const characters = [...value];
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += size) lines.push(characters.slice(index, index + size).join(''));
  return lines.length ? lines : ['未提供'];
}

function canonicalPayload(record: WorkbookRecord, rule: CarrierRule, result: TrackingResult) {
  return result.rawPageText || JSON.stringify({
    carrierCode: rule.code,
    billNo: record.billNo,
    containerNo: record.containerNo,
    arrivalTime: shownTime(result.arrivalTimeText || result.arrivalTime),
    arrivalKind: result.arrivalKind,
    dischargeTime: shownTime(result.dischargeTimeText || result.dischargeTime),
    arrived: result.arrived,
    discharged: result.discharged,
    routeText: result.routeText,
    trackingDetail: result.trackingDetail,
    rawSummary: result.rawSummary,
    sourceUrl: result.sourceUrl,
  });
}

export function renderApiEvidenceSvg(
  record: WorkbookRecord,
  rule: CarrierRule,
  result: TrackingResult,
  capturedAt = new Date().toISOString(),
) {
  const rawPayload = canonicalPayload(record, rule, result);
  const digest = createHash('sha256').update(rawPayload).digest('hex');
  const route = result.trackingDetail?.routeStops.map((stop) => stop.name).join(' → ') || result.routeText || '未提供';
  const eventLines = (result.trackingDetail?.events || []).slice(0, 12).map((event) => {
    const when = event.timeText || event.time || '时间未提供';
    return `${event.actual ? '实际' : '预计'} · ${event.label} · ${event.location || '地点未提供'} · ${when}`;
  });
  const rows = [
    `船司：${rule.name}（${rule.code}）`,
    `提单号：${record.billNo}`,
    `柜号：${record.containerNo || '未提供'}`,
    `采集时间：${capturedAt}`,
    `来源域名：${sourceHost(result.sourceUrl)}`,
    `到港：${result.arrivalKind || 'ATA/ETA 未区分'} · ${shownTime(result.arrivalTimeText || result.arrivalTime)}`,
    `卸船：${shownTime(result.dischargeTimeText || result.dischargeTime)}`,
  ];
  const textLines = [
    ...rows,
    ...wrap(`完整线路：${route}`),
    ...(eventLines.length ? ['关键轨迹事件：', ...eventLines.flatMap((line) => wrap(line))] : ['关键轨迹事件：官网响应未提供结构化事件']),
  ];
  const height = Math.max(720, 250 + textLines.length * 30);
  const body = textLines.map((line, index) => `<text x="64" y="${230 + index * 30}" class="row">${xml(line)}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-label="官方接口采集凭证">
  <rect width="1120" height="${height}" fill="#f4f8f8"/>
  <rect x="34" y="34" width="1052" height="${height - 68}" rx="24" fill="#ffffff" stroke="#cddcda"/>
  <rect x="34" y="34" width="1052" height="130" rx="24" fill="#123f3c"/>
  <rect x="34" y="130" width="1052" height="34" fill="#123f3c"/>
  <text x="64" y="88" class="title">官方接口采集凭证</text>
  <text x="64" y="126" class="subtitle">非船司网页截图 · 用于复核本次自动查询返回</text>
  ${body}
  <line x1="64" y1="${height - 118}" x2="1056" y2="${height - 118}" stroke="#d9e5e3"/>
  <text x="64" y="${height - 78}" class="hash">原始响应 SHA-256：${digest}</text>
  <text x="64" y="${height - 48}" class="foot">原始响应与完整结构化轨迹保存在当前用户隔离的数据目录中；本凭证不冒充船司网页截图。</text>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .title { fill: #fff; font-size: 31px; font-weight: 700; }
    .subtitle { fill: #c5ddda; font-size: 17px; }
    .row { fill: #183a38; font-size: 18px; }
    .hash { fill: #456663; font-size: 15px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .foot { fill: #6b817f; font-size: 14px; }
  </style>
</svg>`;
}

export async function createApiEvidence(
  dataDirectory: string,
  record: WorkbookRecord,
  rule: CarrierRule,
  result: TrackingResult,
) {
  const evidenceDirectory = sourceEvidenceDirectory(dataDirectory, rule.code);
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const reference = `${record.billNo}_${record.containerNo}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 48) || 'UNKNOWN';
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${rule.code}_${reference}_api-success.svg`;
  await fs.writeFile(path.join(evidenceDirectory, fileName), renderApiEvidenceSvg(record, rule, result), { encoding: 'utf8', mode: 0o600 });
  return sourceEvidenceUrl(rule.code, fileName);
}
