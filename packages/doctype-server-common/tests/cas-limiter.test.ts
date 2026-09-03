import { describe, expect, it } from "vitest";
import { SValueContentType } from "@unidocs/protocol";
import { createSBlob, encodeSValue } from "@unidocs/svalue-codec";
import { CasLimiter, DEFAULT_CAS_CONCURRENCY } from "../src/cas-limiter.js";
import { createSBlobContext, type SBlobCasAdapter } from "../src/sblob-context.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Deferred { readonly promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 记录峰值在途数的探针,套在任意异步体外面。 */
function probe(): { wrap: <T>(fn: () => Promise<T>) => Promise<T>; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    async wrap(fn) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    },
  };
}

describe("CasLimiter", () => {
  it("在途数不超过上限", async () => {
    const limiter = new CasLimiter(3);
    const p = probe();
    await Promise.all(
      Array.from({ length: 40 }, () => limiter.run(() => p.wrap(tick))),
    );
    expect(p.peak()).toBeLessThanOrEqual(3);
    // 没有这一条,一个"永远串行"的实现也能过。
    expect(p.peak()).toBeGreaterThan(1);
    expect(limiter.inFlight).toBe(0);
  });

  it("上限为 1 时确实退化成串行", async () => {
    const limiter = new CasLimiter(1);
    const p = probe();
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(() => p.wrap(tick))));
    expect(p.peak()).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])("上限 %p 直接拒绝(0 会死锁)", (bad) => {
    expect(() => new CasLimiter(bad)).toThrow(TypeError);
  });

  it("fn 抛错时许可归还,错误原样冒泡", async () => {
    const limiter = new CasLimiter(2);
    const boom = new Error("boom");
    await expect(limiter.run(async () => { throw boom; })).rejects.toBe(boom);
    expect(limiter.inFlight).toBe(0);

    // 不归还的话,连抛 limit 次之后闸门永久关死,下面这句会挂住而不是通过。
    for (let i = 0; i < 2; i++) {
      await limiter.run(async () => { throw boom; }).catch(() => undefined);
    }
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
    expect(limiter.inFlight).toBe(0);
  });

  /**
   * 朴素信号量(release 先 `active--` 再唤醒队首、acquire 不看队列)的越界窗口:
   * 队首被唤醒但尚未恢复执行时,`active` 已经降下来了,此刻新到的调用者就能插队。
   *
   * 不用压力循环去撞这个窗口 —— 上一版就是那么写的,朴素实现照样全绿,等于恒真。
   * 这里改成:在"A 完成"这个信号之后的**每一个微任务深度**上各插一个新到达,
   * 必然有一个正好落在窗口里。深度是确定的,不依赖计时。
   */
  it("有人排队时后到者不许插队", async () => {
    const limiter = new CasLimiter(2);
    const p = probe();
    const gates = Array.from({ length: 12 }, deferred);
    const started: Array<Promise<void>> = [];
    let next = 0;

    const start = (): void => {
      const gate = gates[next++]!;
      started.push(limiter.run(() => p.wrap(() => gate.promise)));
    };

    start(); start();      // A、B 占满上限
    start(); start();      // C、D 排队
    await tick();          // 让 A、B 的探针真的进去(峰值到 2)
    expect(p.peak()).toBe(2);

    // 在 A 完成信号之后的第 0..5 个微任务深度上各插一个新到达。
    for (let depth = 0; depth < 6; depth++) {
      let at: Promise<unknown> = gates[0]!.promise;
      for (let i = 0; i < depth; i++) at = at.then(() => undefined);
      void at.then(start);
    }

    gates[0]!.resolve();
    await tick();
    // 放掉其余所有,收工。
    for (const g of gates) g.resolve();
    await Promise.all(started);

    expect(p.peak()).toBeLessThanOrEqual(2);
    expect(limiter.inFlight).toBe(0);
  });
});

const hashOf = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

/** 记录 CAS 调用峰值并发的假适配器。每次调用都真的让出一轮,才量得到重叠。 */
function tracingAdapter(): {
  adapter: SBlobCasAdapter;
  peak: () => number;
  leased: string[];
} {
  const p = probe();
  const leased: string[] = [];
  const adapter: SBlobCasAdapter = {
    leaseNode: (hash) => p.wrap(async () => { leased.push(hash); await tick(); return { ready: true }; }),
    leaseNodeContent: () => p.wrap(async () => { await tick(); return { ready: true }; }),
    storeBlob: (source) => p.wrap(async () => {
      await tick();
      return { hash: hashOf(0xee), size: "data" in source ? source.data.length : 0 };
    }),
    openBlob: () => p.wrap(async () => { await tick(); throw new Error("not used"); }),
  };
  return { adapter, peak: p.peak, leased };
}

describe("createSBlobContext 的 CAS 闸门", () => {
  // 钉住「连带改动 1」:#store 的 ref 租约从完全串行(0795252 为躲 OOM 的退化)
  // 换回并发,但峰值由闸门兜住。
  it("#store 的 ref 租约是并发的,且不超过 casConcurrency", async () => {
    const { adapter, peak, leased } = tracingAdapter();
    const ctx = createSBlobContext(adapter, { casConcurrency: 3 });

    const hashes = Array.from({ length: 12 }, (_, i) => hashOf(i + 1));
    const encoded = encodeSValue({ blobs: hashes.map(createSBlob) });
    const data = encoded instanceof Uint8Array ? encoded : encoded.data;

    await ctx.makeSBlob({ data, contentType: SValueContentType });

    expect(new Set(leased)).toEqual(new Set(hashes));
    expect(peak()).toBeGreaterThan(1);   // 不是串行
    expect(peak()).toBeLessThanOrEqual(3);
  });

  it("省略 casConcurrency 时用 DEFAULT_CAS_CONCURRENCY", async () => {
    const { adapter, peak } = tracingAdapter();
    const ctx = createSBlobContext(adapter);

    const hashes = Array.from({ length: 20 }, (_, i) => hashOf(i + 1));
    const encoded = encodeSValue({ blobs: hashes.map(createSBlob) });
    const data = encoded instanceof Uint8Array ? encoded : encoded.data;

    await ctx.makeSBlob({ data, contentType: SValueContentType });

    expect(peak()).toBeLessThanOrEqual(DEFAULT_CAS_CONCURRENCY);
    expect(peak()).toBeGreaterThan(1);
  });
});
