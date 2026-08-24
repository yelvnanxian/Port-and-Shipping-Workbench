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
  // 运行线路展示港口/目的地，不把场站、堆场或码头名称当成新的港口节点。
  if (/(?:terminal|yard|depot|container\s+term(?:inal)?)/i.test(location)) return null;
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
  const label = [...labels, '装货港', '起运港', '起始地', '卸货港', '目的港', '目的地', '收货地', '提货地', '地点'].join('|');
  const expression = new RegExp(`(?:^|\\b)(?:${label})\\s*(?:[:：|→-])\\s*([^|→\\n]+)`, 'i');
  for (const line of lines) {
    const matched = line.match(expression)?.[1];
    if (matched) appendUnique(locations, matched);
  }
  return locations;
}

function valuesAfterLabels(lines: string[], labelPattern: RegExp) {
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanLocation(lines[index]);
    const inline = line.match(new RegExp(`${labelPattern.source}\\s*[:：|→-]\\s*(.+)$`, labelPattern.flags))?.[1];
    if (inline) {
      appendUnique(values, inline);
      continue;
    }
    if (!labelPattern.test(line)) continue;
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) {
      const candidate = validLocation(lines[index + offset]);
      if (candidate) {
        appendUnique(values, candidate);
        break;
      }
    }
  }
  return values;
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
  // ONE 的结果表顶部先显示“当前地点”，其后才按运输顺序渲染完整时间线。
  // 若扫描整个页面，会把当前地点放到线路最前面，还可能把页面底部隐私文案
  // 误判为地点。只读取 Show Latest Event 后面的时间线地点，再用收货地补尾点。
  const locations: string[] = [];
  const timelineStart = input.lines.findIndex((line) => /^show latest event$/i.test(cleanLocation(line)));
  const timelineEnd = input.lines.findIndex((line, index) => index > timelineStart
    && /^(?:customize columns|feedback|ONE Cookie Preferences|Copyright)|^This website saves cookies/i.test(cleanLocation(line)));
  if (timelineStart >= 0) {
    candidateLocations(
      input.lines.slice(timelineStart + 1, timelineEnd >= 0 ? timelineEnd : input.lines.length),
      locations,
    );
  }
  for (const value of valuesAfterLabels(input.lines, /^place\s+of\s+receipt$/i)) {
    const existing = [...locations];
    locations.length = 0;
    appendUnique(locations, value);
    existing.forEach((location) => appendUnique(locations, location));
  }
  for (const value of valuesAfterLabels(input.lines, /^place\s+of\s+delivery$/i)) appendUnique(locations, value);
  if (locations.length >= 2) return locations.join(' → ');
  return parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location']);
}

function parseMaersk(input: RouteParserInput) {
  return parseByLabels(input, ['from', 'port of loading', 'to', 'destination', 'port of discharge', 'location']);
}

function parseMsc(input: RouteParserInput) {
  // MSC 结果页把转运港单独放在路线摘要中，通用候选地点会按页面
  // 出现顺序把目的港排在转运港之前。按官网字段顺序重建：起运地 →
  // 所有转运港 → 目的港/收货地；未识别到至少两个官方地点时再走通用解析。
  const headerEnd = input.lines.findIndex((line) => /^containers?$/i.test(cleanLocation(line)));
  const headerLines = headerEnd >= 0 ? input.lines.slice(0, headerEnd) : input.lines;
  const locations: string[] = [];
  for (const value of valuesAfterLabels(headerLines, /shipped\s+from/i)) appendUnique(locations, value);
  for (const value of valuesAfterLabels(headerLines, /transshipment/i)) appendUnique(locations, value);
  for (const value of valuesAfterLabels(headerLines, /port\s+of\s+discharge|shipped\s+to/i)) appendUnique(locations, value);
  return locations.length >= 2 ? locations.join(' → ') : parseByLabels(input, ['place of receipt', 'port of loading', 'port of discharge', 'place of delivery', 'location']);
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
