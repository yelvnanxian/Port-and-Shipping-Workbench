import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { browserExecutablePath } from './browser.js';
import { classifyTrackingError, trackingError } from './errors.js';
import { legacyStatePath, sourceEvidenceDirectory, sourceEvidenceUrl, sourceStatePath } from './source-storage.js';
import type { TrackingProvider } from './tracker.js';
import type { TrackingQuery, TrackingResult } from './types.js';

const HMM_SOURCE = 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do';
const DEFAULT_TIMEOUT_MS = 50_000;

interface HmmEvent {
  dateTime: string;
  location: string;
  status: string;
  mode: string;
}

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function plainText(value: string) {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedReference(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]).trim() : '';
}

function hiddenValue(html: string, id: string) {
  const tag = [...html.matchAll(/<input\b[^>]*>/gi)].find((match) => attribute(match[0], 'id') === id)?.[0];
  return tag ? attribute(tag, 'value') : '';
}

function shipmentEvents(html: string): HmmEvent[] {
  const table = html.match(/<div\b[^>]*id=["']shipmentProgress["'][^>]*>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1] || '';
  return [...table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)].flatMap((row) => {
    if (!/\bclsMoves\b/i.test(row[1])) return [];
    const cells = [...row[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => plainText(cell[1]));
    if (cells.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0]) || !/^\d{2}:\d{2}$/.test(cells[1])) return [];
    return [{ dateTime: `${cells[0]} ${cells[1]}`, location: cells[2], status: cells[3], mode: cells[4] }];
  });
}

function destinationArrival(html: string) {
  const labelIndex = html.search(/Arrival at Destination/i);
  if (labelIndex < 0) return null;
  const context = html.slice(labelIndex, labelIndex + 700);
  const match = context.match(/<div\b[^>]*class=["'][^"']*\b(red|blue)\b[^"']*["'][^>]*>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*<\/div>/i);
  return match ? { kind: match[1].toLowerCase() === 'red' ? 'ATA' as const : 'ETA' as const, dateTime: match[2] } : null;
}

function isArrivalAtPod(status: string) {
  return /vessel arrival at pod|arrival at (?:the )?port of discharg|vessel arrived at pod/i.test(status);
}

function isActualDischarge(status: string) {
  return /(?:container|vessel).*(?:discharged|unloaded)|(?:discharged|unloaded).*(?:container|vessel|pod)/i.test(status);
}

function localTime(value: string | undefined) {
  return value ? `${value}（官网当地时间）` : null;
}

export function parseHmmTrackingHtml(html: string, expectedBillNo: string, expectedContainerNo = ''): TrackingResult {
  const bodyText = plainText(html);
  if (/access to this site has been limited|access denied|security check|captcha|verify you are human/i.test(bodyText)) {
    throw trackingError('验证码或风控', '韩新海运官网限制了当前浏览器会话');
  }
  if (/500 Error|This page isn't working|service unavailable|internal server error/i.test(bodyText)) {
    throw trackingError('官网接口异常', '韩新海运官网查询接口返回服务器异常');
  }
  if (/no data|no result|not found|invalid/i.test(bodyText)) {
    throw trackingError('订单号验证失败', `韩新海运官网未找到 ${expectedBillNo}`);
  }

  const returnedBill = hiddenValue(html, 'thisBl').toUpperCase();
  const returnedContainer = hiddenValue(html, 'thisCntr').toUpperCase();
  if (!returnedBill) throw trackingError('订单号验证失败', `韩新海运官网未返回提单号 ${expectedBillNo}`);
  if (normalizedReference(returnedBill) !== normalizedReference(expectedBillNo)) {
    throw trackingError('订单号验证失败', `韩新海运官网返回提单号 ${returnedBill}，与查询号 ${expectedBillNo} 不一致`);
  }
  if (expectedContainerNo && normalizedReference(returnedContainer) !== normalizedReference(expectedContainerNo)) {
    throw trackingError('订单号验证失败', `韩新海运官网返回柜号 ${returnedContainer || '空'}，与输入柜号 ${expectedContainerNo} 不一致`);
  }

  const events = shipmentEvents(html);
  const arrivalEvent = events.find((event) => isArrivalAtPod(event.status));
  const dischargeEvent = events.find((event) => isActualDischarge(event.status));
  const scheduledArrival = destinationArrival(html);
  const arrivalKind = arrivalEvent ? 'ATA' as const : scheduledArrival?.kind || null;
  const arrivalTimeText = localTime(arrivalEvent?.dateTime || scheduledArrival?.dateTime);
  const dischargeTimeText = localTime(dischargeEvent?.dateTime);
  if (!arrivalTimeText && !dischargeTimeText) {
    throw trackingError('解析失败', `韩新海运官网已返回提单 ${returnedBill}，但没有可验证的到港或实际卸船时间`);
  }

  const latest = events[0];
  return {
    arrivalTime: null,
    arrivalTimeText,
    arrivalKind,
    arrived: Boolean(arrivalEvent || dischargeEvent || scheduledArrival?.kind === 'ATA'),
    dischargeTime: null,
    dischargeTimeText,
    rawSummary: `韩新海运官网浏览器查询解析成功；官网提单=${returnedBill}；官网柜号=${returnedContainer || '未提供'}${arrivalEvent ? `；实际到港事件=${arrivalEvent.status} ${arrivalEvent.dateTime}` : scheduledArrival ? `；预计到港=${scheduledArrival.dateTime}` : ''}${dischargeEvent ? `；实际卸船事件=${dischargeEvent.status} ${dischargeEvent.dateTime}` : '；未发现实际卸船事件'}${latest ? `；最新事件=${latest.status} ${latest.dateTime}` : ''}；官网明确所有时间均为当地时间`,
    sourceUrl: HMM_SOURCE,
  };
}

export class HmmTrackingProvider implements TrackingProvider {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  query(input: TrackingQuery): Promise<TrackingResult> {
    const pending = this.queue.then(() => this.execute(input));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async getBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: process.env.HMM_BROWSER_HEADLESS === 'true',
        executablePath: await browserExecutablePath(),
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,1000'],
      });
    }
    return this.browser;
  }

  private statePath() {
    return sourceStatePath(this.dataDirectory, 'HMM');
  }

  private async existingStatePath() {
    const current = this.statePath();
    try {
      await fs.access(current);
      return current;
    } catch {
      const legacy = legacyStatePath(this.dataDirectory, 'HMM');
      try {
        await fs.access(legacy);
        return legacy;
      } catch {
        return undefined;
      }
    }
  }

  private async getContext() {
    if (this.context) return this.context;
    let storageState: string | undefined;
    storageState = await this.existingStatePath();
    this.context = await (await this.getBrowser()).newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
      ...(storageState ? { storageState } : {}),
    });
    await this.context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    return this.context;
  }

  private async saveState() {
    if (!this.context) return;
    await fs.mkdir(path.dirname(this.statePath()), { recursive: true });
    await this.context.storageState({ path: this.statePath() });
  }

  private async saveEvidence(page: Page, input: TrackingQuery, outcome: 'success' | 'failure') {
    const evidenceDirectory = sourceEvidenceDirectory(this.dataDirectory, 'HMM');
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const reference = normalizedReference(input.originalBillNo).slice(0, 32) || 'UNKNOWN';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_HMM_${reference}_${outcome}.png`;
    try {
      await page.screenshot({ path: path.join(evidenceDirectory, fileName), fullPage: true });
      return sourceEvidenceUrl('HMM', fileName);
    } catch {
      return undefined;
    }
  }

  private async execute(input: TrackingQuery): Promise<TrackingResult> {
    if (input.rule.code !== 'HMM') throw trackingError('解析失败', `韩新海运解析器不能查询 ${input.rule.name}`);
    if (input.queryType !== 'bill') throw trackingError('解析失败', '韩新海运解析器目前按提单号查询');
    const billNo = input.queryBillNo.trim().toUpperCase();
    if (!/^[A-Z0-9]{10,16}$/.test(billNo)) throw trackingError('订单号验证失败', `韩新海运提单号格式不正确：${billNo || '空'}`);

    const context = await this.getContext();
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    let sourceUrl = HMM_SOURCE;
    try {
      await page.goto(HMM_SOURCE, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      sourceUrl = page.url();
      const initialText = await page.locator('body').innerText().catch(() => '');
      if (/access to this site has been limited|access denied|security check/i.test(initialText)) {
        throw trackingError('验证码或风控', '韩新海运官网限制了当前浏览器会话；该站必须使用有界面的真实 Chrome 会话');
      }
      await page.waitForFunction("typeof search === 'function'", undefined, { timeout: this.timeoutMs });
      await page.locator('input[name="srchBlNo1"]').fill(billNo);
      const responsePromise = page.waitForResponse((response) => response.url().includes('/selectTrackNTrace.do'), { timeout: this.timeoutMs });
      await page.locator('button[onclick="search()"]').click();
      const response = await responsePromise;
      if (response.status() === 403 || response.status() === 412) throw trackingError('验证码或风控', `韩新海运官网查询被风控拦截（HTTP ${response.status()}）`);
      if (!response.ok()) throw trackingError('官网接口异常', `韩新海运官网查询返回 HTTP ${response.status()}`);
      const html = await response.text();
      await page.waitForTimeout(1_000);
      const result = parseHmmTrackingHtml(html, billNo, input.containerNo.trim().toUpperCase());
      const evidencePath = await this.saveEvidence(page, input, 'success');
      return { ...result, sourceUrl, evidencePath };
    } catch (error) {
      const failure = classifyTrackingError(error);
      const evidencePath = await this.saveEvidence(page, input, 'failure');
      throw trackingError(failure.category, failure.reason, { sourceUrl: page.url() || sourceUrl, evidencePath });
    } finally {
      await this.saveState().catch(() => undefined);
      await page.close().catch(() => undefined);
    }
  }

  async close() {
    await this.queue;
    await this.saveState().catch(() => undefined);
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }
}
