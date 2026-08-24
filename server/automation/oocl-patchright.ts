import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'patchright';
import { browserExecutablePath, type BrowserVerificationCallbacks } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { parseOoclControlTowerText } from './oocl.js';
import { sourceEvidenceDirectory, sourceEvidenceUrl } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const OOCL_HOME = 'https://www.oocl.com/schi/Pages/default.aspx';
const DEFAULT_TIMEOUT_MS = 180_000;

let sharedContext: BrowserContext | null = null;
let sharedProfile = '';
let sharedLaunch: Promise<BrowserContext> | null = null;

/** 仅在服务退出时关闭，任务之间继续复用已通过验证的持久会话。 */
export async function shutdownOoclPatchright() {
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
  return /cloudflare|正在验证您是否是真人|verify you are human|security check|attention required|access denied|captcha|challenge platform|验证码|安全验证|拖拽|滑块/i.test(value);
}

function expectedBillReference(input: TrackingQuery) {
  return normalizedReference(input.originalBillNo).replace(/^OOLU/, '');
}

function isResultText(text: string, input: TrackingQuery) {
  const normalized = normalizedReference(text);
  if (!normalized.includes(expectedBillReference(input))) return false;
  if (input.containerNo && !normalized.includes(normalizedReference(input.containerNo))) return false;
  return /卸货|到达|离港|装船|重箱进场|提空箱|discharg|arrival|departure/i.test(text)
    && /\b(?:PDT|PST|CST|UTC|GMT)\b/.test(text);
}

async function visibleCaptcha(page: Page) {
  const candidates = page.locator([
    'iframe[src*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="challenge" i]',
    '[class*="challenge" i]',
  ].join(','));
  for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

function resetContext(context: BrowserContext) {
  if (sharedContext !== context) return;
  sharedContext = null;
  sharedProfile = '';
}

async function ooclContext(dataDirectory: string) {
  const profile = path.resolve(
    process.env.OOCL_PATCHRIGHT_PROFILE_DIR?.trim() || path.join(dataDirectory, 'browser-profile', 'OOCL_PATCHRIGHT'),
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

async function pageText(page: Page) {
  return page.locator('body').innerText().catch(() => '');
}

async function waitForResult(
  page: Page,
  input: TrackingQuery,
  callbacks: BrowserVerificationCallbacks | undefined,
  captchaRequested: () => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  let emptySince = Date.now();
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', '东方海外 Control Tower 页面已关闭');
    if (callbacks?.shouldSkip?.()) throw trackingError('验证码或风控', '东方海外当前记录已按用户指令跳过图形验证');
    const text = await pageText(page);
    if (isResultText(text, input)) {
      callbacks?.onResolved?.();
      return text;
    }
    const challenged = challengeText(text) || await visibleCaptcha(page) || captchaRequested();
    if (!notified && (challenged || Date.now() - emptySince >= 3_000)) {
      if (process.env.BROWSER_HEADLESS !== 'false' || process.env.BROWSER_HUMAN_VERIFY === 'false') {
        throw trackingError('验证码或风控', '东方海外需要人工完成图形拖拽验证，请启用有界面浏览器后重试');
      }
      callbacks?.onRequired?.({
        carrier: input.rule.name,
        carrierCode: input.rule.code,
        billNo: input.originalBillNo,
        containerNo: input.containerNo,
        sourceUrl: page.url(),
      });
      notified = true;
    }
    if (text.trim()) emptySince = Math.min(emptySince, Date.now());
    await page.waitForTimeout(1_000);
  }
  throw trackingError('验证码或风控', '东方海外图形验证或查询结果等待超时，请完成验证后重新执行');
}

async function findExistingResult(context: BrowserContext, input: TrackingQuery) {
  for (const page of context.pages()) {
    if (!/pbcontroltower\.digital\.oocl\.com/i.test(page.url())) continue;
    const text = await pageText(page);
    if (isResultText(text, input)) return { page, text };
  }
  return null;
}

function isOoclHome(page: Page) {
  return /^https:\/\/www\.oocl\.com\/schi\/Pages\/default\.aspx/i.test(page.url());
}

function isOoclResult(page: Page) {
  return /pbcontroltower\.digital\.oocl\.com/i.test(page.url());
}

export class OoclPatchrightTrackingProvider implements TrackingProvider {
  private queue: Promise<void> = Promise.resolve();
  private lastResultPage: Page | null = null;

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
    const directory = sourceEvidenceDirectory(this.dataDirectory, 'OOCL');
    await fs.mkdir(directory, { recursive: true });
    const reference = normalizedReference(input.queryType === 'container' ? input.containerNo : input.originalBillNo).slice(0, 32) || 'UNKNOWN';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_OOCL_${reference}_patchright-${outcome}.png`;
    try {
      await page.screenshot({ path: path.join(directory, fileName), fullPage: true });
      return sourceEvidenceUrl('OOCL', fileName);
    } catch {
      return undefined;
    }
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'OOCL') throw trackingError('解析失败', `东方海外 Patchright Provider 不能查询 ${input.rule.name}`);
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.originalBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `东方海外${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const context = await ooclContext(this.dataDirectory);
    const existing = await findExistingResult(context, input);
    if (existing) {
      this.lastResultPage = existing.page;
      const result = parseOoclControlTowerText(existing.text, input);
      const evidencePath = await this.saveEvidence(existing.page, input, 'success');
      return { ...result, evidencePath, rawPageText: existing.text };
    }

    let activePage: Page | null = null;
    let captchaRequested = false;
    const apiBodies: Array<{ url: string; body: string }> = [];
    const responseListener = async (response: Response) => {
      const url = response.url();
      if (/captcha\/public\/get(?:\?|$)/i.test(url)) captchaRequested = true;
      if (!/\/moc-cargo-tracking\/summary(?:\?|$)|\/public\/ubl\/ct(?:\?|$)/i.test(url) || response.status() !== 200) return;
      const body = await response.text().catch(() => '');
      if (body && body.length <= 2 * 1024 * 1024) apiBodies.push({ url, body });
    };
    context.on('response', responseListener);
    try {
      // 首页是整个批次的固定查询入口。结果页只负责展示和采集，
      // 下一条记录仍回到同一个首页输入框，避免重新打开官网或重建会话。
      let home = context.pages().find(isOoclHome);
      if (!home) home = await context.newPage();
      activePage = home;
      if (!isOoclHome(home)) {
        await home.goto(OOCL_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      await home.locator('#SEARCH_NUMBER').waitFor({ state: 'visible', timeout: 60_000 });
      await home.bringToFront().catch(() => undefined);
      await home.selectOption('#ooclCargoSelector', input.queryType === 'container' ? 'cont' : 'bl');
      await home.locator('#SEARCH_NUMBER').fill('');
      await home.locator('#SEARCH_NUMBER').fill(queryValue);
      const popupPromise = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
      await home.locator('#container_btn').click({ timeout: 10_000 });
      const popup = await popupPromise;
      activePage = popup || context.pages().find(isOoclResult) || home;
      await activePage.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => undefined);
      const text = await waitForResult(activePage, input, this.callbacks, () => captchaRequested, this.timeoutMs);
      const result = parseOoclControlTowerText(text, input);
      const evidencePath = await this.saveEvidence(activePage, input, 'success');
      const rawPageText = apiBodies.length
        ? `${text}\n\n${apiBodies.map((item) => `[OOCL API ${item.url}]\n${item.body}`).join('\n\n')}`
        : text;
      // 成功后只保留一个结果页，避免批量查询不断累积 Chrome 标签；
      // 浏览器、首页和持久 Profile 均继续保留。
      if (this.lastResultPage && this.lastResultPage !== activePage && !this.lastResultPage.isClosed()) {
        await this.lastResultPage.close().catch(() => undefined);
      }
      if (isOoclResult(activePage)) this.lastResultPage = activePage;
      return { ...result, evidencePath, sourceUrl: activePage.url(), rawPageText };
    } catch (error) {
      const failure = classifyTrackingError(error);
      const evidencePath = activePage ? await this.saveEvidence(activePage, input, 'failure') : undefined;
      throw trackingError(failure.category, failure.reason, { evidencePath, sourceUrl: activePage?.url() || OOCL_HOME });
    } finally {
      context.off('response', responseListener);
    }
  }

  async close() {
    await this.queue;
    this.lastResultPage = null;
    // 保留 OOCL Patchright Profile 和已通过人工验证的页面；任务结束不关闭 Chrome。
  }
}
