import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingDetail, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const EVERGREEN_ENDPOINT = 'https://www.evergreen-shipping.cn/servlet/TDB1_CargoTracking.do';
const DEFAULT_TIMEOUT_MS = 18_000;

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hiddenValue(html: string, name: string) {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${escapeRegex(name)}["'][^>]*>`, 'i'))?.[0] || '';
  return decodeHtml(tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || '');
}

function formatEvergreenDate(value: string) {
  const match = value.trim().match(/^([A-Z]{3})-(\d{2})-(\d{4})$/i);
  if (!match) return '';
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(match[1].toUpperCase()) + 1;
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[2]}` : '';
}

function eventRows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]));
    return { date: cells[0] || '', event: cells[1] || '', location: cells[2] || '', vessel: cells[3] || '' };
  }).filter((row) => row.date && row.event);
}

function splitVessel(value: string) {
  const matched = value.match(/^(.+?)\s+([A-Z0-9]+-[A-Z0-9]+)$/i);
  return { vesselName: matched?.[1]?.trim() || value || null, voyageNo: matched?.[2]?.trim() || null };
}

function eventDefinition(value: string): {
  label: string;
  eventType: TrackingEventType;
  cargoState: TrackingCargoState;
  transportMode: NonNullable<TrackingEventDetail['transportMode']>;
} {
  if (/empty container returned/i.test(value)) return { label: '还空箱', eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/empty pick-up/i.test(value)) return { label: '空箱交给发货人', eventType: 'origin', cargoState: 'empty', transportMode: 'truck' };
  if (/discharged/i.test(value)) return { label: '有货柜卸船', eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  if (/loaded.*vessel/i.test(value)) return { label: '有货柜装船', eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/pick-up by/i.test(value)) return { label: '有货柜提离场站', eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  if (/received.*FCL/i.test(value)) return { label: '重箱进入始发场站', eventType: 'origin', cargoState: 'laden', transportMode: 'terminal' };
  if (/arriv/i.test(value)) return { label: '船舶到港', eventType: 'arrival', cargoState: 'laden', transportMode: 'ocean' };
  return { label: value, eventType: 'other', cargoState: 'unknown', transportMode: 'unknown' };
}

function evergreenEvents(rows: ReturnType<typeof eventRows>) {
  return rows.map((row): TrackingEventDetail => {
    const definition = eventDefinition(row.event);
    const vessel = splitVessel(row.vessel);
    const date = formatEvergreenDate(row.date);
    return {
      label: definition.label,
      eventType: definition.eventType,
      location: row.location || null,
      // 官网仅提供日期且没有事件地点时区，保留原文精度，不能伪造具体时刻。
      time: null,
      timeText: date ? `${date}（官网仅提供日期）` : row.date || null,
      actual: true,
      cargoState: definition.cargoState,
      facility: null,
      vesselName: vessel.vesselName,
      voyageNo: vessel.voyageNo,
      transportMode: definition.transportMode,
      sourceLine: row.event,
    };
  });
}

function sameLocation(left: string, right: string) {
  return left.toUpperCase().replace(/[^A-Z0-9]/g, '') === right.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function evergreenRouteStops(events: TrackingEventDetail[]): TrackingRouteStop[] {
  const segments: Array<{ name: string; events: TrackingEventDetail[] }> = [];
  for (const event of events) {
    const location = event.location?.trim();
    if (!location) continue;
    const current = segments.at(-1);
    if (current && sameLocation(current.name, location)) current.events.push(event);
    else segments.push({ name: location, events: [event] });
  }
  return segments.map((segment, index) => {
    const role: TrackingRouteStop['role'] = index === 0
      ? 'origin'
      : segment.events.some((event) => event.eventType === 'discharge' || event.eventType === 'arrival')
        ? 'discharge'
        : segment.events.some((event) => ['pickup', 'delivery', 'empty-return'].includes(event.eventType)) || index === segments.length - 1
          ? 'delivery'
          : 'transshipment';
    return { name: segment.name, role };
  });
}

function cellPairs(html: string) {
  const pairs = new Map<string, string>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) => decodeHtml(cell[2]));
    for (let index = 0; index < cells.length - 1; index += 1) {
      if (cells[index] && cells[index + 1]) pairs.set(cells[index], cells[index + 1]);
    }
  }
  return pairs;
}

function evergreenFacts(billHtml: string, billNo: string, containerNo: string) {
  const pairs = cellPairs(billHtml);
  const entries: Array<[string, string]> = [
    ['提单号', `EGLV${billNo}`],
    ['柜号', containerNo],
    ['船舶/航次', pairs.get('提单列示之船名、航次') || ''],
    ['收货地', pairs.get('收货地(出口国)') || ''],
    ['装货港', pairs.get('装货港') || ''],
    ['卸货港', pairs.get('卸货港') || ''],
    ['交货地', pairs.get('交货地(进口国)') || ''],
    ['货柜数量', pairs.get('货柜数量') || ''],
    ['毛重', pairs.get('毛重') || ''],
    ['体积', pairs.get('体积') || ''],
    ['件数', pairs.get('件数') || ''],
    ['预计装船日', pairs.get('预计装船日') || ''],
    ['运送型态', pairs.get('运送型态') || ''],
  ];
  return entries.flatMap(([label, value]) => value ? [{ label, value }] : []);
}

export function parseEvergreenTrackingHtml(
  billHtml: string,
  movementHtml: string,
  queryBillNo: string,
  expectedContainerNo = '',
  context: { queryType: TrackingQuery['queryType']; queryValue: string } = { queryType: 'bill', queryValue: queryBillNo },
): TrackingResult {
  const bill = queryBillNo.trim().toUpperCase();
  if (!new RegExp(`EGLV\\s*${escapeRegex(bill)}`, 'i').test(billHtml)) {
    if (/not found|no result|未找到|查无/i.test(billHtml)) throw trackingError('订单号验证失败', `长荣官网未找到提单 EGLV${bill}`);
    throw trackingError('订单号验证失败', `长荣官网未确认输入提单 EGLV${bill}`);
  }
  const expected = expectedContainerNo.trim().toUpperCase();
  const returnedContainers = [...new Set([...billHtml.matchAll(/frmCntrMoveDetail\(['"]([A-Z]{4}\d{7})['"]\)/gi)].map((match) => match[1].toUpperCase()))];
  if (expected && returnedContainers.length && !returnedContainers.includes(expected)) {
    throw trackingError('订单号验证失败', `长荣官网返回的柜号与输入不一致（输入 ${expected}，官网返回 ${returnedContainers.join('、')}）`);
  }
  const rows = eventRows(movementHtml);
  if (!rows.length) throw trackingError('解析失败', '长荣官网货柜动态页没有可识别的事件记录');
  const events = evergreenEvents(rows);
  const routeStops = evergreenRouteStops(events);
  const discharge = events.find((event) => event.eventType === 'discharge');
  const arrival = events.find((event) => event.eventType === 'arrival');
  const dischargeDate = discharge?.timeText || '';
  const current = rows.at(-1);
  const containerNo = expected || returnedContainers[0] || '';
  const trackingDetail: TrackingDetail = {
    carrierCode: 'EVERGREEN',
    queryType: context.queryType,
    queryValue: context.queryValue,
    capturedAt: new Date().toISOString(),
    routeStops,
    events,
    facts: evergreenFacts(billHtml, bill, containerNo),
  };
  const routeText = routeStops.map((stop) => stop.name).join(' → ');
  return {
    arrivalTime: null,
    arrivalTimeText: arrival?.timeText || null,
    arrivalKind: arrival ? 'ATA' : null,
    arrived: Boolean(arrival || discharge || events.some((event) => ['pickup', 'delivery', 'empty-return'].includes(event.eventType))),
    discharged: Boolean(discharge),
    dischargeTime: null,
    dischargeTimeText: dischargeDate || null,
    rawSummary: `长荣官方提单与货柜动态解析成功；柜号=${containerNo || '未提供'}；已核验完整轨迹 ${events.length} 条；当前事件=${current?.event || '未提供'}${dischargeDate ? `；官网确认 ${dischargeDate} 已卸船，但未提供具体时刻` : '；未发现卸船完成事件'}`,
    sourceUrl: EVERGREEN_ENDPOINT,
    routeText,
    trackingDetail,
    rawPageText: JSON.stringify({ billHtml, movementHtml }, null, 2),
  };
}

function cookiesFrom(response: Response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(/,(?=[^;,]+=)/).map((cookie) => cookie.split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

async function responseText(response: Response, label: string) {
  const body = await response.text();
  if (response.ok) return body;
  const category = response.status === 403 || response.status === 412 ? '验证码或风控' : response.status === 401 ? '官网拒绝访问' : '官网接口异常';
  throw trackingError(category, `长荣官网${label} HTTP ${response.status}`);
}

export class EvergreenTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'EVERGREEN') throw trackingError('解析失败', `长荣解析器不能查询 ${input.rule.name}`);
    const requestedBillNo = input.queryBillNo.trim().toUpperCase();
    const requestedContainerNo = input.containerNo.trim().toUpperCase();
    if (input.queryType === 'bill' && !/^\d{10,14}$/.test(requestedBillNo)) throw trackingError('订单号验证失败', `长荣提单号格式不正确：EGLV${requestedBillNo || '空'}`);
    if (input.queryType === 'container' && !/^[A-Z]{4}\d{7}$/.test(requestedContainerNo)) throw trackingError('订单号验证失败', `长荣柜号格式不正确：${requestedContainerNo || '空'}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const homeResponse = await this.fetcher(EVERGREEN_ENDPOINT, { headers: { accept: 'text/html' }, signal: controller.signal });
      await responseText(homeResponse, '首页');
      const cookie = cookiesFrom(homeResponse);
      const commonHeaders = { accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) };
      let billNo = requestedBillNo;
      if (input.queryType === 'container') {
        const containerResponse = await this.fetcher(EVERGREEN_ENDPOINT, {
          method: 'POST',
          headers: commonHeaders,
          body: new URLSearchParams({ BL: '', CNTR: requestedContainerNo, bkno: '', TYPE: 'CNTR', SEL: 's_cntr', NO: requestedContainerNo }),
          signal: controller.signal,
        });
        const containerHtml = await responseText(containerResponse, '柜号查询');
        if (!new RegExp(escapeRegex(requestedContainerNo), 'i').test(containerHtml)) {
          throw trackingError('订单号验证失败', `长荣官网未找到柜号 ${requestedContainerNo}`);
        }
        billNo = hiddenValue(containerHtml, 'bl_no');
        if (!/^\d{10,14}$/.test(billNo)) throw trackingError('解析失败', `长荣柜号 ${requestedContainerNo} 查询成功，但官网没有返回可用于读取完整轨迹的提单号`);
      }
      const billResponse = await this.fetcher(EVERGREEN_ENDPOINT, {
        method: 'POST',
        headers: commonHeaders,
        body: new URLSearchParams({ BL: billNo, CNTR: '', bkno: '', TYPE: 'BL', SEL: 's_bl', NO: billNo }),
        signal: controller.signal,
      });
      const billHtml = await responseText(billResponse, '提单查询');
      const expected = requestedContainerNo;
      const containerNo = expected || billHtml.match(/frmCntrMoveDetail\(['"]([A-Z]{4}\d{7})['"]\)/i)?.[1] || '';
      if (!containerNo) throw trackingError('解析失败', '长荣官网提单结果缺少货柜号');
      const params = {
        bl_no: hiddenValue(billHtml, 'bl_no') || billNo,
        cntr_no: containerNo,
        onboard_date: hiddenValue(billHtml, 'onboard_date'),
        pol: hiddenValue(billHtml, 'pol'),
        pod: hiddenValue(billHtml, 'pod'),
        podctry: hiddenValue(billHtml, 'podctry'),
        TYPE: 'CntrMove',
      };
      if (!params.onboard_date || !params.pol || !params.pod) throw trackingError('解析失败', '长荣官网提单结果缺少货柜动态查询参数');
      const movementResponse = await this.fetcher(EVERGREEN_ENDPOINT, {
        method: 'POST',
        headers: commonHeaders,
        body: new URLSearchParams(params),
        signal: controller.signal,
      });
      const movementHtml = await responseText(movementResponse, '货柜动态查询');
      return parseEvergreenTrackingHtml(billHtml, movementHtml, billNo, containerNo, {
        queryType: input.queryType,
        queryValue: input.queryType === 'container' ? requestedContainerNo : requestedBillNo,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '长荣官网查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
