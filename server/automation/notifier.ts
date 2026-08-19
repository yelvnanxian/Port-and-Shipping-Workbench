import type { RunSummary } from './types.js';

export async function notifyWeCom(summary: RunSummary): Promise<'sent' | 'skipped' | 'failed'> {
  const webhook = process.env.WECHAT_WEBHOOK_URL?.trim();
  if (!webhook) return 'skipped';
  try {
    const parsed = new URL(webhook);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'qyapi.weixin.qq.com') throw new Error('企业微信 Webhook 地址不合法');
    const failed = summary.failedBills.length ? summary.failedBills.join('、') : '无';
    const content = [
      '【船期自动更新完成】',
      `更新时间：${new Date(summary.finishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
      `查询总数：${summary.total}`,
      `成功：${summary.success}`,
      `未完成：${summary.unfinished}`,
      `失败：${summary.failed}`,
      `异常单号：${failed}`,
    ].join('\n');
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
