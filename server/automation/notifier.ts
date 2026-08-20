import type { RunSummary } from './types.js';

const MAX_FAILED_BILLS_PER_GROUP = 3;

export function summarizeFailures(failedDetails: RunSummary['failedDetails']): string {
  if (failedDetails.length === 0) return '无';

  const groups = new Map<string, { carrier: string; category: string; billNos: string[]; count: number }>();
  for (const detail of failedDetails) {
    const key = `${detail.carrier}\u0000${detail.category}`;
    const group = groups.get(key) ?? { carrier: detail.carrier, category: detail.category, billNos: [], count: 0 };
    group.count += 1;
    if (detail.billNo && !group.billNos.includes(detail.billNo)) group.billNos.push(detail.billNo);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const billNos = group.billNos.slice(0, MAX_FAILED_BILLS_PER_GROUP).join('、');
    const omitted = group.billNos.length > MAX_FAILED_BILLS_PER_GROUP ? ` 等 ${group.count} 票` : '';
    const examples = billNos ? `：${billNos}${omitted}` : '';
    return `${group.carrier} ${group.count} 票（${group.category}）${examples}`;
  }).join('\n');
}

export function buildWeComRunContent(summary: RunSummary): string {
  return [
    '【船期自动更新完成】',
    `更新时间：${new Date(summary.finishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `查询总数：${summary.total}`,
    `成功：${summary.success}`,
    `未完成：${summary.unfinished}`,
    `失败：${summary.failed}`,
    '失败概况：',
    summarizeFailures(summary.failedDetails),
  ].join('\n');
}

async function sendText(webhook: string | undefined, content: string): Promise<'sent' | 'skipped' | 'failed'> {
  if (!webhook) return 'skipped';
  try {
    const parsed = new URL(webhook);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'qyapi.weixin.qq.com') throw new Error('企业微信 Webhook 地址不合法');
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`企业微信返回 HTTP ${response.status}`);
    const result = await response.json() as { errcode?: number };
    return result.errcode === 0 ? 'sent' : 'failed';
  } catch (error) {
    console.error('WeCom notification failed:', error instanceof Error ? error.message : error);
    return 'failed';
  }
}

export async function notifyWeCom(summary: RunSummary, configuredWebhook?: string): Promise<'sent' | 'skipped' | 'failed'> {
  const webhook = (configuredWebhook ?? process.env.WECHAT_WEBHOOK_URL)?.trim();
  return sendText(webhook, buildWeComRunContent(summary));
}

export function notifyWeComTest(configuredWebhook: string) {
  return sendText(configuredWebhook.trim(), '【港航工作台】企业微信通知配置测试成功。');
}
