import { describe, expect, it } from "vitest";
import { encode, decode } from "fast-png";
import { toRgba8 } from "../src/psd/png.js";

/** 一张 2x1 的图，用给定通道数和位深编码后再解回来——走真正的 PNG 往返，
 *  而不是手搓一个 DecodedPng 结构，这样断言的是 fast-png 实际吐出来的形状。 */
function roundTrip(
  data: Uint8Array | Uint16Array,
  channels: number,
  depth: 8 | 16,
) {
  // width 由 data.length / channels 推出,而不是硬编码 2:16 位那条用例只给了
  // 4 个分量(=1 个 RGBA 像素),硬编码 width:2 会让 fast-png 的 encode() 因为
  // "wrong data size" 直接抛错,还没走到 toRgba8 就先炸在测试夹具里。
  // 其余用例的 data 长度本来就对应 width=2,这里推导出来的值不变。
  const width = data.length / channels;
  return decode(encode({ width, height: 1, data, channels, depth }));
}

describe("toRgba8", () => {
  it("RGBA8 原样通过", () => {
    const px = toRgba8(roundTrip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 4, 8));
    expect(px.width).toBe(2);
    expect(px.height).toBe(1);
    expect(Array.from(px.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("RGB 补上不透明的 alpha", () => {
    const px = toRgba8(roundTrip(new Uint8Array([10, 20, 30, 40, 50, 60]), 3, 8));
    expect(Array.from(px.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("灰度铺到 R/G/B", () => {
    const px = toRgba8(roundTrip(new Uint8Array([90, 200]), 1, 8));
    expect(Array.from(px.data)).toEqual([90, 90, 90, 255, 200, 200, 200, 255]);
  });

  it("灰度+alpha:第二个分量是 alpha,不是颜色", () => {
    const px = toRgba8(roundTrip(new Uint8Array([90, 128, 200, 0]), 2, 8));
    expect(Array.from(px.data)).toEqual([90, 90, 90, 128, 200, 200, 200, 0]);
  });

  // 16 位每分量右移 8 位。0xFFFF -> 255,0x0100 -> 1,0x00FF -> 0。
  // 最后一条是关键:低位被丢弃是有损的,但这是 RGBA8 模型的固有限制,
  // 不是 bug——写成断言免得将来有人"修"成四舍五入。
  it("16 位缩到 8 位:取高字节", () => {
    const px = toRgba8(roundTrip(new Uint16Array([0xffff, 0x0100, 0x00ff, 0x8000]), 4, 16));
    expect(Array.from(px.data)).toEqual([255, 1, 0, 128]);
  });

  it("调色板图查表得到 RGB", () => {
    // 手构 DecodedPng:fast-png 的 encode 不支持写 indexed PNG,
    // 所以这一条只能直接喂解码结果的形状。
    const px = toRgba8({
      width: 2, height: 1,
      data: new Uint8Array([0, 1]),
      depth: 8, channels: 1,
      palette: [[255, 0, 0], [0, 0, 255]],
      text: {},
    });
    expect(Array.from(px.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("零尺寸的图直接抛错,不产出一个 0 宽高的 Pixels", () => {
    expect(() => toRgba8({
      width: 0, height: 4, data: new Uint8Array(0), depth: 8, channels: 4, text: {},
    })).toThrow(/zero/i);
  });
});
