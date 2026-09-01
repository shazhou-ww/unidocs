import { describe, expect, it } from "vitest";
import type { ImageEditor } from "../image/editor.js";
import type { Pixels } from "../model/types.js";

/**
 * 每个 ImageEditor 实现都要过的契约。
 *
 * 它**只断言后置条件** —— 同尺寸、alpha 完整、provenance 齐全 —— 不断言
 * 画得好不好看。生成模型的输出没有确定性，"像不像"不是测试能守住的东西；
 * 能守住的是"调用方拿到的形状永远对"，而这恰恰是 effect 唯一依赖的性质。
 *
 * `live: false` 用来跑桩实现和录制回放，CI 默认走这条。
 * `live: true` 才真打 provider，需要环境变量里有 key，本地手动跑。
 * 这个标志目前只影响调用方怎么跑这个套件，不改变断言本身 —— 契约
 * 没法强迫任意实现按需失败，"失败以 EditResult 返回、不抛异常" 这件事
 * 留给各实现自己的测试去证（桩见 `tests/image-editor-stub.test.ts`，
 * 真实 provider 见其错误映射的专门测试）。
 */
export function runImageEditorContract(
  label: string,
  factory: () => Promise<ImageEditor>,
  opts: { live: boolean },
): void {
  const source: Pixels = (() => {
    const width = 64, height = 48;
    const data = new Uint8ClampedArray(width * height * 4);
    const ALPHAS = [0, 128, 255];
    for (let i = 0; i < width * height; i++) {
      // alpha 不是常量，且**含全透明像素** —— 下面的断言就靠这些像素判断
      // 哨兵回收是否真的跑过。半透明的 128 留着是有意的：它记录了这个端口
      // 不承诺保住部分透明（recoverAlpha 只吐 0 或 255）。
      data.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, ALPHAS[i % 3]], i * 4);
    }
    return { width, height, data };
  })();

  describe(`ImageEditor 契约: ${label}`, () => {
    it("capabilities 自洽", async () => {
      const e = await factory();
      expect(e.id.length).toBeGreaterThan(0);
      expect(["required", "optional", "unsupported"]).toContain(e.capabilities.mask);
      expect(e.capabilities.minPixels).toBeGreaterThan(0);
      expect(e.capabilities.maxPixels).toBeGreaterThanOrEqual(e.capabilities.minPixels);
    });

    it("成功时输出与输入严格同尺寸，且是完整的 RGBA 缓冲", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      expect(r.pixels.width).toBe(source.width);
      expect(r.pixels.height).toBe(source.height);
      expect(r.pixels.data.length).toBe(source.width * source.height * 4);
    });

    it("透明区没有被整片压成不透明 —— 哨兵回收确实跑过", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "保持原样" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      // 断言的是**全透明像素**的数量，不是"半透明像素活下来" —— 后者这个
      // 端口不承诺：recoverAlpha 只写 0 或 255，源里的 128 一律被推到两端。
      // 旧断言写的是 `alpha < 250`，alpha===0 的像素顺手滑过去，于是它读起来
      // 像在守"部分透明被保住"，实际只守住了"不是全图 255"。
      let transparent = 0;
      for (let i = 3; i < r.pixels.data.length; i += 4) if (r.pixels.data[i] === 0) transparent++;
      expect(transparent).toBeGreaterThan(0);
    });

    it("changed 要么是 null，要么与源同尺寸的单通道覆盖度", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      if (r.changed !== null) {
        expect(r.changed.width).toBe(source.width);
        expect(r.changed.height).toBe(source.height);
        expect(r.changed.data.length).toBe(source.width * source.height);
      }
    });

    it("provenance 三个字段都不能是空的", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红", seed: 7 }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      expect(r.provenance.model.length).toBeGreaterThan(0);
      expect(r.provenance.prompt).toBe("把左上角涂红");
      expect(Number.isFinite(r.provenance.seed)).toBe(true);
    });

    it("已经 abort 的 signal 不产生成功结果", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "随便" }, AbortSignal.abort()).catch(
        (err: unknown) => ({ ok: false as const, reason: "timeout" as const, detail: String(err) }),
      );
      expect(r.ok).toBe(false);
    });
  });
}
