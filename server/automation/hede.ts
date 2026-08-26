import { trackingError } from './errors.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const HEDE_ENDPOINT = 'http://elines.hedehk.com/getVBilldynamic';
const HEDE_DETAIL_ENDPOINT = 'http://elines.hedehk.com/openInfo';
const HEDE_DYNAMIC_ENDPOINT = 'http://elines.hedehk.com/getCntrDynamic';
const HEDE_SOURCE = 'http://elines.hedehk.com/cargoDynamic';
const DEFAULT_TIMEOUT_MS = 20_000;

function decodeHtml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_matched, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_matched, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function localTime(value: string) {
  const normalized = value.trim().replace('T', ' ');
  return normalized ? `${normalized}（官网未标注时区）` : null;
}

function cellsFromRow(row: string) {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
}

function readRows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*class=["'][^"']*\bread-tr\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => cellsFromRow(match[1]))
    .filter((cells) => cells.length > 0);
}

function tableByTitle(html: string, title: string) {
  const titleIndex = html.search(new RegExp(`>\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`, 'i'));
  if (titleIndex < 0) return '';
  const start = html.lastIndexOf('<table', titleIndex);
  const end = html.indexOf('</table>', titleIndex);
  return start >= 0 && end >= 0 ? html.slice(start, end + '</table>'.length) : '';
}

function rowsFromTable(html: string, title: string) {
  const table = tableByTitle(html, title);
  return table ? readRows(table) : [];
}

function inputValues(value: string) {
  return [...value.matchAll(/<input\b[^>]*\bvalue=["']([^"']*)["'][^>]*>/gi)].map((match) => decodeHtml(match[1]).trim());
}

function detailValues(html: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = html.match(new RegExp(`<td\\b[^>]*>\\s*${escaped}\\s*<\\/td>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, 'i'))?.[1] || '';
  return inputValues(matched).filter(Boolean);
}

function firstDetailValue(html: string, label: string) {
  return detailValues(html, label)[0] || '';
}

type SummaryRow = {
  cells: string[];
  billNo: string;
  containerNo: string;
  vesselName: string;
  voyageNo: string;
  eta: string;
  discharge: string;
  detailParams: { id: string; vid: string; pvid: string } | null;
};

function summaryRow(html: string): SummaryRow {
  const decoded = decodeHtml(html);
  const rowMatch = decoded.match(/<tr\b[^>]*class=["'][^"']*\bread-tr\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/i);
  const cells = rowMatch ? cellsFromRow(rowMatch[1]) : [];
  if (cells.length < 12) {
    if (/未查询到提单数据|未找到|没有|无记录|not found|no result/i.test(decoded)) {
      throw trackingError('订单号验证失败', '合德官网未找到该提单或柜号');
    }
    throw trackingError('解析失败', '合德官网返回了无法识别的提单箱时间线');
  }
  const detail = decoded.match(/openInfo\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/i);
  return {
    cells,
    billNo: cells[0].toUpperCase(),
    containerNo: cells[1].toUpperCase(),
    vesselName: cells[2],
    voyageNo: cells[3],
    eta: cells[5],
    discharge: cells[9],
    detailParams: detail ? { id: detail[1], vid: detail[2], pvid: detail[3] } : null,
  };
}

function sameLocation(left: string, right: string) {
  const normalize = (value: string) => value.toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function namedPort(values: string[]) {
  if (!values.length) return '';
  return values.length > 1 ? `${values[0]} (${values[1]})` : values[0];
}

function routeFromDetail(detailHtml: string, events: TrackingEventDetail[], destination = '') {
  const loading = namedPort(detailValues(detailHtml, '装货港')) || namedPort(detailValues(detailHtml, '起运港'));
  const discharge = namedPort(detailValues(detailHtml, '卸货港')) || namedPort(detailValues(detailHtml, '目的港'));
  const stops: TrackingRouteStop[] = [];
  if (loading) stops.push({ name: loading, role: 'loading' });
  for (const event of events) {
    const location = event.location;
    if (!location || stops.some((stop) => sameLocation(stop.name, location))) continue;
    if (discharge && sameLocation(discharge, location)) continue;
    stops.push({
      name: location,
      role: destination && sameLocation(location, destination) ? 'discharge' : 'transshipment',
    });
  }
  if (discharge && !stops.some((stop) => sameLocation(stop.name, discharge))) stops.push({ name: discharge, role: 'discharge' });
  return stops;
}

function eventDefinition(code: string, label: string, emptyOrFull: string): { eventType: TrackingEventType; cargoState: TrackingCargoState; transportMode: TrackingEventDetail['transportMode'] } {
  if (/空箱还回|空箱进场|empty.*(?:return|gate.?in)/i.test(label) || /^(?:RBC|MTE)$/i.test(code)) {
    return { eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  }
  if (/重箱出场|提货|pickup|gate.?out.*(?:full|laden)/i.test(label)) {
    return { eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  }
  if (/卸船|discharg|unload/i.test(label) || /^DIS$/i.test(code)) {
    return { eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  }
  if (/到港|抵达|arriv/i.test(label) && !/预计|estimate|expected/i.test(label)) {
    return { eventType: 'arrival', cargoState: emptyOrFull === 'E' ? 'empty' : 'laden', transportMode: 'ocean' };
  }
  if (/箱子装船|装船|loaded on/i.test(label) || /^LOB$/i.test(code)) {
    return { eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  }
  if (/重箱进场|received.*terminal/i.test(label) || /^RBS$/i.test(code)) {
    return { eventType: 'origin', cargoState: 'laden', transportMode: 'terminal' };
  }
  if (/空箱出场|箱子起租/i.test(label) || /^(?:RTS|LSI)$/i.test(code)) {
    return { eventType: 'pickup', cargoState: 'empty', transportMode: 'truck' };
  }
  return { eventType: 'other', cargoState: emptyOrFull === 'E' ? 'empty' : emptyOrFull === 'F' ? 'laden' : 'unknown', transportMode: 'unknown' };
}

function dynamicEvents(dynamicHtml: string, vesselName: string, voyageNo: string, bookingTime: string) {
  const rows = rowsFromTable(dynamicHtml, '箱动态').filter((cells) => cells.length >= 12);
  const relevantRows = rows.filter((cells) => {
    const rowVessel = cells[10];
    const rowVoyage = cells[11];
    if (vesselName && rowVessel && rowVessel.toUpperCase() === vesselName.toUpperCase()) return true;
    if (voyageNo && rowVoyage && rowVoyage.toUpperCase() === voyageNo.toUpperCase()) return true;
    return !rowVessel && !rowVoyage && (!bookingTime || cells[2].replace('T', ' ') >= bookingTime);
  });
  const selected = relevantRows.length ? relevantRows : rows.filter((cells) => !bookingTime || cells[2].replace('T', ' ') >= bookingTime);
  const events = selected.map((cells): TrackingEventDetail => {
    const definition = eventDefinition(cells[0], cells[1], cells[9]);
    return {
      label: `${cells[1]} (${cells[0]})`,
      eventType: definition.eventType,
      location: cells[7] || null,
      facility: cells[8] || null,
      time: null,
      timeText: localTime(cells[2]),
      actual: true,
      cargoState: definition.cargoState,
      vesselName: cells[10] || null,
      voyageNo: cells[11] || null,
      transportMode: definition.transportMode,
      sourceLine: cells.join(' | '),
    };
  });
  events.sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
  return { events, totalRows: rows.length };
}

function summaryEvents(row: SummaryRow, detailHtml: string) {
  const origin = firstDetailValue(detailHtml, '装货港') || firstDetailValue(detailHtml, '起运港') || null;
  const destination = firstDetailValue(detailHtml, '卸货港') || firstDetailValue(detailHtml, '目的港') || null;
  const definitions: Array<{ index: number; label: string; eventType: TrackingEventType; cargoState: TrackingCargoState; location: string | null; actual: boolean }> = [
    { index: 4, label: '预离', eventType: 'departure', cargoState: 'laden', location: origin, actual: false },
    { index: 5, label: '预抵', eventType: 'arrival', cargoState: 'laden', location: destination, actual: false },
    { index: 6, label: '空箱出场', eventType: 'pickup', cargoState: 'empty', location: origin, actual: true },
    { index: 7, label: '重箱进场', eventType: 'origin', cargoState: 'laden', location: origin, actual: true },
    { index: 8, label: '装船', eventType: 'departure', cargoState: 'laden', location: origin, actual: true },
    { index: 9, label: '卸船', eventType: 'discharge', cargoState: 'laden', location: destination, actual: true },
    { index: 10, label: '重箱出场', eventType: 'pickup', cargoState: 'laden', location: destination, actual: true },
    { index: 11, label: '空箱还回', eventType: 'empty-return', cargoState: 'empty', location: destination, actual: true },
  ];
  return definitions.flatMap((definition): TrackingEventDetail[] => {
    const value = row.cells[definition.index];
    if (!value) return [];
    return [{
      label: definition.label,
      eventType: definition.eventType,
      location: definition.location,
      time: null,
      timeText: localTime(value),
      actual: definition.actual,
      cargoState: definition.cargoState,
      vesselName: row.vesselName || null,
      voyageNo: row.voyageNo || null,
      transportMode: definition.eventType === 'arrival' || definition.eventType === 'departure' || definition.eventType === 'discharge' ? 'ocean' : 'terminal',
      sourceLine: `${definition.label} | ${value}`,
    }];
  });
}

function uniqueEvents(events: TrackingEventDetail[]) {
  const unique = new Map<string, TrackingEventDetail>();
  for (const event of events) {
    const key = `${event.eventType}|${event.label.replace(/\s*\([^)]*\)$/, '')}|${event.timeText}|${event.location || ''}`.toUpperCase();
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => (left.timeText || '').localeCompare(right.timeText || ''));
}

function detailFacts(row: SummaryRow, detailHtml: string, dynamicCount: number) {
  const voyage = rowsFromTable(detailHtml, '航次信息')[0] || [];
  const container = rowsFromTable(detailHtml, '箱信息')[0] || [];
  const pairs: Array<[string, string]> = [
    ['订单号', firstDetailValue(detailHtml, '订单号')],
    ['提单号', row.billNo],
    ['柜号', row.containerNo],
    ['营运人', firstDetailValue(detailHtml, '营运人')],
    ['起运港', namedPort(detailValues(detailHtml, '起运港'))],
    ['装货港', namedPort(detailValues(detailHtml, '装货港'))],
    ['卸货港', namedPort(detailValues(detailHtml, '卸货港'))],
    ['目的港', namedPort(detailValues(detailHtml, '目的港'))],
    ['订舱时间', firstDetailValue(detailHtml, '订舱时间')],
    ['订舱确认时间', firstDetailValue(detailHtml, '订舱确认时间')],
    ['提单确认时间', firstDetailValue(detailHtml, '提单确认时间')],
    ['放货时间', firstDetailValue(detailHtml, '放货时间')],
    ['航次性质', voyage[0] || ''],
    ['英文船名', voyage[1] || row.vesselName],
    ['中文船名', voyage[2] || ''],
    ['航次', voyage[3] || row.voyageNo],
    ['航次开始时间', voyage[4] || ''],
    ['航次结束时间', voyage[5] || ''],
    ['航线名称', voyage[6] || ''],
    ['最后动态', container[1] || ''],
    ['最后动态时间', container[2] || ''],
    ['箱型/尺寸', [container[3], container[4]].filter(Boolean).join(' / ')],
    ['铅封号', container[5] || ''],
    ['空重', container[6] || ''],
    ['重量', container[7] || ''],
    ['官网返回箱动态数', dynamicCount ? String(dynamicCount) : ''],
  ];
  return pairs.flatMap(([label, value]) => value ? [{ label, value }] : []);
}

export function parseHedeTrackingHtml(
  summaryHtml: string,
  expectedBillNo = '',
  expectedContainerNo = '',
  detailHtml = '',
  dynamicHtml = '',
  queryType: TrackingQuery['queryType'] = 'bill',
): TrackingResult {
  const row = summaryRow(summaryHtml);
  if (expectedBillNo && row.billNo !== expectedBillNo.trim().toUpperCase()) {
    throw trackingError('订单号验证失败', `合德返回提单号不一致：${row.billNo}`);
  }
  if (expectedContainerNo && row.containerNo !== expectedContainerNo.trim().toUpperCase()) {
    throw trackingError('订单号验证失败', `合德返回柜号不一致：${row.containerNo}`);
  }

  const voyage = rowsFromTable(detailHtml, '航次信息')[0] || [];
  const bookingTime = firstDetailValue(detailHtml, '订舱时间');
  const parsedDynamic = dynamicHtml ? dynamicEvents(dynamicHtml, voyage[1] || row.vesselName, voyage[3] || row.voyageNo, bookingTime) : { events: [], totalRows: 0 };
  const events = uniqueEvents([
    ...parsedDynamic.events,
    ...summaryEvents(row, detailHtml),
  ]);
  const destination = namedPort(detailValues(detailHtml, '卸货港')) || namedPort(detailValues(detailHtml, '目的港'));
  const isDestinationEvent = (event: TrackingEventDetail) => !destination || (event.location ? sameLocation(event.location, destination) : ['discharge', 'pickup'].includes(event.eventType));
  const destinationEvents = events.filter(isDestinationEvent);
  const arrival = [...destinationEvents].reverse().find((event) => event.eventType === 'arrival' && event.actual);
  const discharge = [...destinationEvents].reverse().find((event) => event.eventType === 'discharge' && event.actual);
  const subsequent = [...destinationEvents].reverse().find((event) => event.actual && (event.eventType === 'pickup' || event.eventType === 'empty-return') && event.cargoState !== 'empty');
  const stops = routeFromDetail(detailHtml, events, destination);
  const routeText = stops.map((stop) => stop.name).join(' → ') || null;
  const queryValue = queryType === 'container' ? row.containerNo : row.billNo;
  const rawPageText = [
    '===== 合德提单箱时间线 =====',
    summaryHtml,
    detailHtml ? '===== 合德订单、航次及箱信息 =====\n' + detailHtml : '',
    dynamicHtml ? '===== 合德完整箱动态 =====\n' + dynamicHtml : '',
  ].filter(Boolean).join('\n\n');

  return {
    arrivalTime: null,
    arrivalTimeText: arrival?.timeText || localTime(row.eta),
    arrivalKind: arrival ? 'ATA' : row.eta ? 'ETA' : null,
    estimatedArrivalTimeText: row.eta ? localTime(row.eta) : null,
    arrived: Boolean(discharge || subsequent),
    discharged: Boolean(discharge || subsequent),
    dischargeTime: null,
    dischargeTimeText: discharge?.timeText || localTime(row.discharge),
    rawSummary: `合德官网完整查询成功；船名/航次=${row.vesselName || '未提供'} / ${row.voyageNo || '未提供'}；已解析本票 ${events.length} 条事件${parsedDynamic.totalRows ? `（官网共返回 ${parsedDynamic.totalRows} 条柜历史动态，已按本票船名/航次筛选）` : ''}`,
    sourceUrl: HEDE_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'HEDE',
      queryType,
      queryValue,
      capturedAt: new Date().toISOString(),
      routeStops: stops,
      events,
      currentPort: [...events].reverse().find((event) => event.actual && event.location)?.location || null,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText: row.eta ? localTime(row.eta) : null,
      facts: detailFacts(row, detailHtml, parsedDynamic.totalRows),
    },
    rawPageText,
  };
}

export class HedeTrackingProvider implements TrackingProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async query(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'HEDE') throw new Error(`合德解析器不能查询 ${input.rule.name}`);
    const billNo = input.queryType === 'bill' ? input.queryBillNo.trim().toUpperCase() : '';
    const containerNo = input.containerNo.trim().toUpperCase();
    if (input.queryType === 'bill' && !/^HDUJ[A-Z0-9]{6,}$/.test(billNo)) {
      throw trackingError('订单号验证失败', `合德提单号格式不正确：${billNo || '空'}`);
    }
    if (input.queryType === 'container' && !/^[A-Z]{4}\d{7}$/.test(containerNo)) {
      throw trackingError('订单号验证失败', `合德柜号格式不正确：${containerNo || '空'}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const fetchText = async (url: string, init?: RequestInit) => {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) throw trackingError('官网接口异常', `合德官网 HTTP ${response.status}`);
      return response.text();
    };
    try {
      const summaryHtml = await fetchText(HEDE_ENDPOINT, {
        method: 'POST',
        headers: { accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          billno: billNo,
          cntr: input.queryType === 'container' ? containerNo : '',
          selecttype: '1',
          resultlist: '1',
          paramtype: '1',
        }).toString(),
      });
      const row = summaryRow(summaryHtml);
      if (input.queryType === 'bill' && row.billNo !== billNo) {
        throw trackingError('订单号验证失败', `合德返回提单号不一致：${row.billNo}`);
      }
      if (input.queryType === 'container' && row.containerNo !== containerNo) {
        throw trackingError('订单号验证失败', `合德返回柜号不一致：${row.containerNo}`);
      }
      if (!row.detailParams) throw trackingError('解析失败', '合德结果缺少订单详情入口，无法采集完整线路');
      const detailUrl = new URL(HEDE_DETAIL_ENDPOINT);
      detailUrl.search = new URLSearchParams({ ...row.detailParams, paramtype: '1' }).toString();
      const detailHtml = await fetchText(detailUrl.toString(), { headers: { accept: 'text/html,application/xhtml+xml' } });
      const dynamicContainer = row.containerNo || containerNo;
      if (!dynamicContainer) throw trackingError('解析失败', '合德订单详情未返回柜号，无法采集完整箱动态');
      const dynamicUrl = new URL(HEDE_DYNAMIC_ENDPOINT);
      dynamicUrl.search = new URLSearchParams({ cntr: dynamicContainer, vid: row.detailParams.vid, pvid: row.detailParams.pvid }).toString();
      const dynamicHtml = await fetchText(dynamicUrl.toString(), { headers: { accept: 'text/html,application/xhtml+xml' } });
      return parseHedeTrackingHtml(
        summaryHtml,
        input.queryType === 'bill' ? billNo : '',
        input.queryType === 'container' ? containerNo : input.containerNo,
        detailHtml,
        dynamicHtml,
        input.queryType,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw trackingError('查询超时', '合德官网完整查询超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
