import type { Pixels } from "../model/types.js";
import type { Coverage } from "./editor.js";

/**
 * 哨兵底色。指令式编辑模型吃 RGB 吐 RGB，图层的 alpha 一定会丢；实测
 * qwen-image-edit-plus 把透明区合成到了黑底，于是"透明"和"纯黑内容"
 * 再也分不开。
 *
 * 办法是先把透明区合成到一个**图里几乎不会出现的颜色**上，模型改完之后
 * 再把接近这个颜色的像素判回透明 —— 相当于把 alpha 临时编码进色彩通道。
 * 纯品红是常用选择：自然照片里极少出现，与肤色/天空/植被都离得远。
 */
export const SENTINEL = { r: 255, g: 0, b: 255 } as const;

/** recoverAlpha 判定"这是哨兵色"的默认曼哈顿容差。模型的重采样会让哨兵色糊掉几个灰阶。 */
const SENTINEL_TOLERANCE = 24;

/** diffMask 默认阈值。实测 qwen 未编辑区色偏 < 2 灰阶，16 留了 8 倍余量。 */
const DIFF_THRESHOLD = 16;

/** 改动面积超过这个比例就认为蒙版不可信（水印模型会让全图都在变）。 */
const MAX_CHANGED_FRACTION = 0.9;

/** RGBA 源 → 不透明 RGBA，透明处露出哨兵色。alpha 一律 255。 */
export function compositeOnSentinel(src: Pixels): Pixels {
  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    out[i] = src.data[i] * a + SENTINEL.r * (1 - a);
    out[i + 1] = src.data[i + 1] * a + SENTINEL.g * (1 - a);
    out[i + 2] = src.data[i + 2] * a + SENTINEL.b * (1 - a);
    out[i + 3] = 255;
  }
  return { width: src.width, height: src.height, data: out };
}

/**
 * `compositeOnSentinel` 的逆运算:已知 alpha 时,把哨兵底色从 RGB 里除掉。
 *
 * 合成是线性的 —— `P = a·C + (1−a)·S` —— 所以只要 `a` 已知,内容色就能解出来:
 * `C = (P − (1−a)·S) / a`。
 *
 * **不做这一步就等于把品红留在图里。** 实测一张 900x240 的抗锯齿文字层空跑
 * 一趟(合成到哨兵再把源的 alpha 装回去,中间不调模型),4347 个抗锯齿边缘
 * 像素的平均色差是 61.46 —— 每一个字的边都镶着一圈品红。做完逆运算是 2.16,
 * 余下的就是 8bit 量化。
 *
 * 源不透明时 `a=1`,这是个恒等变换 —— 照片层一个像素都不会变。
 *
 * `a=0` 的像素没有内容色可解(它们**全部**是哨兵),原样留着 RGB 并把 alpha
 * 记为 0;调用方要么按源的 alpha 把它们裁掉,要么根本不看它们。
 */
export function unmixSentinel(rgb: Pixels, alpha: Pixels): Pixels {
  const data = new Uint8ClampedArray(rgb.data);
  const s = [SENTINEL.r, SENTINEL.g, SENTINEL.b];
  for (let i = 0; i < data.length; i += 4) {
    const a = alpha.data[i + 3] / 255;
    if (a === 0) { data[i + 3] = 0; continue; }
    // Uint8ClampedArray 自己会把解出来的值夹回 0..255 —— 模型把边缘画歪时
    // 除以一个很小的 a 会放大误差,夹住是对的,不是在掩盖问题。
    for (let c = 0; c < 3; c++) data[i + c] = (rgb.data[i + c] - (1 - a) * s[c]) / a;
    data[i + 3] = alpha.data[i + 3];
  }
  return { width: rgb.width, height: rgb.height, data };
}

/** 接近哨兵色的像素判回透明。其余保持不透明。 */
export function recoverAlpha(after: Pixels, tolerance: number = SENTINEL_TOLERANCE): Pixels {
  const out = new Uint8ClampedArray(after.data);
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.abs(out[i] - SENTINEL.r)
      + Math.abs(out[i + 1] - SENTINEL.g)
      + Math.abs(out[i + 2] - SENTINEL.b);
    out[i + 3] = d <= tolerance ? 0 : 255;
  }
  return { width: after.width, height: after.height, data: out };
}

/** 双线性重采样。放大缩小都走同一条路，尺寸相同则原样返回。 */
export function resample(src: Pixels, width: number, height: number): Pixels {
  if (width === src.width && height === src.height) {
    return { width, height, data: new Uint8ClampedArray(src.data) };
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p01 = src.data[(y0 * src.width + x1) * 4 + c];
        const p10 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        out[o + c] = p00 * (1 - wx) * (1 - wy) + p01 * wx * (1 - wy)
          + p10 * (1 - wx) * wy + p11 * wx * wy;
      }
    }
  }
  return { width, height, data: out };
}

/** 等比缩放到像素数落进 [min, max]。边长永远 >= 1。 */
export function fitPixelBudget(
  w: number, h: number, min: number, max: number,
): { width: number; height: number } {
  const n = w * h;
  if (n > max) {
    // 缩小：两边都向下取整，避免各自独立四舍五入把乘积重新推过上限。
    const scale = Math.sqrt(max / n);
    return {
      width: Math.max(1, Math.floor(w * scale)),
      height: Math.max(1, Math.floor(h * scale)),
    };
  }
  if (n < min) {
    // 放大：两边都向上取整，确保乘积不会因为取整而掉回下限以下。
    const scale = Math.sqrt(min / n);
    return {
      width: Math.max(1, Math.ceil(w * scale)),
      height: Math.max(1, Math.ceil(h * scale)),
    };
  }
  return { width: w, height: h };
}

/**
 * 前后像素差异反推蒙版。任一通道（含 alpha）差值超过阈值就算改过。
 *
 * 返回 null 表示不可信：改动面积过大，说明模型重画了整张图（或加了隐形
 * 水印），这时蒙版起不到"把色偏关在小区域里"的作用，调用方应降级整层替换。
 */
export function diffMask(
  before: Pixels,
  after: Pixels,
  opts: { threshold?: number; maxChangedFraction?: number } = {},
): Coverage | null {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `diffMask: size mismatch ${before.width}x${before.height} vs ${after.width}x${after.height}`,
    );
  }
  const threshold = opts.threshold ?? DIFF_THRESHOLD;
  const maxFraction = opts.maxChangedFraction ?? MAX_CHANGED_FRACTION;
  const n = before.width * before.height;
  const data = new Uint8ClampedArray(n);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(before.data[o] - after.data[o]),
      Math.abs(before.data[o + 1] - after.data[o + 1]),
      Math.abs(before.data[o + 2] - after.data[o + 2]),
      Math.abs(before.data[o + 3] - after.data[o + 3]),
    );
    if (d > threshold) { data[i] = 255; changed++; }
  }
  return changed / n > maxFraction ? null : { width: before.width, height: before.height, data };
}

/**
 * 膨胀 + 羽化。差异蒙版的边界是逐像素硬切的，直接拿去当图层蒙版会留下
 * 一圈锯齿缝；先向外推几像素盖住重采样毛边，再做一次盒糊化出过渡带。
 */
export function softenMask(cov: Coverage, opts: { dilate: number; feather: number }): Coverage {
  const { width, height } = cov;
  let data: Uint8ClampedArray = new Uint8ClampedArray(cov.data);
  for (let pass = 0; pass < opts.dilate; pass++) {
    const next = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1 && m < 255; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const v = data[yy * width + xx];
            if (v > m) m = v;
            if (m === 255) break;
          }
        }
        next[y * width + x] = m;
      }
    }
    data = next;
  }
  if (opts.feather > 0) {
    data = boxBlur(boxBlur(data, width, height, opts.feather), width, height, opts.feather);
  }
  return { width, height, data };
}

function boxBlur(src: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        sum += src[y * width + xx]; n++;
      }
      tmp[y * width + x] = sum / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        sum += tmp[yy * width + x]; n++;
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

/**
 * 把差异蒙版烘进图层自己的 alpha 通道。
 *
 * 为什么不做成一个真正的图层蒙版（Mask）：`Mask.pixels` 的类型是**驻留的**
 * `Pixels`（model/types.ts:17，注释明说合成器仍读 pixels），不接受 PixelRef。
 * 走 Mask 就意味着把一整张 RGBA 蒙版塞进 op —— 1600x1200 的层是 7.7 MB
 * 进 delta，每编辑一次涨一次。
 *
 * 烘进 alpha 视觉上完全等价：覆盖度为 0 的地方这一层全透明，下面的原层
 * 原样露出来，羽化过渡带也照样是过渡带。代价是在 Photoshop 里看到的是
 * "一个带透明区的图层"而不是"图层 + 蒙版"，蒙版本身不能单独再编辑。
 */
export function applyCoverageToAlpha(px: Pixels, cov: Coverage): Pixels {
  if (px.width !== cov.width || px.height !== cov.height) {
    throw new Error(
      `applyCoverageToAlpha: size mismatch ${px.width}x${px.height} vs ${cov.width}x${cov.height}`,
    );
  }
  const data = new Uint8ClampedArray(px.data);
  for (let i = 0; i < cov.data.length; i++) {
    // 与源自身的 alpha 相乘：源本来就半透明的地方不该被拉回不透明。
    data[i * 4 + 3] = (data[i * 4 + 3] * cov.data[i]) / 255;
  }
  return { width: px.width, height: px.height, data };
}
