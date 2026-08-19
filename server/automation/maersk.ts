import { trackingError } from './errors.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const MAERSK_SOURCE = 'https://www.maersk.com/tracking/';
const DATE_PATTERN = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedLocation(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pageLines(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ ]+/g, ' ').trim())
    .filter(Boolean);
}

function destinationFromHeader(lines: string[]) {
  const headerIndex = lines.findIndex((line) => /bill of lading number/i.test(line));
  if (headerIndex < 0) return '';
  const headerEnd = Math.min(lines.length - 1, headerIndex + 12);
  for (let index = headerIndex; index < headerEnd; index += 1) {
    const headings = lines[index].split(/\t+/).map((value) => value.trim());
    const destinationColumn = headings.findIndex((value) => /^to$/i.test(value));
    if (destinationColumn >= 0) {
      const values = lines[index + 1].split(/\t+/).map((value) => value.trim());
      if (values[destinationColumn]) return values[destinationColumn];
    }

    if (/^to$/i.test(lines[index])) return lines[index + 1];
    const inline = lines[index].match(/(?:^|\s)To\s+([A-Z][A-Z .'-]{2,})$/i)?.[1]?.trim();
    if (inline) return inline;
  }
  return '';
}

function destinationTimeline(lines: string[], destination: string) {
  const expected = normalizedLocation(destination);
  if (!expected) return lines;
  let destinationIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const columns = lines[index].split(/\t+/).map((value) => normalizedLocation(value));
    if (columns.some((value) => value === expected)) destinationIndex = index;
  }
  return destinationIndex >= 0 ? lines.slice(destinationIndex) : lines;
}

function eventDate(lines: string[], event: RegExp, excluded = /estimated|expected|planned|scheduled/i) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!event.test(lines[index])) continue;
    const forwardContext = lines.slice(index, index + 3).join(' ');
    if (excluded.test(forwardContext)) continue;
    const matched = forwardContext.match(DATE_PATTERN)?.[0]
      || lines.slice(Math.max(0, index - 2), index + 1).join(' ').match(DATE_PATTERN)?.[0];
    if (matched) return matched;
  }
  return '';
}

function estimatedArrivalDate(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/\bETA\b|estimated(?: vessel)? arrival|expected arrival/i.test(lines[index])) continue;
    const matched = lines.slice(Math.max(0, index - 1), index + 3).join(' ').match(DATE_PATTERN)?.[0];
    if (matched) return matched;
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

export function parseMaerskTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = pageLines(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|enable javascript and cookies/i.test(compactText)) {
    throw trackingError('验证码或风控', '马士基浏览器页面仍要求安全验证或被风控拦截');
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `马士基官网未找到 ${queryValue}`);
  }

  const normalizedText = normalizedReference(compactText);
  const expectedQuery = normalizedReference(queryValue);
  if (!expectedQuery || !normalizedText.includes(expectedQuery)) {
    throw trackingError('解析失败', `马士基页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  const expectedContainer = normalizedReference(input.containerNo);
  if (expectedContainer && !normalizedText.includes(expectedContainer)) {
    throw trackingError('订单号验证失败', `马士基页面返回的轨迹未包含输入柜号 ${input.containerNo}`);
  }

  const destination = destinationFromHeader(lines);
  const destinationLines = destinationTimeline(lines, destination);
  const dischargeTime = eventDate(destinationLines, /^discharge\b|container discharged|discharged from vessel/i);
  const vesselArrivalTime = eventDate(destinationLines, /^vessel arrival\b|actual(?: time of)? arrival|\bATA\b/i);
  const pageConfirmsArrival = lines.some((line) => /^arrived at\b/i.test(line));
  const actualArrivalTime = pageConfirmsArrival || dischargeTime ? vesselArrivalTime : '';
  const etaTime = actualArrivalTime ? '' : estimatedArrivalDate(destinationLines) || estimatedArrivalDate(lines);

  if (!actualArrivalTime && !etaTime && !dischargeTime) {
    throw trackingError('解析失败', '马士基官网已返回对应提单和柜号，但目的港区段没有可验证的 ATA、ETA 或实际卸船时间');
  }

  const arrivalKind = actualArrivalTime ? 'ATA' as const : etaTime ? 'ETA' as const : null;
  const arrivalTimeText = localTime(actualArrivalTime || etaTime);
  const dischargeTimeText = localTime(dischargeTime);
  return {
    arrivalTime: null,
    arrivalTimeText,
    arrivalKind,
    arrived: Boolean(actualArrivalTime || dischargeTime),
    dischargeTime: null,
    dischargeTimeText,
    rawSummary: `马士基官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${destination ? `；目的港=${destination}` : ''}${actualArrivalTime ? `；目的港实际到港=${actualArrivalTime}` : etaTime ? `；目的港预计到港=${etaTime}` : ''}${dischargeTime ? `；目的港实际卸船=${dischargeTime}` : '；未发现目的港实际卸船事件'}；官网明确所有时间均为当地时间`,
    sourceUrl: MAERSK_SOURCE,
  };
}
