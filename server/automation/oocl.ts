import type { TrackingProvider } from './tracker.js';
import type { ArrivalKind, TrackingQuery, TrackingResult } from './types.js';

const OOCL_TRACKING_ENDPOINT = 'https://moc.oocl.com/appleapp/rest/ctLite/getCTDetails';
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

interface OoclResponse {
  result?: {
    responseCode?: string;
    exceptionCode?: string;
    searchResultRecord?: unknown;
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(object: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = textValue(object[key]);
    if (value) return value;
  }
  return '';
}

/**
 * OOCL Lite returns dates without a timezone in several formats. Those values
 * are local port times; this workbench normalizes timezone-less values as
 * Asia/Shanghai (UTC+8), while preserving explicit offsets from ISO strings.
 */
export function parseOoclDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const source = textValue(value);
  if (!source || /^(?:n\/?a|null|undefined|-)$/i.test(source)) return null;

  // Strings carrying Z or an explicit offset are absolute instants.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)) {
    const absolute = new Date(source);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }

  let parts: RegExpMatchArray | null;
  if ((parts = source.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/))) {
    return beijingDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
  }
  if ((parts = source.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)(?:[ T]([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    return beijingDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  if ((parts = source.match(/^([0-3]?\d)[-/]([01]?\d)[-/](\d{4})(?:[ T]([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    return beijingDate(Number(parts[3]), Number(parts[2]), Number(parts[1]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  if ((parts = source.match(/^([0-3]?\d)\s+([A-Za-z]{3,9})\s+(\d{4})(?:\s+([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/))) {
    const month = monthNumber(parts[2]);
    if (month) return beijingDate(Number(parts[3]), month, Number(parts[1]), Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  }
  return null;
}

function beijingDate(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  if (
    month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
  ) return null;
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function monthNumber(value: string) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const index = months.indexOf(value.slice(0, 3).toLowerCase());
  return index < 0 ? 0 : index + 1;
}

function allObjects(value: unknown): JsonObject[] {
  const result: JsonObject[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isObject(item)) return;
    result.push(item);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return result;
}

function eventName(object: JsonObject) {
  return firstText(object, ['event', 'eventName', 'eventDescription', 'description', 'status', 'activity']);
}

function eventTime(object: JsonObject) {
  return parseOoclDate(firstText(object, ['time', 'eventTime', 'eventDateTime', 'dateTime', 'eventDate', 'activityDate']));
}

function isDischargeEvent(value: string) {
  return /\b(?:discharg(?:e|ed|ing)|unload(?:ed|ing)?|container\s+discharge)\b/i.test(value) || /卸船|卸载/.test(value);
}

function indicationIsActual(value: string) {
  return /actual|ata|arrived/i.test(value) && !/estimated|estimate|eta/i.test(value);
}

function findArrival(record: unknown): { time: Date | null; kind: ArrivalKind } {
  const objects = allObjects(record);
  const actualKeys = ['ata', 'actualArrivalTime', 'actualArrivalDate', 'arrivalActualTime'];
  const estimateKeys = ['eta', 'estimatedArrivalTime', 'estimatedArrivalDate', 'arrivalEstimatedTime'];

  for (const object of objects) {
    const lastPodTime = parseOoclDate(firstText(object, ['lastPODTime', 'lastPodTime']));
    const indicator = firstText(object, ['lastPODTimeIndicator', 'lastPodTimeIndicator']);
    if (lastPodTime && indicationIsActual(indicator)) return { time: lastPodTime, kind: 'ATA' };
  }
  for (const object of objects) {
    const date = parseOoclDate(firstText(object, actualKeys));
    if (date) return { time: date, kind: 'ATA' };
  }
  for (const object of objects) {
    const lastPodTime = parseOoclDate(firstText(object, ['lastPODTime', 'lastPodTime']));
    if (lastPodTime) return { time: lastPodTime, kind: 'ETA' };
  }
  for (const object of objects) {
    const date = parseOoclDate(firstText(object, estimateKeys));
    if (date) return { time: date, kind: 'ETA' };
  }
  return { time: null, kind: null };
}

function findDischarge(record: unknown) {
  return allObjects(record)
    .map((object) => ({ object, name: eventName(object), time: eventTime(object) }))
    .filter((candidate) => candidate.name && isDischargeEvent(candidate.name) && candidate.time)
    .sort((a, b) => b.time!.getTime() - a.time!.getTime())[0] || null;
}

function containerNumbers(record: unknown) {
  return [...new Set(allObjects(record)
    .map((object) => firstText(object, ['containerNumber', 'containerNo']))
    .filter(Boolean))];
}

function matchingContainer(record: unknown, expectedContainerNo: string) {
  if (!expectedContainerNo) return null;
  return allObjects(record).find((object) => {
    const number = firstText(object, ['containerNumber', 'containerNo']);
    return number.toUpperCase() === expectedContainerNo;
  }) || null;
}

export function parseOoclTrackingResponse(payload: unknown, expectedContainerNo = ''): TrackingResult {
  if (!isObject(payload)) throw new Error('OOCL 返回了无法识别的数据格式');
  const response = payload as OoclResponse;
  const result = response.result;
  if (!result || result.responseCode !== 'SVC_OK_001') {
    const detail = result?.exceptionCode || result?.responseCode || '缺少业务响应码';
    throw new Error(`OOCL 官方查询暂不可用（${detail}）`);
  }
  const record = result.searchResultRecord;
  if (!record) throw new Error('OOCL 未返回该提单的追踪记录');

  const containers = containerNumbers(record);
  const expected = expectedContainerNo.trim().toUpperCase();
  if (expected && containers.length && !containers.some((value) => value.toUpperCase() === expected)) {
    throw new Error(`OOCL 返回的柜号与输入不一致（输入 ${expected}，官网返回 ${containers.join('、')}）`);
  }

  const selectedContainer = matchingContainer(record, expected);
  const scopedRecord = selectedContainer || record;
  const scopedArrival = findArrival(scopedRecord);
  const arrival = scopedArrival.time ? scopedArrival : findArrival(record);
  const discharge = findDischarge(scopedRecord);
  const matchedContainer = selectedContainer ? `；柜号=${expected}` : '';
  const dischargeSummary = discharge ? `；卸船事件=${discharge.name}` : '；未发现卸船完成事件';
  return {
    arrivalTime: arrival.time,
    arrivalKind: arrival.kind,
    arrived: arrival.kind === 'ATA' || Boolean(discharge),
    dischargeTime: discharge?.time || null,
    rawSummary: `OOCL 官方追踪解析成功${matchedContainer}${dischargeSummary}`,
    sourceUrl: 'https://www.oocl.com/schi/Pages/default.aspx',
  };
}

export class OoclTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'OOCL') throw new Error(`OOCL 解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw new Error('OOCL 解析器目前仅支持提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^OOLU[A-Z0-9]{6,}$/.test(billNo)) throw new Error(`OOCL 提单号格式不正确：${billNo || '空'}`);

    const url = new URL(OOCL_TRACKING_ENDPOINT);
    url.searchParams.set('paramString', `blNumber=${billNo}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OOCL 官方接口 HTTP ${response.status}`);
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(/<html|challenge|cloudflare/i.test(body)
          ? 'OOCL 官网返回了验证页面，暂时无法自动查询'
          : 'OOCL 返回了无法识别的数据格式');
      }
      return parseOoclTrackingResponse(payload, input.containerNo);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('OOCL 官方查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
