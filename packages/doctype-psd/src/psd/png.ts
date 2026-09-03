import { convertIndexedToRgb, type DecodedPng } from "fast-png";
import type { Pixels } from "../model/types.js";

/**
 * 把 `fast-png` 的解码结果归一化成本模型唯一认的像素形状:RGBA、每分量 8 位。
 *
 * PNG 的通道数(1/2/3/4)、位深(1/2/4/8/16)、调色板是正交的几个维度,组合起来
 * 有十几种;`Pixels` 只有一种。归一化必须在**进入模型之前**做完,否则每个读
 * `pixels.data` 的地方都要重新判断一遍通道语义。
 *
 * 位深 1/2/4 不用单独处理:`fast-png` 在 `decode` 里已经展开成每分量一字节
 * (调色板图除外,那条走 `convertIndexedToRgb`)。
 */
export function toRgba8(decoded: DecodedPng): Pixels {
  const { width, height } = decoded;
  // 0 宽或 0 高的 PNG 是合法字节但不是能编辑的文档。在这里拦住,而不是让它
  // 一路走到 `save()` 里被 ag-psd 以 `Invalid document size` 拒绝——那时错误
  // 已经离现场很远了。
  if (width === 0 || height === 0) {
    throw new Error(`PNG has zero extent (${width}x${height})`);
  }

  const out = new Uint8ClampedArray(width * height * 4);

  // 调色板图:下标 -> 调色板项。`convertIndexedToRgb` 负责按位深拆下标,
  // 返回每像素 palette[0].length 个分量(通常 3)。
  if (decoded.palette) {
    const rgb = convertIndexedToRgb(decoded);
    const stride = decoded.palette[0]?.length ?? 3;
    for (let i = 0, o = 0; o < out.length; i += stride, o += 4) {
      out[o] = rgb[i]!;
      out[o + 1] = rgb[i + 1]!;
      out[o + 2] = rgb[i + 2]!;
      // tRNS(透明调色板)本期不处理,alpha 一律不透明——见 spec 的非目标。
      out[o + 3] = stride >= 4 ? rgb[i + 3]! : 255;
    }
    return { width, height, data: out };
  }

  const { data, channels } = decoded;
  // 16 位右移 8 位取高字节。这是有损的,但 `Pixels` 就是 8 位模型;
  // 四舍五入并不会更"对",只会让往返测试更难写。
  const shift = decoded.depth === 16 ? 8 : 0;
  const at = (i: number): number => (data[i]! as number) >> shift;

  for (let p = 0, o = 0; o < out.length; p += channels, o += 4) {
    switch (channels) {
      case 1: // 灰度
        out[o] = out[o + 1] = out[o + 2] = at(p);
        out[o + 3] = 255;
        break;
      case 2: // 灰度 + alpha
        out[o] = out[o + 1] = out[o + 2] = at(p);
        out[o + 3] = at(p + 1);
        break;
      case 3: // RGB
        out[o] = at(p); out[o + 1] = at(p + 1); out[o + 2] = at(p + 2);
        out[o + 3] = 255;
        break;
      case 4: // RGBA
        out[o] = at(p); out[o + 1] = at(p + 1);
        out[o + 2] = at(p + 2); out[o + 3] = at(p + 3);
        break;
      default:
        throw new Error(`unsupported PNG channel count: ${channels}`);
    }
  }
  return { width, height, data: out };
}
