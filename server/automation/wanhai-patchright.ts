import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'patchright';
import { browserExecutablePath, type BrowserVerificationCallbacks } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { saveEvidenceScreenshot } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';
import { parseWanhaiTrackingText } from './wanhai.js';

const WANHAI_TRACKING = 'https://cn.wanhai.com/cec/#/cargotracking?q=N';
const DEFAULT_TIMEOUT_MS = 180_000;

let sharedContext: BrowserContext | null = null;
let sharedProfile = '';
let sharedLaunch: Promise<BrowserContext> | null = null;

/** 仅在服务退出时关闭，任务之间继续复用已通过验证的持久会话。 */
export async function shutdownWanhaiPatchright() {
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
  return /未找到|查无|无记录|不存在|无资料|no\s+(?:data|result|record)|not found|invalid/i.test(value);
}

function isWanhaiPage(page: Page) {
  return /cn\.wanhai\.com\/cec\//i.test(page.url());
}

function isWanhaiTrackingPage(page: Page) {
  return isWanhaiPage(page) && /#\/cargotracking/i.test(page.url());
}

function hasResult(text: string, input: TrackingQuery) {
  const expected = normalizedReference(input.queryType === 'container' ? input.containerNo : input.queryBillNo);
  const normalized = normalizedReference(text);
  if (!expected || !normalized.includes(expected)) return false;
  return /已到达[A-Z]{5}|已开船|装货港|卸货港|船名\s*\/\s*航次|进口重柜领出|空柜进站|卸船|卸货/i.test(text)
    && /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(text);
}

async function pageText(page: Page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const inputs = await page.locator('input:not([type="hidden"])').evaluateAll((elements) => elements
    .map((element) => (element as HTMLInputElement).value)
    .filter(Boolean)
    .join('\n')).catch(() => '');
  return [body, inputs].filter(Boolean).join('\n');
}

async function visibleCaptcha(page: Page) {
  const candidates = page.locator('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [id*="challenge" i], [class*="challenge" i]');
  for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function queryInput(page: Page) {
  const preferred = page.locator('input[placeholder*="提单号"], input[placeholder*="柜号"], input[type="search"]').first();
  if (await preferred.isVisible().catch(() => false) && await preferred.isEditable().catch(() => false)) return preferred;
  const inputs = page.locator('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
  for (let index = 0; index < await inputs.count(); index += 1) {
    const candidate = inputs.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.isEditable().catch(() => false)) return candidate;
  }
  return null;
}

async function dismissCookies(page: Page) {
  const buttons = page.locator('button, [role="button"], a').filter({ hasText: /^(?:Accept|接受|同意)$/i });
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function expandContainerDetails(page: Page, input: TrackingQuery) {
  await dismissCookies(page);
  const billReference = normalizedReference(input.queryBillNo);
  const rows = page.locator('tr');
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const rowText = normalizedReference(await row.innerText().catch(() => ''));
    if (!billReference || !rowText.includes(billReference)) continue;
    const expand = row.locator('button.el-table__expand-icon, .el-table__expand-icon, button, [role="button"]').first();
    if (await expand.isVisible().catch(() => false)) {
      await expand.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
    break;
  }
  if (input.containerNo) {
    const container = page.locator('a, button, [role="button"], td').filter({ hasText: new RegExp(`^\\s*${input.containerNo.trim()}\\s*$`, 'i') }).first();
    if (await container.isVisible().catch(() => false)) {
      await container.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = await pageText(page);
    if (/空柜进站|进口重柜领出|卸船|卸货|重柜进站/i.test(text)) return text;
    await page.waitForTimeout(500);
  }
  return pageText(page);
}

function resetContext(context: BrowserContext) {
  if (sharedContext !== context) return;
  sharedContext = null;
  sharedProfile = '';
}

async function wanhaiContext(dataDirectory: string) {
  const profile = path.resolve(
    process.env.WANHAI_PATCHRIGHT_PROFILE_DIR?.trim() || path.join(dataDirectory, 'browser-profile', 'WANHAI_PATCHRIGHT'),
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

async function waitForReady(page: Page, input: TrackingQuery, callbacks: BrowserVerificationCallbacks | undefined, timeoutMs: number) {
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let notified = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', '万海查询页面已关闭');
    if (callbacks?.shouldSkip?.()) throw trackingError('验证码或风控', '万海当前记录已按用户指令跳过人工验证');
    const text = await pageText(page);
    const challenged = challengeText(text) || await visibleCaptcha(page);
    if (challenged && !notified) {
      if (process.env.BROWSER_HEADLESS !== 'false' || process.env.BROWSER_HUMAN_VERIFY === 'false') {
        throw trackingError('验证码或风控', '万海需要人工完成安全验证，请启用有界面浏览器后重试');
      }
      callbacks?.onRequired?.({
        carrier: input.rule.name,
        carrierCode: input.rule.code,
        billNo: input.originalBillNo,
        containerNo: input.containerNo,
        sourceUrl: page.url() || WANHAI_TRACKING,
      });
      notified = true;
    }
    if (!challenged && await queryInput(page)) return;
    await page.waitForTimeout(1_000);
  }
  throw trackingError('官网接口异常', '万海官网页面长时间为空白，未加载出可交互查询界面');
}

async function waitForResult(
  page: Page,
  input: TrackingQuery,
  callbacks: BrowserVerificationCallbacks | undefined,
  dialogMessage: () => string,
  timeoutMs: number,
) {
  const deadline = Date.now() + Math.min(timeoutMs, 90_000);
  let notified = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw trackingError('查询超时', '万海结果页面已关闭');
    if (callbacks?.shouldSkip?.()) throw trackingError('验证码或风控', '万海当前记录已按用户指令跳过人工验证');
    const dialog = dialogMessage();
    if (dialog && noResultText(dialog)) throw trackingError('订单号验证失败', `万海官网提示：${dialog.slice(0, 160)}`);
    const text = await pageText(page);
    if (noResultText(text)) throw trackingError('订单号验证失败', `万海官网未找到${input.queryType === 'container' ? '柜号' : '提单号'}查询结果`);
    if (hasResult(text, input)) {
      callbacks?.onResolved?.();
      return text;
    }
    const challenged = challengeText(text) || await visibleCaptcha(page);
    if (challenged && !notified) {
      if (process.env.BROWSER_HEADLESS !== 'false' || process.env.BROWSER_HUMAN_VERIFY === 'false') {
        throw trackingError('验证码或风控', '万海需要人工完成安全验证，请启用有界面浏览器后重试');
      }
      callbacks?.onRequired?.({
        carrier: input.rule.name,
        carrierCode: input.rule.code,
        billNo: input.originalBillNo,
        containerNo: input.containerNo,
        sourceUrl: page.url() || WANHAI_TRACKING,
      });
      notified = true;
    }
    await page.waitForTimeout(1_000);
  }
  // 页面可正常交互、没有验证码、但查询始终没有生成结果时，允许上层按
  // OR 业务规则从提单切换到柜号；仍不把空白页当作成功。
  throw trackingError('订单号验证失败', `万海${input.queryType === 'container' ? '柜号' : '提单号'}查询未返回结果`);
}

async function findExistingResult(context: BrowserContext, input: TrackingQuery) {
  for (const page of context.pages()) {
    if (!/cn\.wanhai\.com/i.test(page.url())) continue;
    const text = await pageText(page);
    if (hasResult(text, input)) return { page, text };
  }
  return null;
}

export class WanhaiPatchrightTrackingProvider implements TrackingProvider {
  private queue: Promise<void> = Promise.resolve();
  private activePage: Page | null = null;

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
    return saveEvidenceScreenshot(page, this.dataDirectory, 'WANHAI', reference, `patchright-${outcome}`);
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'WANHAI') throw trackingError('解析失败', `万海 Patchright Provider 不能查询 ${input.rule.name}`);
    const queryValue = input.queryType === 'container' ? input.containerNo.trim().toUpperCase() : input.queryBillNo.trim().toUpperCase();
    if (!queryValue) throw trackingError('订单号验证失败', `万海${input.queryType === 'container' ? '柜号' : '提单号'}为空`);
    const context = await wanhaiContext(this.dataDirectory);
    const existing = await findExistingResult(context, input);
    if (existing) {
      this.activePage = existing.page;
      const result = parseWanhaiTrackingText(existing.text, input);
      const evidencePath = await this.saveEvidence(existing.page, input, 'success');
      return { ...result, evidencePath, sourceUrl: existing.page.url(), rawPageText: existing.text };
    }

    let activePage: Page | null = null;
    let latestDialog = '';
    const apiBodies: Array<{ url: string; body: string }> = [];
    const responseListener = async (response: Response) => {
      if (response.status() !== 200 || !/cn\.wanhai\.com/i.test(response.url())) return;
      const contentType = response.headers()['content-type'] || '';
      if (!/json/i.test(contentType)) return;
      const body = await response.text().catch(() => '');
      if (body && body.length <= 2 * 1024 * 1024) apiBodies.push({ url: response.url(), body });
    };
    const dialogListener = async (dialog: import('patchright').Dialog) => {
      latestDialog = dialog.message();
      await dialog.accept().catch(() => undefined);
    };
    context.on('response', responseListener);
    try {
      if (this.activePage && !this.activePage.isClosed() && isWanhaiPage(this.activePage)) {
        activePage = this.activePage;
      } else {
        activePage = context.pages().find(isWanhaiTrackingPage)
          || context.pages().find(isWanhaiPage)
          || await context.newPage();
        this.activePage = activePage;
      }
      activePage.on('dialog', dialogListener);
      // 同一批次始终复用这一个 Cargo Tracking 标签页。若用户或官网把页面
      // 导航到了其他万海页面，只恢复到追踪路由，不新建浏览器或 Profile。
      if (!isWanhaiTrackingPage(activePage)) {
        await activePage.goto(WANHAI_TRACKING, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      await waitForReady(activePage, input, this.callbacks, this.timeoutMs);
      await activePage.bringToFront().catch(() => undefined);
      await dismissCookies(activePage);
      const inputElement = await queryInput(activePage);
      if (!inputElement) throw trackingError('官网接口异常', '万海官网未找到可交互查询输入框');
      await inputElement.fill('');
      await inputElement.pressSequentially(queryValue, { delay: 70 });
      const queryButton = activePage.locator('button, [role="button"], input[type="submit"]').filter({ hasText: /^查询$/ }).first();
      if (await queryButton.isVisible().catch(() => false)) await queryButton.click({ timeout: 10_000 });
      else await inputElement.press('Enter');
      await waitForResult(activePage, input, this.callbacks, () => latestDialog, this.timeoutMs);
      const text = await expandContainerDetails(activePage, input);
      const result = parseWanhaiTrackingText(text, input);
      const evidencePath = await this.saveEvidence(activePage, input, 'success');
      const rawPageText = apiBodies.length
        ? `${text}\n\n${apiBodies.map((item) => `[WANHAI API ${item.url}]\n${item.body}`).join('\n\n')}`
        : text;
      return { ...result, evidencePath, sourceUrl: activePage.url(), rawPageText };
    } catch (error) {
      const failure = classifyTrackingError(error);
      const evidencePath = activePage ? await this.saveEvidence(activePage, input, 'failure') : undefined;
      throw trackingError(failure.category, failure.reason, { evidencePath, sourceUrl: activePage?.url() || WANHAI_TRACKING });
    } finally {
      context.off('response', responseListener);
      activePage?.off('dialog', dialogListener);
    }
  }

  async close() {
    await this.queue;
    this.activePage = null;
    // 持久会话与当前结果页继续保留，后续任务复用 Cookie 和页面状态。
  }
}
