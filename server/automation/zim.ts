import { trackingError } from './errors.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const ZIM_SOURCE = 'https://www.zimchina.com/tools/track-a-shipment';
const DATE_PATTERN = /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}-[A-Za-z]{3,9}-\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function linesOf(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeDateText(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  const monthWithHyphen = compact.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})(.*)$/);
  return monthWithHyphen ? `${monthWithHyphen[1]} ${monthWithHyphen[2]} ${monthWithHyphen[3]}${monthWithHyphen[4]}` : compact;
}

function eventDate(lines: string[], event: RegExp, excluded?: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!event.test(lines[index])) continue;
    const context = lines.slice(index, index + 2).join(' ');
    if (excluded?.test(lines[index])) continue;
    const matched = context.match(DATE_PATTERN)?.[0];
    if (matched) return normalizeDateText(matched);
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

export function parseZimTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = linesOf(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止/i.test(compactText)) {
    throw trackingError('验证码或风控', '以星官网仍要求安全验证或被风控拦截');
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `以星官网未找到 ${queryValue}`);
  }

  const normalizedText = normalizedReference(compactText);
  if (!normalizedText.includes(normalizedReference(queryValue))) {
    throw trackingError('解析失败', `以星页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  if (input.containerNo && !normalizedText.includes(normalizedReference(input.containerNo))) {
    throw trackingError('订单号验证失败', `以星页面未显示输入柜号 ${input.containerNo}`);
  }

  const actualArrival = eventDate(
    lines,
    /actual(?: time of)? arrival|arrived at|\bATA\b|vessel arrival at (?:pod|port of discharge)/i,
    /estimated|expected|original|current|planned/i,
  );
  const estimatedArrival = eventDate(lines, /current ETA|estimated time of arrival|\bETA\b|arrival\b/i, /actual|arrived|discharged/i)
    || eventDate(lines, /original ETA/i);
  const discharge = eventDate(lines, /(?:discharged|discharge completed|discharged from vessel|unloaded from vessel|container discharge)/i, /estimated|expected|planned/i);
  const arrivalText = actualArrival || estimatedArrival;
  if (!arrivalText && !discharge) {
    throw trackingError('解析失败', '以星官网已返回订单结果，但没有可验证的 ATA、ETA 或实际卸船时间');
  }

  return {
    arrivalTime: null,
    arrivalTimeText: localTime(arrivalText),
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    arrived: Boolean(actualArrival || discharge),
    dischargeTime: null,
    dischargeTimeText: localTime(discharge),
    rawSummary: `以星官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${actualArrival ? `；实际到港=${actualArrival}` : estimatedArrival ? `；预计到港=${estimatedArrival}` : ''}${discharge ? `；实际卸船=${discharge}` : '；未发现实际卸船事件'}；官网时间按当地时间原样保留`,
    sourceUrl: ZIM_SOURCE,
  };
}
