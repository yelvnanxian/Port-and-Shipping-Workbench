import type { RunSummary } from './types.js';

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
  const failed = summary.failedDetails.length
    ? summary.failedDetails.map((detail, index) => `${index + 1}. ${detail.carrier}｜提单 ${detail.billNo}｜柜号 ${detail.containerNo || '未提供'}｜${detail.category}｜${detail.reason}`).join('\n')
    : '无';
  const content = [
    '【船期自动更新完成】',
    `更新时间：${new Date(summary.finishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `查询总数：${summary.total}`,
    `成功：${summary.success}`,
    `未完成：${summary.unfinished}`,
    `失败：${summary.failed}`,
    '失败明细：',
    failed,
  ].join('\n');
  return sendText(webhook, content);
}

export function notifyWeComTest(configuredWebhook: string) {
  return sendText(configuredWebhook.trim(), '【港航工作台】企业微信通知配置测试成功。');
}
