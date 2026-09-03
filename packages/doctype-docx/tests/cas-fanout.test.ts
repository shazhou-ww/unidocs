import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createSBlobContext, type SBlobCasAdapter } from "@unidocs/doctype-server-common";
import { createDocxDocumentType } from "../src/index.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 记录 CAS 调用峰值并发的假适配器。内容寻址用真的 sha256,好让 SBlob 校验走通;
 *  每次调用都真的让出一轮,否则量不到重叠。 */
function tracingAdapter(): { adapter: SBlobCasAdapter; peak: () => number; calls: () => number } {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await tick();
      return await fn();
    } finally {
      inFlight--;
    }
  };
  return {
    peak: () => peak,
    calls: () => calls,
    adapter: {
      leaseNode: () => wrap(async () => ({ ready: true })),
      leaseNodeContent: () => wrap(async () => ({ ready: true })),
      storeBlob: (source) => wrap(async () => {
        const data = "data" in source ? source.data : new Uint8Array();
        return { hash: createHash("sha256").update(data).digest("hex") };
      }),
      openBlob: () => wrap(async () => { throw new Error("openBlob not used in this test"); }),
    },
  };
}

describe("docx 的 CAS 扇出", () => {
  /**
   * docx 的 storeState 会把 OpenXML 的 7 个 part 一起上传。这里曾经由 doctype
   * 自带的 `PART_IO_CONCURRENCY = 2` 限着(0795252,为躲 DO isolate OOM);那份本地
   * 限流已经撤掉,改由 SBlob 客户端统一持有。
   *
   * 没有这条测试,撤掉本地限流这件事就没有任何东西钉着:哪天客户端闸门被摘掉,
   * docx 会静默回到无上限的一批并发上传 —— 正是当初把生产 DO 撑爆的那个形状,
   * 而所有测试照样全绿。
   */
  it("init 的 part 上传受客户端闸门约束,而不是 doctype 自带的上限", async () => {
    const { adapter, peak, calls } = tracingAdapter();
    const ctx = createSBlobContext(adapter, { casConcurrency: 2 });
    const docx = createDocxDocumentType(ctx);

    const state = await docx.init();

    expect(Object.keys(state.files).length).toBeGreaterThanOrEqual(7);
    expect(calls()).toBeGreaterThanOrEqual(7);
    expect(peak()).toBeLessThanOrEqual(2);
    expect(peak()).toBeGreaterThan(1);
  });

  it("闸门放宽,扇出就真的跟着放宽(说明限的是同一处)", async () => {
    const { adapter, peak } = tracingAdapter();
    const ctx = createSBlobContext(adapter, { casConcurrency: 5 });

    await createDocxDocumentType(ctx).init();

    expect(peak()).toBeGreaterThan(2);
    expect(peak()).toBeLessThanOrEqual(5);
  });
});
