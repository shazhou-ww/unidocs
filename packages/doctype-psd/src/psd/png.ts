import { convertIndexedToRgb, decode, encode, type DecodedPng } from "fast-png";
import type { Pixels, PsdDoc } from "../model/types.js";
import { render } from "../render/composite.js";

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

/**
 * 一张 PNG 变成一个单图层文档。
 *
 * 画布取图片尺寸,唯一那个图层铺满画布。图层 id 沿用 `psd/load.ts:298` 的
 * `l${i}_${name}` 形式——前端的选中和 ops 的 layerId 都按这个约定走,这里
 * 另起一套会让 PNG 打开的文档在图层操作上表现得跟 PSD 打开的不一样。
 */
export function pngToDoc(bytes: Uint8Array): PsdDoc {
  const pixels = toRgba8(decode(bytes));
  return {
    canvas: {
      width: pixels.width,
      height: pixels.height,
      colorMode: "RGB",
      depth: 8,
      // PNG 的 pHYs 是"每单位像素数",PSD 要的是 DPI,两者换算还要看单位
      // 是不是米。绝大多数 PNG 根本没有 pHYs,为一个基本读不到的值引入
      // 一套换算不值当——统一用 PSD 载入路径的同一个默认值(load.ts:340)。
      resolution: 72,
      profile: "sRGB",
    },
    layers: [{
      id: "l0_背景",
      type: "raster",
      name: "背景",
      bounds: [0, 0, pixels.height, pixels.width],
      opacity: 1,
      blendMode: "normal",
      visible: true,
      locked: false,
      clipping: false,
      pixels,
    }],
  };
}

/**
 * 文档展平成一张 PNG。
 *
 * 走的是 `render()` —— 和 PSD 导出内嵌的那张合成图**同一个函数**
 * (`psd/save.ts:108`)。这不是本期新建的约定,是既成事实;测试里有一条逐像素
 * 断言钉着它。
 *
 * 传进来的 doc 必须已经 `resolveDoc` 过(懒加载的 CAS 像素拉实),否则
 * `render` 读到的是 PixelRef 而不是字节。调用方负责——`doctype.ts` 里那行
 * 与 psd 的 save 完全对称。
 */
export async function docToPng(doc: PsdDoc): Promise<Uint8Array> {
  const composite = await render(doc);
  // 对称于 `toRgba8` 的导入侧守卫:一个空文档(`init()` 给出 0x0 画布)合成
  // 出的是 0x0 的 composite,`fast-png` 的 `encode()` 会拒绝它
  // (`width must be a positive integer`),报出来的错跟"文档是空的"这件事
  // 毫无关系。在这里拦住,报一个看得懂的错误。
  if (composite.width === 0 || composite.height === 0) {
    throw new Error(`PNG has zero extent (${composite.width}x${composite.height})`);
  }
  return encode({
    width: composite.width,
    height: composite.height,
    data: composite.data,
    channels: 4,
    depth: 8,
  });
}
