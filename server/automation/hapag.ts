import { trackingError } from './errors.js';
import { parseOoclDate } from './oocl.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const HAPAG_SOURCE = 'https://www.hapag-lloyd.cn/en/online-business/track/track-by-booking-solution.html';
const DATE_PATTERN = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/;

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function linesOf(value: string) {
  return value.replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

function eventDate(lines: string[], event: RegExp, excluded?: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!event.test(lines[index])) continue;
    const context = lines.slice(index, index + 2).join(' ');
    if (excluded?.test(lines[index])) continue;
    const matched = context.match(DATE_PATTERN)?.[0];
    if (matched) return matched.replace(/\./g, '-');
  }
  return '';
}

function localTime(value: string) {
  return value ? `${value}（官网当地时间）` : null;
}

export function parseHapagTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const lines = linesOf(text);
  const compactText = lines.join('\n');
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/security check|cloudflare|verify you are human|captcha|验证码|安全验证|被阻止/i.test(compactText)) {
    throw trackingError('验证码或风控', '赫伯罗特官网仍要求人工安全验证');
  }
  if (/no result|not found|no shipment|invalid|未找到|查无|无记录/i.test(compactText)) {
    throw trackingError('订单号验证失败', `赫伯罗特官网未找到 ${queryValue}`);
  }
  const normalizedText = normalizedReference(compactText);
  if (!normalizedText.includes(normalizedReference(queryValue))) {
    throw trackingError('解析失败', `赫伯罗特页面未显示查询号码 ${queryValue}，拒绝写入无法核验的数据`);
  }
  if (input.containerNo && !normalizedText.includes(normalizedReference(input.containerNo))) {
    throw trackingError('订单号验证失败', `赫伯罗特页面未显示输入柜号 ${input.containerNo}`);
  }

  const actualArrival = eventDate(lines, /actual(?: time of)? arrival|arrived at|arrival at (?:pod|destination)/i, /estimated|expected|arrival in/i);
  const estimatedArrival = eventDate(lines, /arrival in|estimated arrival|estimated time of arrival|\bETA\b/i, /actual|arrived|discharg/i);
  const discharge = eventDate(lines, /discharg|unload/i, /estimated|expected|planned/i);
  if (!actualArrival && !estimatedArrival && !discharge) {
    throw trackingError('解析失败', '赫伯罗特官网已返回柜号结果，但没有可验证的到港或实际卸船时间');
  }
  const arrivalText = actualArrival || estimatedArrival;
  const dateOnly = (value: string) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value);
  const parseDate = (value: string) => value && !dateOnly(value) ? parseOoclDate(value) : null;
  return {
    arrivalTime: parseDate(arrivalText),
    arrivalTimeText: arrivalText && dateOnly(arrivalText) ? localTime(arrivalText) : undefined,
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    arrived: Boolean(actualArrival || discharge),
    dischargeTime: parseDate(discharge),
    dischargeTimeText: discharge && dateOnly(discharge) ? localTime(discharge) : undefined,
    rawSummary: `赫伯罗特官网浏览器查询解析成功；查询号码=${queryValue}；柜号=${input.containerNo || '未提供'}${actualArrival ? `；实际到港=${actualArrival}` : estimatedArrival ? `；预计到港=${estimatedArrival}` : ''}${discharge ? `；实际卸船=${discharge}` : '；未发现实际卸船事件'}`,
    sourceUrl: HAPAG_SOURCE,
  };
}
