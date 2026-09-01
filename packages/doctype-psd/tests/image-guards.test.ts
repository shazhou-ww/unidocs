import { describe, expect, it } from "vitest";
import type { Pixels } from "../src/model/types.js";
import {
  SENTINEL, applyCoverageToAlpha, compositeOnSentinel, diffMask,
  fitPixelBudget, recoverAlpha, resample, softenMask,
} from "../src/image/guards.js";

const px = (w: number, h: number, fill: (i: number) => [number, number, number, number]): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill(i), i * 4);
  return { width: w, height: h, data };
};
const at = (p: Pixels, i: number) => Array.from(p.data.slice(i * 4, i * 4 + 4));

describe("哨兵底色", () => {
  it("全透明像素被合成成纯哨兵色，alpha 变 255", () => {
    const out = compositeOnSentinel(px(2, 1, () => [9, 9, 9, 0]));
    expect(at(out, 0)).toEqual([SENTINEL.r, SENTINEL.g, SENTINEL.b, 255]);
  });

  it("不透明像素颜色一个比特都不动", () => {
    const out = compositeOnSentinel(px(1, 1, () => [10, 20, 30, 255]));
    expect(at(out, 0)).toEqual([10, 20, 30, 255]);
  });

  it("半透明像素按 alpha 与哨兵色线性混合", () => {
    const out = compositeOnSentinel(px(1, 1, () => [0, 0, 0, 128]));
    // 0*0.502 + 255*0.498 ≈ 127
    expect(out.data[0]).toBeGreaterThan(125);
    expect(out.data[0]).toBeLessThan(130);
    expect(out.data[1]).toBe(0);
    expect(out.data[3]).toBe(255);
  });

  it("往返：不透明像素经 compositeOnSentinel → recoverAlpha 原样回来", () => {
    const src = px(4, 1, i => [i * 10, 20, 30, 255]);
    const back = recoverAlpha(compositeOnSentinel(src));
    expect(Array.from(back.data)).toEqual(Array.from(src.data));
  });

  it("往返：全透明像素经两步后 alpha 回到 0", () => {
    const back = recoverAlpha(compositeOnSentinel(px(1, 1, () => [0, 0, 0, 0])));
    expect(back.data[3]).toBe(0);
  });

  it("接近但不等于哨兵色的像素（模型重采样带来的噪声）也判为透明", () => {
    const back = recoverAlpha(px(1, 1, () => [252, 3, 251, 255]));
    expect(back.data[3]).toBe(0);
  });

  it("真的品红内容（容差之外）不会被误判成透明", () => {
    const back = recoverAlpha(px(1, 1, () => [220, 40, 215, 255]));
    expect(back.data[3]).toBe(255);
  });
});

describe("重采样", () => {
  it("尺寸不变时原样返回", () => {
    const src = px(3, 2, i => [i, i, i, 255]);
    const out = resample(src, 3, 2);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
    // 必须是真拷贝，不能是原缓冲区的别名 —— 否则调用方对返回值的后续修改会
    // 悄悄污染源图层的像素。
    expect(out.data.buffer).not.toBe(src.data.buffer);
    out.data[0] = 200;
    expect(src.data[0]).not.toBe(200);
  });

  it("水平方向双线性插值：非均匀源，逐值核对像素中心对齐与边缘钳位", () => {
    // 2x1 源，红通道 [0, 255]，放大到 4x1。
    // sx = 0.5；x=0..3 的 fx = (x+0.5)*0.5-0.5 依次是 -0.25(钳位到0), 0.25, 0.75, 1.25(钳位到1)
    // 对应 wx = 0, 0.25, 0.75, 0 → 红通道 0, 63.75→64, 191.25→191, 255
    const src = px(2, 1, i => (i === 0 ? [0, 0, 0, 255] : [255, 0, 0, 255]));
    const out = resample(src, 4, 1);
    expect([out.data[0], out.data[4], out.data[8], out.data[12]]).toEqual([0, 64, 191, 255]);
  });

  it("垂直方向双线性插值：同样的数值，防止坐标轴搞反", () => {
    // 1x2 源，红通道 [0, 255]，放大到 1x4，与水平用例数值完全一致。
    const src = px(1, 2, i => (i === 0 ? [0, 0, 0, 255] : [255, 0, 0, 255]));
    const out = resample(src, 1, 4);
    expect([out.data[0], out.data[4], out.data[8], out.data[12]]).toEqual([0, 64, 191, 255]);
  });

  it("放大再缩回，纯色图保持纯色", () => {
    const src = px(4, 4, () => [10, 20, 30, 255]);
    const back = resample(resample(src, 16, 12), 4, 4);
    expect(back.width).toBe(4);
    for (let i = 0; i < 16; i++) {
      expect(back.data[i * 4]).toBeGreaterThan(8);
      expect(back.data[i * 4]).toBeLessThan(12);
    }
  });

  it("缩小后尺寸精确，缓冲长度自洽", () => {
    const out = resample(px(8, 8, () => [1, 2, 3, 4]), 3, 5);
    expect([out.width, out.height, out.data.length]).toEqual([3, 5, 3 * 5 * 4]);
  });
});

describe("像素预算", () => {
  it("已经在区间内就不动", () => {
    expect(fitPixelBudget(613, 457, 1024, 4_000_000)).toEqual({ width: 613, height: 457 });
  });
  it("太大则等比缩小到不超过上限", () => {
    const r = fitPixelBudget(4000, 3000, 1024, 1_000_000);
    expect(r.width * r.height).toBeLessThanOrEqual(1_000_000);
    expect(r.width / r.height).toBeCloseTo(4000 / 3000, 2);
  });
  it("太小则等比放大到不低于下限", () => {
    const r = fitPixelBudget(100, 50, 100_000, 4_000_000);
    expect(r.width * r.height).toBeGreaterThanOrEqual(100_000);
    expect(r.width / r.height).toBeCloseTo(2, 2);
  });
  it("永远不产出 0 边长", () => {
    const r = fitPixelBudget(1, 10_000, 1, 100);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe("差异蒙版", () => {
  const before = px(4, 4, () => [100, 100, 100, 255]);

  it("完全没变时全黑", () => {
    const cov = diffMask(before, before)!;
    expect(cov.data.every(v => v === 0)).toBe(true);
  });

  it("阈值以内的全局色偏被挡住 —— 实测 qwen 是 -1.94/-1.62/+0.52", () => {
    const after = px(4, 4, () => [98, 98, 101, 255]);
    const cov = diffMask(before, after)!;
    expect(cov.data.every(v => v === 0)).toBe(true);
  });

  it("超过阈值的像素被标白", () => {
    const after = px(4, 4, i => (i === 5 ? [200, 100, 100, 255] : [100, 100, 100, 255]));
    const cov = diffMask(before, after)!;
    expect(cov.data[5]).toBe(255);
    expect(cov.data[0]).toBe(0);
  });

  it("alpha 变化也算改动", () => {
    const after = px(4, 4, i => (i === 3 ? [100, 100, 100, 0] : [100, 100, 100, 255]));
    expect(diffMask(before, after)!.data[3]).toBe(255);
  });

  it("改动面积过大时返回 null —— 蒙版不可信，调用方降级整层替换", () => {
    const after = px(4, 4, () => [0, 255, 0, 255]);
    expect(diffMask(before, after)).toBeNull();
  });

  it("尺寸不一致直接抛 —— 这是调用方的 bug，不该悄悄兜住", () => {
    expect(() => diffMask(before, px(2, 2, () => [0, 0, 0, 255]))).toThrow(/size/i);
  });
});

describe("蒙版软化", () => {
  it("膨胀把边界向外推，覆盖重采样带来的一圈毛边", () => {
    const cov = { width: 5, height: 5, data: new Uint8ClampedArray(25) };
    cov.data[12] = 255; // 正中心
    const out = softenMask(cov, { dilate: 1, feather: 0 });
    expect(out.data[11]).toBe(255);
    expect(out.data[7]).toBe(255);
    expect(out.data[0]).toBe(0);
  });

  it("羽化产生 0..255 之间的过渡值", () => {
    const cov = { width: 9, height: 1, data: new Uint8ClampedArray(9) };
    for (let i = 3; i < 6; i++) cov.data[i] = 255;
    const out = softenMask(cov, { dilate: 0, feather: 2 });
    expect(out.data[2]).toBeGreaterThan(0);
    expect(out.data[2]).toBeLessThan(255);
  });

  it("dilate 和 feather 都是 0 时原样返回", () => {
    const cov = { width: 3, height: 1, data: new Uint8ClampedArray([0, 255, 0]) };
    expect(Array.from(softenMask(cov, { dilate: 0, feather: 0 }).data)).toEqual([0, 255, 0]);
  });
});

describe("覆盖度烘进 alpha", () => {
  it("覆盖度 0 的像素变全透明 —— 那里原层要露出来", () => {
    const src = px(2, 1, () => [10, 20, 30, 255]);
    const out = applyCoverageToAlpha(src, { width: 2, height: 1, data: new Uint8ClampedArray([0, 255]) });
    expect(at(out, 0)).toEqual([10, 20, 30, 0]);
    expect(at(out, 1)).toEqual([10, 20, 30, 255]);
  });

  it("与源自身的 alpha 相乘 —— 源本来就半透明的地方不会被拉回不透明", () => {
    const src = px(1, 1, () => [10, 20, 30, 128]);
    const out = applyCoverageToAlpha(src, { width: 1, height: 1, data: new Uint8ClampedArray([255]) });
    expect(out.data[3]).toBe(128);
  });

  it("羽化过渡带产生中间 alpha", () => {
    const src = px(1, 1, () => [10, 20, 30, 255]);
    const out = applyCoverageToAlpha(src, { width: 1, height: 1, data: new Uint8ClampedArray([128]) });
    expect(out.data[3]).toBeGreaterThan(120);
    expect(out.data[3]).toBeLessThan(135);
  });

  it("尺寸不一致直接抛", () => {
    expect(() => applyCoverageToAlpha(px(2, 2, () => [0, 0, 0, 255]),
      { width: 1, height: 1, data: new Uint8ClampedArray(1) })).toThrow(/size/i);
  });
});
