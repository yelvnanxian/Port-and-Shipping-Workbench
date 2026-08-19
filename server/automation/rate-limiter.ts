/**
 * 速率限制器 - 按船司分别限流，防止触发官网风控
 */

export class RateLimiter {
  private nextAvailableAt = new Map<string, number>();
  private carrierLimits: Map<string, number>;
  private defaultLimit: number;

  constructor(defaultRequestsPerMinute: number = 10) {
    // 按船司定制限流（风控严重的船司更严格）
    this.carrierLimits = new Map([
      ['WANHAI', 3],   // 万海 HTTP 412 严重
      ['ZIM', 5],      // 以星 Cloudflare 验证
      ['CMA', 5],      // 达飞 Cloudflare 验证
      ['HAPAG', 5],    // 赫伯罗特 Security Check
      ['COSCO', 6],    // 中远海运
      ['MAERSK', 10],  // 马士基
      ['MSC', 6],      // 地中海
      ['ONE', 8],      // 海洋网联
      ['HMM', 6],      // 韩新海运
      ['YANGMING', 6], // 阳明
    ]);

    this.defaultLimit = defaultRequestsPerMinute;
  }

  /**
   * 限流控制 - 确保两次请求间隔满足船司限制
   */
  async throttle(carrierCode: string): Promise<void> {
    const limit = this.carrierLimits.get(carrierCode) || this.defaultLimit;
    const minInterval = (60 * 1000) / limit;  // 毫秒

    const now = Date.now();
    // 在 await 前预留时间槽，保证多个 worker 同时进入时也会依次排队。
    const scheduledAt = Math.max(now, this.nextAvailableAt.get(carrierCode) || now);
    this.nextAvailableAt.set(carrierCode, scheduledAt + minInterval);
    const waitTime = Math.ceil(scheduledAt - now);

    if (waitTime > 0) {
      console.log(`[RateLimiter] ${carrierCode} 限流等待 ${Math.round(waitTime)}ms（每分钟 ${limit} 次）`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  /**
   * 获取船司的速率限制配置
   */
  getLimit(carrierCode: string): number {
    return this.carrierLimits.get(carrierCode) || this.defaultLimit;
  }

  /**
   * 重置某个船司的限流状态（测试用）
   */
  reset(carrierCode?: string): void {
    if (carrierCode) {
      this.nextAvailableAt.delete(carrierCode);
    } else {
      this.nextAvailableAt.clear();
    }
  }
}
