import { trackingError } from './errors.js';
import type { TrackingCargoState, TrackingEventDetail, TrackingEventType, TrackingFact, TrackingQuery, TrackingResult, TrackingRouteStop } from './types.js';

const MSC_SOURCE = 'https://www.msccargo.cn/en/track-a-shipment?agencyPath=hkg';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function bool(value: unknown) {
  return value === true;
}

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedLocation(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
}

function sameLocation(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizedLocation(left || '');
  const b = normalizedLocation(right || '');
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aHead = normalizedLocation((left || '').split(',')[0]);
  const bHead = normalizedLocation((right || '').split(',')[0]);
  return Boolean(aHead && bHead && (aHead === bHead || aHead.includes(bHead) || bHead.includes(aHead)));
}

function officialDate(value: unknown) {
  const matched = text(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return matched ? `${matched[3]}-${matched[2]}-${matched[1]}（官网仅提供日期，未标注具体时刻）` : null;
}

function eventDefinition(description: string, details: string[]): { eventType: TrackingEventType; cargoState: TrackingCargoState; transportMode: TrackingEventDetail['transportMode'] } {
  const detailState = details.map((value) => value.toUpperCase());
  if (/empty received|empty.*return/i.test(description)) return { eventType: 'empty-return', cargoState: 'empty', transportMode: 'terminal' };
  if (/empty to shipper|empty.*release/i.test(description)) return { eventType: 'pickup', cargoState: 'empty', transportMode: 'truck' };
  if (/transshipment discharged|import discharged|discharged from vessel|unloaded/i.test(description)) return { eventType: 'discharge', cargoState: 'laden', transportMode: 'ocean' };
  if (/vessel arrival|arrival at/i.test(description)) return { eventType: 'arrival', cargoState: detailState.includes('EMPTY') ? 'empty' : 'laden', transportMode: 'ocean' };
  if (/loaded on vessel|transshipment loaded|vessel departure|departure from/i.test(description)) return { eventType: 'departure', cargoState: 'laden', transportMode: 'ocean' };
  if (/export received|gate in/i.test(description)) return { eventType: 'origin', cargoState: detailState.includes('EMPTY') ? 'empty' : 'laden', transportMode: 'terminal' };
  if (/full available for delivery/i.test(description)) return { eventType: 'delivery', cargoState: 'laden', transportMode: 'terminal' };
  if (/import to consignee|gate out|picked up/i.test(description)) return { eventType: 'pickup', cargoState: 'laden', transportMode: 'truck' };
  return {
    eventType: 'other',
    cargoState: detailState.includes('EMPTY') ? 'empty' : detailState.includes('LADEN') ? 'laden' : 'unknown',
    transportMode: 'unknown',
  };
}

function structuredEvents(container: JsonRecord) {
  return array(container.Events).map(record).map((event): TrackingEventDetail => {
    const description = text(event.Description) || '官网未命名事件';
    const details = array(event.Detail).map(text).filter(Boolean);
    const definition = eventDefinition(description, details);
    const vesselName = details.length >= 2 && !/^(?:EMPTY|LADEN)$/i.test(details[0]) ? details[0] : null;
    const voyageNo = vesselName ? details[1] || null : null;
    const equipment = record(event.EquipmentHandling);
    const vessel = record(event.Vessel);
    return {
      label: description,
      eventType: definition.eventType,
      location: text(event.Location) || null,
      facility: text(equipment.Name) || null,
      time: null,
      timeText: officialDate(event.Date),
      actual: !/estimated|expected|planned|scheduled/i.test(description),
      cargoState: definition.cargoState,
      vesselName,
      voyageNo,
      transportMode: definition.transportMode,
      sourceLine: JSON.stringify({
        order: event.Order,
        date: event.Date,
        location: event.Location,
        unLocationCode: event.UnLocationCode,
        description,
        detail: details,
        equipmentHandling: equipment,
        vessel,
        intermediaryPortCalls: event.IntermediaryPortCalls,
      }),
    };
  }).sort((left, right) => {
    const leftDate = left.timeText || '';
    const rightDate = right.timeText || '';
    return leftDate.localeCompare(rightDate);
  });
}

function routeStops(general: JsonRecord, events: TrackingEventDetail[]) {
  const destination = text(general.PortOfDischarge) || text(general.ShippedTo);
  const candidates: Array<{ name: string; role: TrackingRouteStop['role'] }> = [
    { name: text(general.ShippedFrom), role: 'origin' },
    { name: text(general.PortOfLoad), role: 'loading' },
    ...array(general.Transshipments).map((value) => ({ name: text(value), role: 'transshipment' as const })),
    { name: text(general.PortOfDischarge), role: 'discharge' },
    { name: text(general.ShippedTo), role: 'delivery' },
  ];
  const stops: TrackingRouteStop[] = [];
  for (const candidate of candidates) {
    if (!candidate.name) continue;
    const previous = stops.at(-1);
    if (previous && normalizedLocation(previous.name) === normalizedLocation(candidate.name)) {
      if (candidate.role === 'loading' || candidate.role === 'discharge') previous.role = candidate.role;
      continue;
    }
    stops.push(candidate);
  }
  for (const event of events) {
    if (!event.location || stops.some((stop) => normalizedLocation(stop.name) === normalizedLocation(event.location!))) continue;
    stops.push({
      name: event.location,
      role: destination && sameLocation(event.location, destination)
        ? 'discharge'
        : stops.length ? 'transshipment' : 'loading',
    });
  }
  return stops;
}

function factsForResult(data: JsonRecord, bill: JsonRecord, container: JsonRecord, events: TrackingEventDetail[]) {
  const general = record(bill.GeneralTrackingInfo);
  const vesselFacts = new Map<string, string>();
  for (const rawEvent of array(container.Events).map(record)) {
    const details = array(rawEvent.Detail).map(text).filter(Boolean);
    if (details.length < 2 || /^(?:EMPTY|LADEN)$/i.test(details[0])) continue;
    const vessel = record(rawEvent.Vessel);
    const label = `${details[0]} / ${details[1]}`;
    const metadata = [text(vessel.IMO) && `IMO ${text(vessel.IMO)}`, text(vessel.FlagName) || text(vessel.Flag), text(vessel.Built) && `建造 ${text(vessel.Built)}`].filter(Boolean).join(' · ');
    vesselFacts.set(label, metadata || '官网未提供船舶扩展资料');
  }
  const pairs: Array<[string, string]> = [
    ['查询类型', text(data.TrackingType)],
    ['官网提单号', text(bill.BillOfLadingNumber)],
    ['官网柜号', text(container.ContainerNumber)],
    ['柜型', text(container.ContainerType)],
    ['最新地点', text(container.LatestMove)],
    ['柜状态', bool(container.Delivered) ? '已交付' : '运输中'],
    ['提单状态', bool(bill.Delivered) ? '已交付' : '运输中'],
    ['提单柜数', bill.NumberOfContainers === undefined ? '' : String(bill.NumberOfContainers)],
    ['起运地', text(general.ShippedFrom)],
    ['装货港', text(general.PortOfLoad)],
    ['转运港', array(general.Transshipments).map(text).filter(Boolean).join(' → ')],
    ['卸货港', text(general.PortOfDischarge)],
    ['目的地', text(general.ShippedTo)],
    ['最终 ETA', text(general.FinalPodEtaDate) || text(container.PodEtaDate)],
    ['价格计算日期', text(general.PriceCalculationDate)],
    ['官网结果生成时间', text(data.TrackingResultsLabel)],
    ['事件数量', String(events.length)],
    ...[...vesselFacts].map(([label, value]) => [`船舶 ${label}`, value] as [string, string]),
  ];
  return pairs.flatMap(([label, value]): TrackingFact[] => value ? [{ label, value }] : []);
}

function payloadFailure(payload: JsonRecord) {
  const message = text(payload.Message) || text(payload.ErrorMessage) || text(record(payload.Data).Message);
  if (/not found|no result|invalid|未找到|无记录/i.test(message)) return trackingError('订单号验证失败', `地中海官网未找到查询号码：${message}`);
  return trackingError('官网接口异常', `地中海官方追踪响应失败${message ? `：${message}` : ''}`);
}

export function parseMscTrackingPayload(payload: unknown, input: TrackingQuery, renderedText = ''): TrackingResult {
  const root = record(payload);
  if (!bool(root.IsSuccess)) throw payloadFailure(root);
  const data = record(root.Data);
  const bills = array(data.BillOfLadings).map(record);
  if (!bills.length) throw trackingError('订单号验证失败', '地中海官网没有返回提单或柜信息');

  const expectedBill = normalizedReference(input.queryBillNo || input.originalBillNo);
  const expectedContainer = normalizedReference(input.containerNo);
  const bill = input.queryType === 'container'
    ? bills.find((candidate) => array(candidate.ContainersInfo).map(record).some((container) => normalizedReference(text(container.ContainerNumber)) === expectedContainer))
    : bills.find((candidate) => normalizedReference(text(candidate.BillOfLadingNumber)) === expectedBill);
  if (!bill) {
    throw trackingError('订单号验证失败', `地中海官网返回结果与查询的${input.queryType === 'container' ? `柜号 ${input.containerNo}` : `提单号 ${input.queryBillNo}`}不一致`);
  }
  if (input.queryType === 'container' && expectedBill && normalizedReference(text(bill.BillOfLadingNumber)) !== expectedBill) {
    throw trackingError(
      '订单号验证失败',
      `地中海柜号 ${input.containerNo} 当前关联提单 ${text(bill.BillOfLadingNumber) || '空'}，与本条记录 ${input.queryBillNo} 不一致；该柜可能已进入后续周转，拒绝写入其他航次数据`,
    );
  }
  const containers = array(bill.ContainersInfo).map(record);
  const container = expectedContainer
    ? containers.find((candidate) => normalizedReference(text(candidate.ContainerNumber)) === expectedContainer)
    : containers[0];
  if (!container) {
    throw trackingError('订单号验证失败', input.queryType === 'bill'
      ? `地中海提单结果未包含输入柜号 ${input.containerNo}，将改用柜号查询核验`
      : `地中海柜号查询未返回 ${input.containerNo}`);
  }

  const general = record(bill.GeneralTrackingInfo);
  const events = structuredEvents(container);
  const destination = text(general.PortOfDischarge) || text(general.ShippedTo);
  const sameDestination = (event: TrackingEventDetail) => !destination || sameLocation(event.location, destination);
  // 有明确 POD 时，禁止用中转港卸船事件兜底填充最终卸船时间。
  // 只有响应没有提供 POD 的旧格式，才允许按事件本身判断。
  const finalDischarge = [...events].reverse().find((event) => event.actual && event.eventType === 'discharge' && sameDestination(event));
  const explicitArrival = [...events].reverse().find((event) => event.actual && event.eventType === 'arrival' && sameDestination(event));
  const estimatedArrival = officialDate(general.FinalPodEtaDate) || officialDate(container.PodEtaDate);
  const actualArrival = explicitArrival?.timeText || finalDischarge?.timeText || null;
  const delivered = bool(container.Delivered) || bool(bill.Delivered);
  if (!actualArrival && !estimatedArrival && !finalDischarge && !delivered) {
    throw trackingError('解析失败', '地中海官方响应已核验提单和柜号，但没有可验证的到港、预计到港或卸船后续事件');
  }
  const stops = routeStops(general, events);
  const routeText = stops.map((stop) => stop.name).join(' → ') || null;
  const facts = factsForResult(data, bill, container, events);
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  const currentPort = text(container.LatestMove) || [...events].reverse().find((event) => event.actual && event.location)?.location || null;
  const estimatedArrivalTimeText = estimatedArrival;
  return {
    arrivalTime: null,
    arrivalTimeText: actualArrival || estimatedArrival,
    arrivalKind: actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null,
    estimatedArrivalTimeText,
    arrived: Boolean(actualArrival || finalDischarge || delivered),
    discharged: Boolean(finalDischarge || delivered),
    dischargeTime: null,
    dischargeTimeText: finalDischarge?.timeText || null,
    rawSummary: `地中海官方追踪响应解析成功；查询号码=${queryValue}；关联提单=${text(bill.BillOfLadingNumber)}；柜号=${text(container.ContainerNumber)}；已解析 ${events.length} 条事件${finalDischarge ? `；目的港实际卸船=${text(array(container.Events).map(record).find((event) => text(event.Description) === finalDischarge.label)?.Date) || finalDischarge.timeText}` : delivered ? '；官网已标记交付，确认卸船完成但未提供精确卸船日期' : '；未发现实际卸船事件'}；官网事件只提供日期，未擅自换算时区`,
    sourceUrl: MSC_SOURCE,
    routeText,
    trackingDetail: {
      carrierCode: 'MSC',
      queryType: input.queryType,
      queryValue,
      capturedAt: new Date().toISOString(),
      routeStops: stops,
      events,
      currentPort,
      estimatedArrivalPort: destination || null,
      estimatedArrivalTimeText,
      facts,
    },
    rawPageText: [
      renderedText ? '===== 地中海成功结果页面可见文字 =====\n' + renderedText : '',
      '===== 地中海 TrackingInfo 官方响应 =====\n' + JSON.stringify(payload, null, 2),
    ].filter(Boolean).join('\n\n'),
  };
}
