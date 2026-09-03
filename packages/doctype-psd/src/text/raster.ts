/**
 * 把排版好的字形（`PlacedGlyph`，见 `layout.ts`）栅格化成 RGBA 像素。
 *
 * 纯函数，不碰 DOM、不碰 `canvas`、不碰任何 Node 内置模块 —— 这份代码要同时
 * 跑在浏览器和 Cloudflare Worker 里。算法（扫描线填充 + 非零环绕 + 子扫描线
 * 抗锯齿）借鉴自定方案时验证过的探针脚本（见
 * `.superpowers/sdd/2026-09-03-psd-text-edit/task-3-spike-reference.mjs`：
 * 922×126 两行文字排版加栅格化合计 31ms），但这里补上了类型、`PlacedGlyph`
 * 的坐标换算、画布外裁剪，不是照抄。
 *
 * 坐标换算（必须和 `layout.ts` 的 `computeInkBounds` 同一口径，否则字会被
 * 裁掉）：字体坐标系 y 轴向上，文档坐标系 y 轴向下，取轮廓点时 y 要取负；
 * 缩放系数是 `size / face.unitsPerEm`，再分别乘 `horizontalScale` /
 * `verticalScale`。`origin` 是画布左上角在（与 `PlacedGlyph.x/y` 同一套、
 * 相对锚点的）文档坐标系里的位置——每个字形的位置先减去 `origin` 再变换。
 */
import type { PathCommand } from "./font.js";
import type { PlacedGlyph } from "./layout.js";
import type { Pixels } from "../model/types.js";

/** 贝塞尔曲线拍平成折线的固定步数。与 spike 一致——够平滑，成本也可预测
 *  （不像自适应细分那样得处理退化/振荡输入）。 */
const CURVE_STEPS = 12;

/** 每像素行的子扫描线数，用于垂直方向抗锯齿。水平方向用精确的分数覆盖，
 *  不需要超采样。 */
const SUB = 5;

/** 折线点：`[x, y]`，已经在目标像素坐标系里（不是 font units）。 */
type Point = readonly [number, number];
/** 一个字形的一个轮廓子路径（闭合多边形），拍平之后的点序列。 */
type Polygon = readonly Point[];

/**
 * 把一个字形的轮廓命令（font units，y 轴向上）变换到画布像素坐标系
 * （y 轴向下，已经减去 `origin`），曲线仍是曲线命令——拍平在 `flatten` 里
 * 单独做，这样两步各自职责单一、方便分别测试/调试。
 */
function toCanvasCommands(glyph: PlacedGlyph, origin: { x: number; y: number }): PathCommand[] {
  const scale = glyph.size / glyph.face.unitsPerEm;
  const sx = scale * glyph.horizontalScale;
  const sy = scale * glyph.verticalScale;
  const ox = glyph.x - origin.x;
  const oy = glyph.y - origin.y;
  const tx = (fx: number): number => ox + fx * sx;
  // font units 的 y 轴向上，画布 y 轴向下——取负号完成换向（与
  // layout.ts 的 computeInkBounds 同一口径）。
  const ty = (fy: number): number => oy - fy * sy;

  const commands = glyph.face.outline(glyph.codePoint);
  const out: PathCommand[] = new Array(commands.length);
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    switch (c.type) {
      case "M":
        out[i] = { type: "M", x: tx(c.x), y: ty(c.y) };
        break;
      case "L":
        out[i] = { type: "L", x: tx(c.x), y: ty(c.y) };
        break;
      case "Q":
        out[i] = { type: "Q", x1: tx(c.x1), y1: ty(c.y1), x: tx(c.x), y: ty(c.y) };
        break;
      case "C":
        out[i] = {
          type: "C",
          x1: tx(c.x1),
          y1: ty(c.y1),
          x2: tx(c.x2),
          y2: ty(c.y2),
          x: tx(c.x),
          y: ty(c.y),
        };
        break;
      case "Z":
        out[i] = { type: "Z" };
        break;
    }
  }
  return out;
}

/** 把轮廓命令拍平成折线。曲线（Q/C）按固定步数细分成线段。每个 `M` 开一个
 *  新子路径，`Z`（或下一个 `M`、或命令序列末尾）收尾。子路径本身当作隐式
 *  闭合处理（`fillCoverage` 里首尾相连），所以末尾有没有显式 `Z` 不影响
 *  结果——真实字体轮廓总是闭合的，这里只是不因为一个漏掉的 `Z` 而丢内容。 */
function flatten(commands: readonly PathCommand[], steps: number): Polygon[] {
  const polys: Point[][] = [];
  let cur: Point[] | null = null;
  let x = 0;
  let y = 0;

  const push = (px: number, py: number): void => {
    if (!cur) cur = [];
    cur.push([px, py]);
  };

  for (const c of commands) {
    switch (c.type) {
      case "M":
        if (cur && cur.length > 0) polys.push(cur);
        cur = [];
        x = c.x;
        y = c.y;
        push(x, y);
        break;
      case "L":
        x = c.x;
        y = c.y;
        push(x, y);
        break;
      case "Q": {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
        }
        x = c.x;
        y = c.y;
        break;
      }
      case "C": {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          push(
            u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          );
        }
        x = c.x;
        y = c.y;
        break;
      }
      case "Z":
        if (cur && cur.length > 0) polys.push(cur);
        cur = null;
        break;
    }
  }
  if (cur && cur.length > 0) polys.push(cur);
  return polys;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: 1 | -1;
}

/**
 * 扫描线填充，非零环绕。每像素行取 `SUB` 条子扫描线做垂直方向抗锯齿，水平
 * 方向用精确的分数覆盖（span 两端各算一次部分覆盖），不做超采样。
 *
 * 返回的覆盖率数组按行主序排列（`row * w + col`），值域理论上是 [0, 1]（同
 * 一像素被多条子扫描线、多个 span 累加，调用方需要自己 clamp）。
 */
function fillCoverage(polys: readonly Polygon[], w: number, h: number): Float32Array {
  const cov = new Float32Array(Math.max(0, w) * Math.max(0, h));
  if (w <= 0 || h <= 0) return cov;

  const edges: Edge[] = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[(i + 1) % p.length];
      if (y0 !== y1) edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
    }
  }
  if (edges.length === 0) return cov;

  const xs: { x: number; dir: 1 | -1 }[] = [];
  for (let py = 0; py < h; py++) {
    const row = py * w;
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB;
      xs.length = 0;
      for (const e of edges) {
        const lo = Math.min(e.y0, e.y1);
        const hi = Math.max(e.y0, e.y1);
        if (sy < lo || sy >= hi) continue;
        xs.push({ x: e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), dir: e.dir });
      }
      if (xs.length === 0) continue;
      xs.sort((a, b) => a.x - b.x);

      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].dir;
        if (wind === 0) continue; // 非零环绕：只有环绕数非零的区间才算内部。
        const xa = Math.max(0, xs[i].x);
        const xb = Math.min(w, xs[i + 1].x);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        if (ia === ib) {
          cov[row + ia] += (xb - xa) / SUB;
          continue;
        }
        cov[row + ia] += (ia + 1 - xa) / SUB;
        for (let px = ia + 1; px < ib; px++) cov[row + px] += 1 / SUB;
        if (ib < w) cov[row + ib] += (xb - ib) / SUB;
      }
    }
  }
  return cov;
}

/** 一个字形拍平之后的轴对齐包围盒——用来判断它是否与画布相交，完全在画布
 *  外的字形可以直接跳过（既省了一次 `fillCoverage` 的整幅扫描，也是“不越
 *  界写”这条约束天然成立的原因：`fillCoverage` 本身按 `[0,w)x[0,h)` 扫描，
 *  永远不会碰画布之外的下标，这里的包围盒裁剪纯粹是性能优化）。 */
function boundsOf(polys: readonly Polygon[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let touched = false;
  for (const poly of polys) {
    for (const [px, py] of poly) {
      touched = true;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  return touched ? { minX, minY, maxX, maxY } : null;
}

/**
 * 逐字形算覆盖率，按各自的 `color` 用标准 alpha-over 合成进 RGBA。字形按
 * 数组顺序画（后面的盖在前面的上面），每个字形内部的多个轮廓子路径共用一次
 * `fillCoverage`（非零环绕规则要求同一字形的所有子路径一起算，否则镂空
 * （如 "O" 的内圈）算不出来）；不同字形之间**不**共享覆盖率数组，即便颜色
 * 相同——两个字形的轮廓在扫描线算法看来会被当成同一个形状的两个子路径，
 * 相交或反向环绕时会算错（比如两个同向重叠的字形，环绕数会变成 2，非零
 * 环绕下依然是“内部”，结果不影响；但如果方向相反就会互相抵消出洞——这是
 * 真实存在的风险，所以必须分开算）。
 */
export function rasterizeGlyphs(
  glyphs: readonly PlacedGlyph[],
  width: number,
  height: number,
  origin: { x: number; y: number },
): Pixels {
  const w = Math.max(0, Math.trunc(width));
  const h = Math.max(0, Math.trunc(height));
  const data = new Uint8ClampedArray(w * h * 4);

  for (const glyph of glyphs) {
    const commands = toCanvasCommands(glyph, origin);
    const polys = flatten(commands, CURVE_STEPS);
    if (polys.length === 0) continue;

    const bounds = boundsOf(polys);
    if (!bounds) continue;
    // 完全在画布外：不相交就跳过，既是性能优化也保证不会碰到越界下标。
    if (bounds.maxX <= 0 || bounds.maxY <= 0 || bounds.minX >= w || bounds.minY >= h) continue;

    const cov = fillCoverage(polys, w, h);
    const { r, g, b } = glyph.color;
    for (let i = 0; i < w * h; i++) {
      const a = Math.min(1, cov[i]);
      if (a <= 0) continue;
      const o = i * 4;
      const ia = data[o + 3] / 255;
      const na = a + ia * (1 - a);
      data[o] = (r * a + data[o] * ia * (1 - a)) / na;
      data[o + 1] = (g * a + data[o + 1] * ia * (1 - a)) / na;
      data[o + 2] = (b * a + data[o + 2] * ia * (1 - a)) / na;
      data[o + 3] = na * 255;
    }
  }

  return { width: w, height: h, data };
}
