/**
 * 轮询原语。Operator 是异步的、也没有推送通道（R17），页面只能反复读，直到读到想要的状态。
 *
 * 语义：立刻读第一次；没 done 就等 intervalMs 再读；从开始算超过 timeoutMs 仍没 done，
 * 以 PollTimeoutError reject。signal 取消后不再发起任何读取，以 AbortError reject——
 * 正在进行的那次读取即使随后返回 done 也不算数，免得卸载后的组件还去落状态。
 * 读取本身出错原样 reject，交给调用方决定怎么提示。
 */

/** R17：发出写操作后每 1.5 秒重拉一次，最长 60 秒。 */
export const OPERATOR_POLL_INTERVAL_MS = 1500;
export const OPERATOR_POLL_TIMEOUT_MS = 60_000;

export class PollTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`condition not met within ${timeoutMs}ms`);
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function abortError(): Error {
  // DOMException 在 jsdom 与浏览器里都有；name 是调用方识别取消的唯一依据。
  return new DOMException("polling was cancelled", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions,
): Promise<T> {
  const { intervalMs, timeoutMs, signal } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) throw abortError();
    const value = await read();
    if (signal?.aborted) throw abortError();
    if (done(value)) return value;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PollTimeoutError(timeoutMs);
    await sleep(Math.min(intervalMs, remaining), signal);
  }
}
