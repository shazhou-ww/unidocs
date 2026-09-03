/**
 * 没传 `casConcurrency` 时的保守默认。
 *
 * 比今天的无上限严，比崩过的 8 松：生产 docx create 曾在并发 8 上报
 * "Durable Object's isolate exceeded its memory limit and was reset"
 * （见 0795252）。新运行时忘了设值，也仍然有界。
 */
export const DEFAULT_CAS_CONCURRENCY = 4;

/**
 * 同时在途的 CAS 子请求上限。
 *
 * 被保护的资源是**调用方 isolate 的内存**：每个在途的 CAS 子请求都在调用方
 * isolate 里持有一份大缓冲。所以闸门属于 CAS 客户端，不属于任何一个 doctype ——
 * 崩的是 docx，无上限的是 psd，而它们共用这一个客户端。
 *
 * 实例作用域（不是模块级全局）：与 `maxReadBytes` 同一个生命周期，每个
 * `createSBlobContext` 一个闸门，取值由各运行时自己给。
 */
export class CasLimiter {
  readonly #limit: number;
  /** 已发出的许可数 = 此刻在途的 CAS 往返数。 */
  #active = 0;
  /** FIFO 等待队列。每个元素是一个「许可已经交给你」的 resolve。 */
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("casConcurrency must be a positive safe integer");
    }
    this.#limit = limit;
  }

  /** 此刻在途的 CAS 往返数。只给测试和诊断用。 */
  get inFlight(): number {
    return this.#active;
  }

  /**
   * 在上限之下跑一次 CAS 往返。
   *
   * `fn` 抛错时许可照常归还，错误原样冒泡 —— 这一层只排队，不改变任何调用点
   * 原有的失败语义。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  /**
   * 队列非空时**一律排队**，即使 `#active` 看起来还有余量。
   *
   * 这半个条件不是保守，是正确性：见 `#release` 的说明。
   */
  #acquire(): Promise<void> {
    if (this.#active < this.#limit && this.#waiters.length === 0) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  /**
   * 许可是**直接移交**给队首的，队列非空时不减 `#active`。
   *
   * 朴素写法（先 `#active--` 再唤醒队首）有一个真实的越界：唤醒只是排了一个
   * 微任务，在队首真正恢复执行之前 `#active` 已经降下来了。此刻新来的调用者
   * 看到还有余量就直接拿走许可，等队首恢复时又 `#active++` —— 在途数就超过了
   * 上限。移交式归还加上 `#acquire` 里的「队列非空一律排队」，两半合起来才关上
   * 这个窗口。
   */
  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#active--;
  }
}
