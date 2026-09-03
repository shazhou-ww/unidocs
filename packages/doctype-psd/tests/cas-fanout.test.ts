import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createSBlobContext, type SBlobCasAdapter } from "@unidocs/doctype-server-common";
import type { Canvas, Layer, PsdDoc } from "../src/model/types.js";
import { storePsdDoc } from "../src/state.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const canvas: Canvas = {
  width: 2, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB",
};

/** 每层内容必须互不相同 —— CAS 是内容寻址的,一样的像素会被去重掉,扇出也就没了。 */
function raster(seed: number): Layer {
  return {
    id: `l${seed}`, type: "raster", name: `l${seed}`,
    bounds: [0, 0, 1, 2],
    opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
    pixels: {
      width: 2, height: 1,
      data: new Uint8ClampedArray([seed % 256, 1, 2, 255, 3, (seed * 7) % 256, 4, 255]),
    },
  };
}

function group(id: string, children: Layer[]): Layer {
  return {
    id, type: "group", name: id,
    bounds: [0, 0, 1, 2],
    opacity: 1, blendMode: "pass-through", visible: true, locked: false, clipping: false,
    children,
  };
}

/** 记录 CAS 调用峰值并发的假适配器。内容寻址用真的 sha256,好让 makeExpected
 *  的哈希校验走通;每次调用都真的让出一轮,否则量不到重叠。 */
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

describe("psd 保存路径的 CAS 扇出", () => {
  /**
   * 钉住的是这次改动的理由:`psd/ir.ts` 的 serialize 与 `state.ts` 的 storeLayer
   * 都对图层数组做 `Promise.all`,而且**递归**进组里。按调用点各开一个池只会得到
   * 8^深度;闸门在客户端且是全局的,所以嵌套多深都不越界。
   */
  it("嵌套分组不会把上限乘起来", async () => {
    const doc: PsdDoc = {
      canvas,
      layers: [
        ...Array.from({ length: 6 }, (_, i) => raster(i)),
        group("g1", [
          ...Array.from({ length: 6 }, (_, i) => raster(100 + i)),
          group("g2", Array.from({ length: 6 }, (_, i) => raster(200 + i))),
        ]),
      ],
    };

    const { adapter, peak, calls } = tracingAdapter();
    const ctx = createSBlobContext(adapter, { casConcurrency: 3 });

    const stored = await storePsdDoc(doc, ctx);

    expect(peak()).toBeLessThanOrEqual(3);
    // 真的并发了(否则一个串行实现也能过),而且扇出确实存在:18 层各一次
    // 上传 + 一次租约。
    expect(peak()).toBeGreaterThan(1);
    expect(calls()).toBeGreaterThanOrEqual(18);
    // 限流没把内容弄丢。
    expect(stored.layers).toHaveLength(7);
  });
});
