import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core';
import { classifyTrackingError, trackingError } from './errors.js';
import { parseMaerskTrackingText } from './maersk.js';
import { parseOoclDate } from './oocl.js';
import { probeUrl } from './official-probe.js';
import type { TrackingProvider } from './tracker.js';
import type { ArrivalKind, TrackingQuery, TrackingResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 20_000;
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// User-Agent 池 - 用于反检测轮换
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// 反检测启动参数
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--window-size=1920,1080',
];

// 反检测初始化脚本 - 隐藏 webdriver 特征
const STEALTH_INIT_SCRIPT = `
  // 隐藏 webdriver 标记
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  });

  // 伪装 chrome 对象
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // 伪装 plugins（headless 模式默认为空数组）
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ]
  });

  // 伪装 languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en']
  });

  // 伪装 Permissions API
  if (window.navigator.permissions) {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
        : originalQuery(parameters)
    );
  }

  // 隐藏 CDP 特征
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
`;

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * 随机延迟 - 模拟真人操作
 */
async function humanDelay(min = 500, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 模拟真人打字 - 逐字符输入，带随机间隔
 */
async function humanType(locator: Locator, text: string) {
  await locator.click({ timeout: 5_000 }).catch(() => undefined);
  await humanDelay(200, 500);
  // Cookie 会话可能保留上一次查询值；先清空，避免把新号码追加到旧号码后面。
  await locator.fill('');
  // 使用 pressSequentially 逐字符输入，模拟真人打字节奏
  await locator.pressSequentially(text, {
    delay: 50 + Math.random() * 100
  });
}

const INPUT_SELECTORS = [
  'input[type="search"]',
  'input[name*="track" i]',
  'input[id*="track" i]',
  'input[name*="bill" i]',
  'input[id*="bill" i]',
  'input[name*="container" i]',
  'input[id*="container" i]',
  'input[placeholder*="提单"]',
  'input[placeholder*="柜号"]',
  'input[placeholder*="container" i]',
  'input[placeholder*="tracking" i]',
];

const DATE_PATTERNS = [
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
  /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
];

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractDate(source: string) {
  for (const pattern of DATE_PATTERNS) {
    const matched = source.match(pattern)?.[0];
    if (!matched) continue;
    const monthFirst = matched.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(.*)$/);
    const normalized = monthFirst ? `${monthFirst[2]} ${monthFirst[1]} ${monthFirst[3]}${monthFirst[4]}` : matched;
    const parsed = parseOoclDate(normalized);
    if (parsed) return parsed;
  }
  return null;
}

function findLabeledDate(lines: string[], label: RegExp, excluded?: RegExp, preferLast = false) {
  const indexes = Array.from({ length: lines.length }, (_, index) => index);
  if (preferLast) indexes.reverse();
  for (const index of indexes) {
    if (!label.test(lines[index])) continue;
    const contexts = [
      lines.slice(index, index + 3).join(' '),
      lines.slice(Math.max(0, index - 3), index + 1).join(' '),
    ];
    for (const context of contexts) {
      if (excluded?.test(context)) continue;
      const parsed = extractDate(context);
      if (parsed) return parsed;
    }
  }
  return null;
}

function findLabeledDateText(lines: string[], label: RegExp, excluded?: RegExp, preferLast = false) {
  const indexes = Array.from({ length: lines.length }, (_, index) => index);
  if (preferLast) indexes.reverse();
  for (const index of indexes) {
    if (!label.test(lines[index])) continue;
    const contexts = [
      lines.slice(index, index + 3).join(' '),
      lines.slice(Math.max(0, index - 3), index + 1).join(' '),
    ];
    for (const context of contexts) {
      if (excluded?.test(context)) continue;
      for (const pattern of DATE_PATTERNS) {
        const matched = context.match(pattern)?.[0];
        if (!matched) continue;
        const suffix = context.slice(context.indexOf(matched) + matched.length).match(/^\s+([A-Z]{2,5})\b/)?.[1];
        return `${matched}${suffix ? ` ${suffix}` : ''}`;
      }
    }
  }
  return null;
}

export function parseRenderedTrackingText(text: string, input: TrackingQuery): TrackingResult {
  const compactText = text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const queryValue = input.queryType === 'container' ? input.containerNo : input.queryBillNo;
  if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|enable javascript and cookies/i.test(compactText)) {
    throw trackingError('验证码或风控', `${input.rule.name}浏览器页面仍要求安全验证或被风控拦截`);
  }
  if (/no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(compactText)) {
    throw trackingError('订单号验证失败', `${input.rule.name}浏览器查询未找到 ${queryValue}`);
  }
  if (/\b(?:4|5)\d{2}\s+(?:bad gateway|service unavailable|internal server error|gateway timeout)/i.test(compactText)) {
    throw trackingError('官网接口异常', `${input.rule.name}浏览器页面返回网关或服务器异常`);
  }
  const references = [queryValue, input.originalBillNo, input.containerNo].filter(Boolean).map(normalizedReference);
  const normalizedText = normalizedReference(compactText);
  if (!references.some((reference) => reference && normalizedText.includes(reference))) {
    throw trackingError('解析失败', `${input.rule.name}浏览器页面未显示对应的提单号或柜号，拒绝写入无法核验的数据`);
  }

  const lines = compactText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferDestinationEvent = input.rule.code === 'COSCO';
  const actualArrival = findLabeledDate(lines, /\bATA\b|actual(?: time of)? arrival|actual arrival|实际到港|实际抵达/i, /estimated|expected|预计/i, preferDestinationEvent);
  const estimatedArrival = findLabeledDate(lines, /\bETA\b|estimated(?: time of)? arrival|expected arrival|预计到港|预计抵达/i, undefined, preferDestinationEvent);
  const discharge = findLabeledDate(lines, /actual[^\n]{0,30}discharg|container discharged|discharged|discharge completed|卸船完成|实际卸船|卸载完成|卸船时间/i, /estimated|expected|planned|预计|计划/i);
  const arrivalTime = actualArrival || estimatedArrival;
  if (!arrivalTime && !discharge) {
    throw trackingError('解析失败', `${input.rule.name}浏览器已打开订单结果，但没有发现可验证的 ATA、ETA 或实际卸船时间`);
  }
  const arrivalKind: ArrivalKind = actualArrival ? 'ATA' : estimatedArrival ? 'ETA' : null;
  const preserveLocalTime = input.rule.code === 'COSCO';
  const arrivalTimeText = preserveLocalTime
    ? findLabeledDateText(
      lines,
      actualArrival ? /\bATA\b|actual(?: time of)? arrival|actual arrival|实际到港|实际抵达/i : /\bETA\b|estimated(?: time of)? arrival|expected arrival|预计到港|预计抵达/i,
      actualArrival ? /estimated|expected|预计/i : undefined,
      true,
    )
    : null;
  const dischargeTimeText = preserveLocalTime && discharge
    ? findLabeledDateText(lines, /actual[^\n]{0,30}discharg|container discharged|discharged|discharge completed|卸船完成|实际卸船|卸载完成|卸船时间/i, /estimated|expected|planned|预计|计划/i)
    : null;
  return {
    arrivalTime: arrivalTimeText ? null : arrivalTime,
    arrivalTimeText: arrivalTimeText ? `${arrivalTimeText}（官网当地时间）` : undefined,
    arrivalKind,
    arrived: Boolean(actualArrival || discharge),
    dischargeTime: dischargeTimeText ? null : discharge,
    dischargeTimeText: dischargeTimeText ? `${dischargeTimeText}（官网当地时间）` : undefined,
    rawSummary: `${input.rule.name}浏览器模拟查询成功；页面已核对${input.queryType === 'container' ? '柜号' : '提单号'}=${queryValue}${discharge ? '；已发现实际卸船字段' : ''}${preserveLocalTime ? '；官网时间按港口当地时间原样保留' : ''}`,
    sourceUrl: input.rule.url,
  };
}

export async function browserExecutablePath() {
  const configured = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (configured) {
    await fs.access(configured);
    return configured;
  }
  for (const candidate of CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* 尝试下一个系统浏览器 */ }
  }
  throw trackingError('官网接口异常', '未找到可用的 Chrome/Edge 浏览器，请安装 Chrome 或配置 BROWSER_EXECUTABLE_PATH');
}

async function firstVisibleInput(page: Page) {
  for (const frame of page.frames()) {
    for (const selector of INPUT_SELECTORS) {
      const locator = frame.locator(selector);
      for (let index = 0; index < await locator.count(); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) return candidate;
      }
    }
  }
  return null;
}

async function renderedPageText(page: Page) {
  const texts = await Promise.all(page.frames().map((frame) => frame.locator('body').innerText().catch(() => '')));
  return texts.filter(Boolean).join('\n');
}

async function clickCookieButton(frame: Frame) {
  const label = /accept all(?: cookies?)?|allow all|同意全部|全部接受|接受所有(?:\s*Cookie)?|允许全部/i;
  const candidates = [
    frame.locator('#onetrust-accept-btn-handler'),
    frame.locator('button, a, [role="button"]').filter({ hasText: label }),
  ];
  for (const group of candidates) {
    for (let index = 0; index < await group.count(); index += 1) {
      const button = group.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      const clicked = await button.click({ force: true, timeout: 3_000 }).then(() => true).catch(async () => {
        return button.evaluate((element) => {
          if (!(element instanceof HTMLElement)) return false;
          element.click();
          return true;
        }).catch(() => false);
      });
      if (clicked) return true;
    }
  }
  return false;
}

async function dismissCookieDialog(page: Page, waitMs = 0) {
  if (waitMs > 0) {
    await Promise.race(page.frames().map((frame) => frame.locator('#onetrust-accept-btn-handler').waitFor({ state: 'visible', timeout: waitMs }))).catch(() => undefined);
  }
  for (const frame of page.frames()) {
    if (!await clickCookieButton(frame)) continue;
    await page.locator('#onetrust-consent-sdk').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function submitTrackingQuery(inputElement: Locator) {
  const form = inputElement.locator('xpath=ancestor::form[1]');
  if (await form.count()) {
    const submit = form.locator('button[type="submit"], input[type="submit"], button').filter({ hasText: /track|search|submit|查询|追踪/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click({ timeout: 5_000 });
      return;
    }
  }
  const nearbyButtons = inputElement.locator('xpath=..').locator('button, [role="button"], input[type="submit"]');
  for (let index = await nearbyButtons.count() - 1; index >= 0; index -= 1) {
    const button = nearbyButtons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click({ timeout: 5_000 });
    return;
  }
  await inputElement.press('Enter');
}

async function waitForRenderedOutcome(page: Page, queryValue: string, timeout = RESULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  do {
    const text = await renderedPageText(page);
    if (/cloudflare|verify you are human|security check|attention required|access denied|captcha|验证码|安全验证|被阻止|no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在|bad gateway|service unavailable|internal server error|gateway timeout/i.test(text)) return;
    if (normalizedReference(text).includes(normalizedReference(queryValue))
      && /\bATA\b|\bETA\b|actual(?: time of)? arrival|estimated(?: time of)? arrival|expected arrival|实际到港|预计到港|实际抵达|预计抵达|discharg|卸船|卸载完成/i.test(text)) return;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
}

export class BrowserTrackingProvider implements TrackingProvider {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();
  private queue: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;

  constructor(
    private readonly evidenceDirectory: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const pending = this.queue.then(() => this.execute(input));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async getBrowser() {
    if (!this.browser) {
      // 允许通过环境变量控制是否使用有头模式（有头模式反检测效果更好）
      const headless = process.env.BROWSER_HEADLESS !== 'false';
      this.browser = await chromium.launch({
        headless,
        executablePath: await browserExecutablePath(),
        args: STEALTH_ARGS,
        // 忽略 HTTPS 证书错误（某些船司使用自签证书）
        ignoreDefaultArgs: ['--enable-automation'],
      });
    }
    return this.browser;
  }

  private async saveEvidence(page: Page, input: TrackingQuery, outcome: 'success' | 'failure') {
    await fs.mkdir(this.evidenceDirectory, { recursive: true });
    const reference = normalizedReference(input.queryType === 'container' ? input.containerNo : input.originalBillNo).slice(0, 32) || 'UNKNOWN';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${input.rule.code}_${reference}_${outcome}.png`;
    try {
      await page.screenshot({ path: path.join(this.evidenceDirectory, fileName), fullPage: true });
      return `/api/browser-evidence/${encodeURIComponent(fileName)}`;
    } catch {
      return undefined;
    }
  }

  private statePath(input: TrackingQuery) {
    return path.join(path.dirname(this.evidenceDirectory), 'browser-state', `${input.rule.code}.json`);
  }

  private async getContext(browser: Browser, input: TrackingQuery): Promise<BrowserContext> {
    const existing = this.contexts.get(input.rule.code);
    if (existing) return existing;
    const statePath = this.statePath(input);
    let storageState: string | undefined;
    try {
      await fs.access(statePath);
      storageState = statePath;
    } catch { /* 首次访问还没有 Cookie 状态 */ }

    // 每个船司使用不同的 User-Agent，进一步降低指纹相似度
    const userAgent = getRandomUserAgent();

    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1920, height: 1080 },
      userAgent,
      // 额外的真实浏览器请求头
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      // 忽略 HTTPS 错误
      ignoreHTTPSErrors: true,
      ...(storageState ? { storageState } : {}),
    });

    // 注入反检测脚本 - 所有页面加载时执行
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    this.contexts.set(input.rule.code, context);
    return context;
  }

  private async saveState(context: BrowserContext, input: TrackingQuery) {
    const statePath = this.statePath(input);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `${input.rule.name}${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const browser = await this.getBrowser();
    const context = await this.getContext(browser, input);
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    let sourceUrl = input.rule.url;
    let navigationWarning = '';
    try {
      try {
        await page.goto(probeUrl(input).toString(), { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      } catch (error) {
        if (error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`)) navigationWarning = '页面导航超时后继续检查已加载内容';
        else throw error;
      }
      sourceUrl = page.url();
      const cookies = await context.cookies(sourceUrl);
      let acceptedCookies = await dismissCookieDialog(page);
      await waitForRenderedOutcome(page, queryValue, input.rule.code === 'COSCO' ? 8_000 : 1_500);
      if (!acceptedCookies) acceptedCookies = await dismissCookieDialog(page);
      if (!acceptedCookies && input.rule.code === 'COSCO' && !cookies.some((cookie) => cookie.name === 'cookieClause')) {
        acceptedCookies = await dismissCookieDialog(page, 2_000);
      }
      if (acceptedCookies) await this.saveState(context, input);
      const initialText = await renderedPageText(page);
      if (!normalizedReference(initialText).includes(normalizedReference(queryValue))) {
        const inputElement = await firstVisibleInput(page);
        if (inputElement) {
          // 真人行为模拟：环境变量控制是否启用
          const humanBehavior = process.env.BROWSER_HUMAN_BEHAVIOR !== 'false';
          if (humanBehavior) {
            await humanDelay(300, 800);       // 查看页面
            await humanType(inputElement, queryValue);  // 模拟打字
            await humanDelay(500, 1200);      // 思考时间
          } else {
            await inputElement.fill(queryValue);
          }
          await submitTrackingQuery(inputElement);
        }
      }
      await waitForRenderedOutcome(page, queryValue, Math.min(this.timeoutMs, RESULT_TIMEOUT_MS));
      sourceUrl = page.url();
      const renderedText = await renderedPageText(page);
      const result = input.rule.code === 'MAERSK'
        ? parseMaerskTrackingText(renderedText, input)
        : parseRenderedTrackingText(renderedText, input);
      const evidencePath = await this.saveEvidence(page, input, 'success');
      return { ...result, sourceUrl, evidencePath };
    } catch (error) {
      const failure = classifyTrackingError(error);
      sourceUrl = page.url() || sourceUrl;
      const evidencePath = await this.saveEvidence(page, input, 'failure');
      throw trackingError(failure.category, `${failure.reason}${navigationWarning ? `；${navigationWarning}` : ''}`, { evidencePath, sourceUrl });
    } finally {
      await this.saveState(context, input).catch(() => undefined);
      await page.close();
    }
  }

  async close() {
    if (!this.closing) {
      this.closing = (async () => {
        await this.queue;
        this.contexts.clear();
        const browser = this.browser;
        this.browser = null;
        await browser?.close();
      })();
    }
    await this.closing;
  }
}

export class FallbackTrackingProvider implements TrackingProvider {
  constructor(
    private readonly primary: TrackingProvider,
    private readonly fallback: TrackingProvider,
  ) {}

  async query(input: TrackingQuery) {
    try {
      return await this.primary.query(input);
    } catch (primaryError) {
      try {
        return await this.fallback.query(input);
      } catch (fallbackError) {
        const primaryFailure = classifyTrackingError(primaryError);
        const fallbackFailure = classifyTrackingError(fallbackError);
        throw trackingError(
          fallbackFailure.category,
          `${fallbackFailure.reason}；直连结果=${primaryFailure.category}：${primaryFailure.reason}`,
          { evidencePath: fallbackFailure.evidencePath, sourceUrl: fallbackFailure.sourceUrl },
        );
      }
    }
  }

  async close() {
    await Promise.all([this.primary.close?.(), this.fallback.close?.()]);
  }
}
