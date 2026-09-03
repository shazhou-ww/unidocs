import { describe, expect, it } from "vitest";
import { compositeOnSentinel, SENTINEL, unmixSentinel } from "../src/image/guards.js";
import type { Pixels } from "../src/model/types.js";

const px = (data: number[]): Pixels =>
  ({ width: data.length / 4, height: 1, data: new Uint8ClampedArray(data) });

const meanErr = (a: Pixels, b: Pixels, onlyVisible = true) => {
  let n = 0, sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (onlyVisible && b.data[i + 3] === 0) continue;
    n++;
    sum += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
  }
  return sum / n;
};

describe("unmixSentinel —— compositeOnSentinel 的逆运算", () => {
  it("往返还原内容色,残差只剩 8bit 量化", () => {
    // 半透明的深色内容:合成之后它离哨兵最近,也最容易被品红污染。
    const src = px([
      20, 20, 20, 255,      // 实心
      20, 20, 20, 128,      // 半透
      170, 20, 30, 64,      // 红字的抗锯齿边
      0, 0, 0, 0,           // 全透
    ]);
    const back = unmixSentinel(compositeOnSentinel(src), src);
    expect(meanErr(back, src)).toBeLessThan(3);
    // alpha 原样来自源。
    expect([...back.data].filter((_, i) => i % 4 === 3)).toEqual([255, 128, 64, 0]);
  });

  it("不做逆运算的话品红就留在边上 —— 这就是要它的理由", () => {
    const src = px([20, 20, 20, 64]);
    const mixed = compositeOnSentinel(src);
    // 旧做法:只把 alpha 换回源的,RGB 原样留着。
    const onlyAlpha: Pixels = { ...mixed, data: new Uint8ClampedArray(mixed.data) };
    onlyAlpha.data[3] = src.data[3];
    expect(meanErr(onlyAlpha, src)).toBeGreaterThan(100);
    expect(meanErr(unmixSentinel(mixed, src), src)).toBeLessThan(3);
  });

  it("源不透明时是恒等变换 —— 照片层一个像素都不能变", () => {
    // 含品红本身:不透明的地方不该有任何"这是背景"的判断。
    const src = px([
      SENTINEL.r, SENTINEL.g, SENTINEL.b, 255,
      230, 190, 160, 255,
      0, 0, 0, 255,
    ]);
    const back = unmixSentinel(compositeOnSentinel(src), src);
    expect([...back.data]).toEqual([...src.data]);
  });

  it("全透明像素没有内容色可解,alpha 记 0", () => {
    const src = px([0, 0, 0, 0]);
    expect(unmixSentinel(compositeOnSentinel(src), src).data[3]).toBe(0);
  });
});
