/**
 * FIFO 串行协调器。多个 AutomationEngine 可以共享同一个实例，把浏览器抓取
 * 放进同一条全局队列，避免不同账号同时抢占 Chrome、用户数据目录和验证窗口。
 */
export class SerialExecutionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private waitingCount = 0;
  private activeCount = 0;

  get waiting() {
    return this.waitingCount;
  }

  get active() {
    return this.activeCount;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate, () => gate);
    this.waitingCount += 1;
    await previous.catch(() => undefined);
    this.waitingCount -= 1;
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      release();
    }
  }
}
