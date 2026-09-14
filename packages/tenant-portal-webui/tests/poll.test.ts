import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError, pollUntil } from "../src/model/poll.js";

describe("pollUntil", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("第 3 次读到 done 就停：恰好读 3 次，间隔为 intervalMs", async () => {
    let reads = 0;
    const read = vi.fn(async () => { reads += 1; return reads; });
    const result = pollUntil(read, (value) => value === 3, { intervalMs: 1500, timeoutMs: 60_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(result).resolves.toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("超过 timeoutMs 仍未 done 就以 PollTimeoutError reject，之后不再读取", async () => {
    const read = vi.fn(async () => null);
    const result = pollUntil(read, () => false, { intervalMs: 1500, timeoutMs: 6000 });
    const settled = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(6000);
    expect(await settled).toBeInstanceOf(PollTimeoutError);
    const reads = read.mock.calls.length;
    // 0、1.5、3、4.5、6 秒各读一次。
    expect(reads).toBe(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it("signal 取消后不再读取，并以 AbortError reject", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => null);
    const result = pollUntil(read, () => false, { intervalMs: 1500, timeoutMs: 60_000, signal: controller.signal });
    const settled = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(2);
    controller.abort();

    expect((await settled as Error).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("读取正在进行时被取消，读完也不算完成", async () => {
    const controller = new AbortController();
    let release!: (value: number) => void;
    const read = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const result = pollUntil(read, () => true, { intervalMs: 1500, timeoutMs: 60_000, signal: controller.signal });
    const settled = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    release(1);

    expect((await settled as Error).name).toBe("AbortError");
  });

  it("已经取消的 signal 一次都不读", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 1);

    await expect(pollUntil(read, () => true, { intervalMs: 1500, timeoutMs: 60_000, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });

  it("读取出错原样 reject，不吞掉", async () => {
    const read = vi.fn(async () => { throw new Error("boom"); });
    await expect(pollUntil(read, () => true, { intervalMs: 1500, timeoutMs: 60_000 })).rejects.toThrow("boom");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
