/**
 * 对同一个键的首次异步初始化做 promise 去重。前端登录后会并发请求总览和
 * 自动化状态；若不去重，同一用户可能瞬间得到两个指向相同 Excel 的引擎。
 */
export class WorkspaceRegistry<T> {
  private readonly ready = new Map<string, T>();
  private readonly initializing = new Map<string, Promise<T>>();

  constructor(private readonly factory: (key: string) => Promise<T>) {}

  async get(key: string) {
    const existing = this.ready.get(key);
    if (existing) return existing;
    const pending = this.initializing.get(key);
    if (pending) return pending;

    const initializing = this.factory(key)
      .then((value) => {
        this.ready.set(key, value);
        return value;
      })
      .finally(() => {
        this.initializing.delete(key);
      });
    this.initializing.set(key, initializing);
    return initializing;
  }

  values() {
    return [...this.ready.values()];
  }
}
