/**
 * FIFO 串行协调器。多个 AutomationEngine 可以共享同一个实例，把浏览器抓取
 * 放进同一条全局队列，避免不同账号同时抢占 Chrome、用户数据目录和验证窗口。
 */
export class SerialExecutionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private waitingCount = 0;
  private activeCount = 0;
  private readonly ownership = new AsyncLocalStorage<symbol>();
  private activeOwner: symbol | null = null;

  get waiting() {
    return this.waitingCount;
  }

  get active() {
    return this.activeCount;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // 同一个异步调用链中的嵌套写操作直接复用当前锁。例如“恢复备份”内部会
    // 先创建安全备份；如果再次排队会等待自己而形成死锁。
    const inheritedOwner = this.ownership.getStore();
    if (inheritedOwner && inheritedOwner === this.activeOwner) return task();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate, () => gate);
    this.waitingCount += 1;
    await previous.catch(() => undefined);
    this.waitingCount -= 1;
    this.activeCount += 1;
    const owner = Symbol('serial-execution-owner');
    this.activeOwner = owner;
    try {
      return await this.ownership.run(owner, task);
    } finally {
      this.activeOwner = null;
      this.activeCount -= 1;
      release();
    }
  }
}
import { AsyncLocalStorage } from 'node:async_hooks';
