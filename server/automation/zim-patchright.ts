import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page, type Response } from 'patchright';
import { browserExecutablePath, type BrowserVerificationCallbacks } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { saveEvidenceScreenshot } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';
import { parseZimTrackingText } from './zim.js';

const ZIM_TRACKING = 'https://www.zimchina.com/tools/track-a-shipment';
const DEFAULT_TIMEOUT_MS = 180_000;

let sharedContext: BrowserContext | null = null;
let sharedProfile = '';
let sharedLaunch: Promise<BrowserContext> | null = null;

/** 仅在服务退出时关闭，任务之间继续复用已通过验证的持久会话。 */
export async function shutdownZimPatchright() {
  const launch = sharedLaunch;
  if (launch) await launch.catch(() => undefined);
  const context = sharedContext;
  if (context) {
    resetContext(context);
    await context.close().catch(() => undefined);
  }
}

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function challengeText(value: string) {
  return /cloudflare|verify you are human|security check|attention required|access denied|captcha|challenge platform|验证码|安全验证|拖拽|滑块/i.test(value);
}

function noResultText(value: string) {
  return /no result|not found|no shipment|invalid (?:booking|bill|cargo|tracking)|未找到|查无|无记录|不存在/i.test(value);
}

async function pageText(page: Page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const inputs = await page.locator('input:not([type="hidden"])').evaluateAll((elements) => elements
    .map((element) => (element as HTMLInputElement).value)
    .filter(Boolean)
    .join('\n')).catch(() => '');
  return [body, inputs].filter(Boolean).join('\n');
}

function hasResult(text: string, input: TrackingQuery) {
  const expected = normalizedReference(input.queryType === 'container' ? input.containerNo : input.queryBillNo);
  const normalized = normalizedReference(text);
  if (!expected || !normalized.includes(expected)) return false;
  if (input.containerNo && !normalized.includes(normalizedReference(input.containerNo))) return false;
  return /Current ETA|Original ETA|Routing Details|Last Activity|Port of Loading|Port of Discharge/i.test(text)
    && /\b\d{1,2}-[A-Za-z]{3,9}-\d{4}\b/.test(text);
}

async function visibleCaptcha(page: Page) {
  const candidates = page.locator('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [id*="challenge" i], [class*="challenge" i]');
  for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function preventMapScroll(page: Page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    const target = window as Window & { __portOpsZimScrollPatched?: boolean };
    if (target.__portOpsZimScrollPatched) return;
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    document.addEventListener('wheel', (event) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[class*="map" i], canvas.maplibregl-canvas')) event.preventDefault();
    }, { capture: true, passive: false });
    target.__portOpsZimScrollPatched = true;
  }).catch(() => undefined);
}

async function dismissCookies(page: Page) {
  const buttons = page.locator('button, [role="button"], a').filter({ hasText: /^(?:I Agree|Accept|接受|同意)$/i });
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

const ZIM_QUERY_INPUT_SELECTORS = [
  'input[name="consnumber"]',
  'input[id*="consnumber" i]',
  'input[name*="tracking" i]',
  'input[id*="tracking" i]',
  'input[placeholder*="tracking" i]',
  'input[placeholder*="shipment" i]',
  'input[placeholder*="提单" i]',
  'input[placeholder*="柜号" i]',
];

async function firstVisibleEditable(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    for (let index = 0; index < Math.min(await candidates.count(), 10); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function clickSearchAgain(page: Page) {
  const actions = page.locator('button, a, [role="button"]');
  const pattern = /track another|new search|search again|查询其他|重新查询|继续查询/i;
  for (let index = 0; index < Math.min(await actions.count(), 80); index += 1) {
    const action = actions.nth(index);
    if (!await action.isVisible().catch(() => false)) continue;
    const text = await action.innerText().catch(() => '');
    if (!pattern.test(text)) continue;
    await action.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function submitSearch(page: Page, input: Locator) {
  const form = input.locator('xpath=ancestor::form[1]');
  const actions = await form.count().then((count) => count
    ? form.locator('button, input[type="submit"], [role="button"]')
    : page.locator('button, input[type="submit"], [role="button"]'));
  const pattern = /track|search|查询|追踪|提交/i;
  for (let index = 0; index < Math.min(await actions.count(), 100); index += 1) {
    const action = actions.nth(index);
    if (!await action.isVisible().catch(() => false)) continue;
    const text = `${await action.innerText().catch(() => '')} ${await action.getAttribute('value').catch(() => '')}`;
    if (!pattern.test(text)) continue;
    await action.click({ timeout: 10_000 }).catch(() => undefined);
    return true;
  }
  await input.press('Enter').catch(() => undefined);
  return false;
}

/**
 * 尝试在现有以星页面内重新发起查询。
 * 页面结构变化或结果页没有“重新查询”入口时返回 false，由调用方使用
 * 官方查询 URL 兜底；这样不会因为猜错控件而把未经核验的数据写入工作表。
 */
async function reuseSearchPage(page: Page, queryValue: string) {
  let input = await firstVisibleEditable(page, ZIM_QUERY_INPUT_SELECTORS);
  if (!input) {
    await clickSearchAgain(page);
    input = await firstVisibleEditable(page, ZIM_QUERY_INPUT_SELECTORS);
  }
  if (!input) return false;
  await input.fill('');
  await input.fill(queryValue);
  await submitSearch(page, input);
  await page.waitForTimeout(500);
  return true;
}

function resetContext(context: BrowserContext) {
  if (sharedContext !== context) return;
  sharedContext = null;
  sharedProfile = '';
}

async function zimContext(dataDirectory: string) {
  const profile = path.resolve(
    process.env.ZIM_PATCHRIGHT_PROFILE_DIR?.trim() || path.join(dataDirectory, 'browser-profile', 'ZIM_PATCHRIGHT'),
  );
  if (sharedContext && sharedProfile === profile) {
    try {
      await sharedContext.pages();
      return sharedContext;
    } catch {
      resetContext(sharedContext);
    }
  }
  if (sharedLaunch) return sharedLaunch;
  sharedLaunch = (async () => {
    await fs.mkdir(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      headless: process.env.BROWSER_HEADLESS !== 'false',
      executablePath: await browserExecutablePath(),
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: null,
      ignoreHTTPSErrors: true,
    });
    sharedContext = context;
    sharedProfile = profile;
    context.once('close', () => resetContext(context));
    return context;
  })();
  try {
    return await sharedLaunch;
  } finally {
    sharedLaunch = null;
  }
}

async function waitForResult(page: Page, input: TrackingQuery, callbacks: BrowserVerificationCallbacks | undefined, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', '以星查询页面已关闭');
    if (callbacks?.shouldSkip?.()) throw trackingError('验证码或风控', '以星当前记录已按用户指令跳过人工验证');
    await preventMapScroll(page);
    const text = await pageText(page);
    if (noResultText(text)) throw trackingError('订单号验证失败', `以星官网未找到${input.queryType === 'container' ? '柜号' : '提单号'}查询结果`);
    if (hasResult(text, input)) {
      callbacks?.onResolved?.();
      return text;
    }
    const challenged = challengeText(text) || await visibleCaptcha(page);
    if (challenged && !notified) {
      if (process.env.BROWSER_HEADLESS !== 'false' || process.env.BROWSER_HUMAN_VERIFY === 'false') {
        throw trackingError('验证码或风控', '以星需要人工完成安全验证，请启用有界面浏览器后重试');
      }
      callbacks?.onRequired?.({
        carrier: input.rule.name,
        carrierCode: input.rule.code,
        billNo: input.originalBillNo,
        containerNo: input.containerNo,
        sourceUrl: page.url() || ZIM_TRACKING,
      });
      notified = true;
    }
    await page.waitForTimeout(1_000);
  }
  throw trackingError('查询超时', '以星安全验证或查询结果等待超时，未写入未经核验的数据');
}

async function findExistingResult(context: BrowserContext, input: TrackingQuery) {
  for (const page of context.pages()) {
    if (!/zimchina\.com/i.test(page.url())) continue;
    const text = await pageText(page);
    if (hasResult(text, input)) return { page, text };
  }
  return null;
}

export class ZimPatchrightTrackingProvider implements TrackingProvider {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly callbacks?: BrowserVerificationCallbacks,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const pending = this.queue.then(() => this.execute(input));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async saveEvidence(page: Page, input: TrackingQuery, outcome: 'success' | 'failure') {
    const reference = `${input.originalBillNo}_${input.containerNo}`;
    return saveEvidenceScreenshot(page, this.dataDirectory, 'ZIM', reference, `patchright-${outcome}`);
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'ZIM') throw trackingError('解析失败', `以星 Patchright Provider 不能查询 ${input.rule.name}`);
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `以星${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const context = await zimContext(this.dataDirectory);
    const existing = await findExistingResult(context, input);
    if (existing) {
      await preventMapScroll(existing.page);
      const result = parseZimTrackingText(existing.text, input);
      const evidencePath = await this.saveEvidence(existing.page, input, 'success');
      return { ...result, evidencePath, sourceUrl: existing.page.url(), rawPageText: existing.text };
    }

    let activePage: Page | null = null;
    const apiBodies: Array<{ url: string; body: string }> = [];
    const responseListener = async (response: Response) => {
      if (response.status() !== 200 || !/zimchina\.com/i.test(response.url())) return;
      const contentType = response.headers()['content-type'] || '';
      if (!/json/i.test(contentType)) return;
      const body = await response.text().catch(() => '');
      if (body && body.length <= 2 * 1024 * 1024) apiBodies.push({ url: response.url(), body });
    };
    context.on('response', responseListener);
    try {
      activePage = context.pages().find((page) => /zimchina\.com/i.test(page.url())) || await context.newPage();
      const url = new URL(ZIM_TRACKING);
      url.searchParams.set('consnumber', queryValue);
      const reusedSearchPage = await reuseSearchPage(activePage, queryValue);
      if (!reusedSearchPage) {
        await activePage.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } else {
        await activePage.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => undefined);
      }
      await preventMapScroll(activePage);
      await dismissCookies(activePage);
      const text = await waitForResult(activePage, input, this.callbacks, this.timeoutMs);
      // 结果摘要、地图和柜动态分批渲染；稳定等待后再读取、截图。
      await activePage.waitForTimeout(2_000);
      await preventMapScroll(activePage);
      await dismissCookies(activePage);
      const finalText = await pageText(activePage) || text;
      const rawPageText = apiBodies.length
        ? `${finalText}\n\n${apiBodies.map((item) => `[ZIM API ${item.url}]\n${item.body}`).join('\n\n')}`
        : finalText;
      const result = parseZimTrackingText(rawPageText, input);
      const evidencePath = await this.saveEvidence(activePage, input, 'success');
      return { ...result, evidencePath, sourceUrl: activePage.url(), rawPageText };
    } catch (error) {
      const failure = classifyTrackingError(error);
      const evidencePath = activePage ? await this.saveEvidence(activePage, input, 'failure') : undefined;
      throw trackingError(failure.category, failure.reason, { evidencePath, sourceUrl: activePage?.url() || ZIM_TRACKING });
    } finally {
      context.off('response', responseListener);
    }
  }

  async close() {
    await this.queue;
    // 保留会话和当前页面，避免下一次查询重新触发验证或地图初始化。
  }
}
