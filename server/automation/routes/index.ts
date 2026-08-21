/**
 * 船司官网路线解析器。
 *
 * 每家船司的页面字段名称和节点顺序不同，因此这里保留独立解析入口，
 * 统一输出“地点 A → 地点 B → 地点 C”。解析失败时由 browser.ts 的
 * 通用候选地点解析兜底，但不会凭日期或状态文本猜测路线。
 */

export interface RouteParserInput {
  carrierCode: string;
  text: string;
  lines: string[];
}

type RouteParser = (input: RouteParserInput) => string | null;

const LOCATION = /^[A-Z][A-Z0-9 ./'()&-]{2,}(?:,\s*[A-Z][A-Z0-9 ./'()&-]{1,}){1,3}$/i;
const CHINESE_LOCATION = /^[\u4e00-\u9fff]{2,}(?:[，,][\u4e00-\u9fffA-Za-z0-9 ./'()&-]{2,}){1,3}$/;
const BAD_LOCATION = /^(?:eta|ata|event|status|details?|track(?:ing)?|container|booking|bill|date|time|actual|estimated|planned|scheduled|vessel|voyage|port of|place of|arrival|departure|discharge|unload|loaded|on vessel|transit|current|origin|destination|location|from|to)\b/i;

function cleanLocation(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/^[-–—:|]+|[-–—:|]+$/g, '')
    .replace(/\s+\((?:actual|estimated|planned|scheduled)[^)]*\)$/i, '')
    .trim();
}

function validLocation(value: string) {
  const location = cleanLocation(value);
  if (!location || location.length < 3 || location.length > 120 || BAD_LOCATION.test(location)) return null;
  if (/\d{2,}/.test(location) && !/[A-Z]{2,}\s*\d/.test(location)) return null;
  return LOCATION.test(location) || CHINESE_LOCATION.test(location) ? location : null;
}

function appendUnique(target: string[], value: string) {
  const location = validLocation(value);
  if (!location) return;
  const key = location.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
  if (!target.some((item) => item.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '') === key)) target.push(location);
}

function labeledLocations(lines: string[], labels: string[]) {
  const locations: string[] = [];
  const label = [...labels, '装货港', '起运港', '卸货港', '目的港', '目的地', '收货地', '提货地', '地点'].join('|');
  const expression = new RegExp(`(?:^|\\b)(?:${label})\\s*(?:[:：|→-])\\s*([^|→\\n]+)`, 'i');
  for (const line of lines) {
    const matched = line.match(expression)?.[1];
    if (matched) appendUnique(locations, matched);
  }
  return locations;
}

function candidateLocations(lines: string[], target: string[]) {
  for (const rawLine of lines) {
    const line = cleanLocation(rawLine);
    if (line.includes('→') || line.includes('->')) {
      for (const part of line.split(/→|->/)) appendUnique(target, part);
      continue;
    }
    appendUnique(target, line);
  }
}

function parseByLabels(input: RouteParserInput, labels: string[]) {
  const locations = labeledLocations(input.lines, labels);
  candidateLocations(input.lines, locations);
  return locations.length >= 2 ? locations.join(' → ') : null;
}

function parseOne(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'vessel departure', 'port of discharge', 'port of discharging', 'place of delivery', 'location']);
}

function parseMaersk(input: RouteParserInput) {
  return parseByLabels(input, ['from', 'port of loading', 'to', 'destination', 'port of discharge', 'location']);
}

function parseMsc(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location']);
}

function parseEvergreen(input: RouteParserInput) {
  return parseByLabels(input, ['receipt', 'loading port', 'port of loading', 'discharge port', 'port of discharge', 'delivery', 'location']);
}

function parseOocl(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'origin', 'destination', 'location']);
}

function parseWanhai(input: RouteParserInput) {
  return parseByLabels(input, ['receipt', 'loading', 'port of loading', 'discharge', 'port of discharge', 'delivery', 'location']);
}

function parseZim(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location', 'from', 'to']);
}

function parseMatson(input: RouteParserInput) {
  return parseByLabels(input, ['origin', 'load port', 'port of loading', 'discharge port', 'port of discharge', 'destination', 'location']);
}

function parseYangming(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'origin', 'destination', 'location']);
}

function parseSmLine(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location', 'from', 'to']);
}

function parseCma(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'origin', 'destination', 'location']);
}

function parseCosco(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'origin', 'destination', 'location']);
}

function parseHapag(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location', 'from', 'to']);
}

function parseHede(input: RouteParserInput) {
  return parseByLabels(input, ['loading port', 'discharge port', 'port of loading', 'port of discharge', 'origin', 'destination', 'location']);
}

function parseHmm(input: RouteParserInput) {
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location', 'from', 'to']);
}

const PARSERS: Record<string, RouteParser> = {
  ONE: parseOne,
  MAERSK: parseMaersk,
  MSC: parseMsc,
  EVERGREEN: parseEvergreen,
  OOCL: parseOocl,
  WANHAI: parseWanhai,
  ZIM: parseZim,
  MATSON: parseMatson,
  YANGMING: parseYangming,
  SMLINE: parseSmLine,
  CMA: parseCma,
  COSCO: parseCosco,
  HAPAG: parseHapag,
  HEDE: parseHede,
  HMM: parseHmm,
};

export function parseCarrierRoute(input: RouteParserInput) {
  return PARSERS[input.carrierCode.toUpperCase()]?.(input) || null;
}

export const carrierRouteParsers = PARSERS;
