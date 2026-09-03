/**
 * PSD 文字层的排版引擎：把 `LayerText` 变成一串已经定位好的字形
 * （`PlacedGlyph`），供 Task 3 的栅格化消费。
 *
 * 纯函数，不碰字体解析、不碰 IO —— 度量全部来自调用方给的 `FaceResolver`
 * （见 `font.ts` 的裁定 R2）。这样这份代码能同时跑在浏览器和 Cloudflare
 * Worker，也能用假字体完整单测（`tests/text-fake-face.ts`），不用等
 * opentype.js 接进来。
 *
 * 覆盖范围按设计文档 §4.2/§4.3：只做点文字、不做框文字换行、不做竖排、
 * 不做复杂文种塑形（阿拉伯语等）——按码位逐字形放置，拉丁文与水平书写的
 * 中日韩没问题。
 */
import type { LayerParagraphStyle, LayerText, LayerTextStyle } from "../model/types.js";
import type { FaceResolver, FontFace } from "./font.js";

/** ag-psd 读回来的 smallCapSize 默认值。small caps 的字号系数与它保持一致，
 *  不是我们自己拍的数。 */
export const SMALL_CAPS_RATIO = 0.7;

/** 没有 `style.size` 时的兜底字号，px。真实数据里 ag-psd 导入的文字层总会带
 *  `fontSize`（见 `psd/load.ts`），这里只是防止调用方给出不完整的样式时排版
 *  直接产出空字形。 */
const DEFAULT_FONT_SIZE = 12;

/** 没有 `leading` 时，行距是字号的这个倍数。 */
const DEFAULT_LEADING_RATIO = 1.2;

/** `layoutText` 会照常产出字形、但没有还原效果的样式名。固定顺序，方便断言。 */
const IGNORABLE_STYLE_NAMES = [
  "underline",
  "strikethrough",
  "strokeColor",
  "fauxBold",
  "fauxItalic",
  "ligatures",
] as const;

export interface PlacedGlyph {
  readonly codePoint: number;
  readonly face: FontFace;
  /** 基线原点，像素，相对锚点；y 轴向下（文档坐标系）。 */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly horizontalScale: number;
  readonly verticalScale: number;
  readonly color: { r: number; g: number; b: number };
}

export type LayoutResult =
  | {
      ok: true;
      glyphs: readonly PlacedGlyph[];
      /** 墨迹范围，像素，相对锚点。空文本时四个数都是 0。 */
      inkBounds: { left: number; top: number; right: number; bottom: number };
      /** 这次没有还原的样式名，报给 agent。 */
      ignored: readonly string[];
      /** 整条回退链都没有的码位。 */
      missing: readonly number[];
    }
  | { ok: false; reason: string };

/** 逐字符的样式 + 原始码位，caps 变换之前的中间结果。 */
interface CharStyle {
  codePoint: number;
  style: LayerTextStyle;
}

/** caps 变换之后、已经分好行的字形单元：一个源字符可能因为大小写变换（如
 *  `ß` → `SS`）展开成多个。 */
interface GlyphUnit {
  codePoint: number;
  style: LayerTextStyle;
  /** 已经套用 caps 系数之后的字号，px。 */
  effectiveSize: number;
}

export function layoutText(text: LayerText, resolveFace: FaceResolver): LayoutResult {
  const rejection = rejectionReason(text);
  if (rejection) return { ok: false, reason: rejection };

  const ignored = new Set<string>();
  const charStyles = resolveCharStyles(text);
  for (const { style } of charStyles) collectIgnored(style, ignored);

  const lines = splitIntoLines(charStyles);
  const justification = resolveJustification(text.paragraphStyle);

  const glyphs: PlacedGlyph[] = [];
  const missing: number[] = [];
  let cursorY = 0;

  for (const line of lines) {
    const lineGlyphs: PlacedGlyph[] = [];
    let cursorX = 0;
    let prevFace: FontFace | null = null;
    let prevCodePoint = 0;

    for (const unit of line) {
      const face = resolveFace(unit.codePoint, unit.style.font);
      if (!face) {
        missing.push(unit.codePoint);
        continue; // 缺字：不产生字形，也不占位（设计文档 §4.3：整条回退链都没有）。
      }

      const size = unit.effectiveSize;
      const horizontalScale = unit.style.horizontalScale ?? 1;
      const verticalScale = unit.style.verticalScale ?? 1;
      // autoKerning 与手工 kerning 互斥（不是叠加）：默认（未显式关掉）用字体
      // 自带的 kern 表；显式关掉之后改用 style.kerning 这个作者指定的手工值。
      const autoKerning = unit.style.autoKerning !== false;
      const hasPrevGlyph = prevFace !== null;

      if (hasPrevGlyph && autoKerning) {
        // 字体自带的 kern 表只在“相邻两个字形来自同一套字体”时才有意
        // 义——跨字体的两个 codePoint 对同一张表毫无意义，加了反而会把排版
        // 拉歪，所以额外要求 prevFace === face。
        if (prevFace === face) {
          const kern = face.kerning(prevCodePoint, unit.codePoint);
          cursorX += (kern / face.unitsPerEm) * size * horizontalScale;
        }
      } else if (hasPrevGlyph && !autoKerning) {
        // 手工覆盖值：作者在这两个字符之间显式指定的偏移，和字形来自哪套
        // 字体无关——即便前一个字形来自另一套字体（中英混排常见），这个
        // 偏移依然要生效，所以这里**不**检查 prevFace === face。单位和
        // tracking 一样是千分之一 em，所以换算公式也一样（不乘
        // horizontalScale，与 tracking 保持同样的口径）。
        const manualKerning = unit.style.kerning ?? 0;
        cursorX += (manualKerning / 1000) * size;
      }

      const color = unit.style.color ?? { r: 0, g: 0, b: 0 };
      lineGlyphs.push({
        codePoint: unit.codePoint,
        face,
        x: cursorX,
        y: cursorY + (unit.style.baselineShift ?? 0),
        size,
        horizontalScale,
        verticalScale,
        color,
      });

      const tracking = unit.style.tracking ?? 0;
      cursorX += (face.advance(unit.codePoint) / face.unitsPerEm) * size * horizontalScale;
      cursorX += (tracking / 1000) * size;

      prevFace = face;
      prevCodePoint = unit.codePoint;
    }

    const offset = justificationOffset(justification, cursorX);
    for (const g of lineGlyphs) glyphs.push({ ...g, x: g.x + offset });

    cursorY += lineLeading(line);
  }

  return { ok: true, glyphs, inkBounds: computeInkBounds(glyphs), ignored: [...ignored], missing };
}

/** 三种“拒绝重排”的情形（设计文档 §4.3）：框文字换行、竖排、结构性不可编辑。
 *  这些不是“凑合画一下”能补的——要么算不出正确的换行，要么坐标系整个不对。 */
function rejectionReason(text: LayerText): string | null {
  if (text.uneditable && text.uneditable.length > 0) {
    return `text.uneditable 非空（${text.uneditable.join(", ")}），这层文字来自我们复刻不了的 PSD 特性，只能贴烘焙像素`;
  }
  if (text.boxBounds) {
    return "text.boxBounds 存在（框文字换行），v1 排版引擎不做断行算法";
  }
  if (text.orientation === "vertical") {
    return "orientation === \"vertical\"（竖排文字），v1 排版引擎不支持";
  }
  return null;
}

/** 把 `content` 按 `runs[]` 的字符数切成“码位 → 样式”。没有 `runs` 就整串用
 *  `text.style`。按 UTF-16 码元对齐 run 边界（与 `runs.ts` 同一口径），但
 *  码位本身用 `codePointAt` 取——避免代理对被拆成两个非法码位传给字体。 */
function resolveCharStyles(text: LayerText): CharStyle[] {
  const content = text.content;
  const perUnit: LayerTextStyle[] = new Array(content.length);
  if (text.runs && text.runs.length > 0) {
    let i = 0;
    for (const run of text.runs) {
      for (let k = 0; k < run.length && i < content.length; k++) perUnit[i++] = run.style;
    }
    // runs 覆盖不满整串内容（上游数据本身有问题）时，剩下的字符兜底用空样式，
    // 好过直接崩掉——排版引擎不是校验 runs 完整性的地方，那是 Task 1 的事。
    for (; i < content.length; i++) perUnit[i] = {};
  } else {
    perUnit.fill(text.style ?? {});
  }

  const out: CharStyle[] = [];
  let i = 0;
  while (i < content.length) {
    const codePoint = content.codePointAt(i)!;
    out.push({ codePoint, style: perUnit[i] });
    i += codePoint > 0xffff ? 2 : 1;
  }
  return out;
}

const NEWLINE = 10; // "\n".codePointAt(0)

/**
 * caps 变换 + 按 `\n` 分行。这两件事必须放在一起做：大小写变换会改变字符数
 * （`ß` → `SS`），所以要在“字符 → 样式”切好之后逐字符做，让展开出来的每个
 * 字符都带着源字符的样式；换行符本身在变换前后都不产生字形。
 */
function splitIntoLines(chars: readonly CharStyle[]): GlyphUnit[][] {
  const lines: GlyphUnit[][] = [[]];
  for (const { codePoint, style } of chars) {
    if (codePoint === NEWLINE) {
      lines.push([]);
      continue;
    }
    const baseSize = style.size ?? DEFAULT_FONT_SIZE;
    if (style.caps === "all" || style.caps === "small") {
      const original = String.fromCodePoint(codePoint);
      const upper = original.toUpperCase();
      // small caps 的真实语义：只有“本来是小写、被这次变换转成大写”的字符才
      // 缩字号；本来就是大写（或没有大小写区分，如数字/中文）的字符维持原字
      // 号不变——`toUpperCase()` 前后不同就说明它被真的转换过。`caps: "all"`
      // 不受这条影响，恒定用原字号。
      const wasLowered = original !== upper;
      const effectiveSize = style.caps === "small" && wasLowered ? baseSize * SMALL_CAPS_RATIO : baseSize;
      for (const ch of upper) {
        lines[lines.length - 1].push({ codePoint: ch.codePointAt(0)!, style, effectiveSize });
      }
    } else {
      lines[lines.length - 1].push({ codePoint, style, effectiveSize: baseSize });
    }
  }
  return lines;
}

/** 一行的行距：取行内字符显式声明的 `leading` 的最大值；没有任何显式声明就
 *  用该行最大字号 × 1.2（设计文档 §4.2）。空行没有字符可看，退回一个空样式
 *  算出的默认值，好过整个排版因为一个空行崩掉。 */
function lineLeading(line: readonly GlyphUnit[]): number {
  if (line.length === 0) {
    return DEFAULT_FONT_SIZE * DEFAULT_LEADING_RATIO;
  }
  let max = 0;
  for (const unit of line) {
    const size = unit.style.size ?? DEFAULT_FONT_SIZE;
    const leading = unit.style.leading ?? size * DEFAULT_LEADING_RATIO;
    if (leading > max) max = leading;
  }
  return max;
}

type Justification = "left" | "right" | "center";

/** `justify-*` 只在有换行宽度约束时才有意义（把词间距撑满一行）——v1 不支持
 *  框文字，没有宽度可撑，所以按对应的锚点降级：`justify-left/right/center`
 *  等价于去掉前缀；`justify-all` 没有对应的锚点，退到 `left`。 */
function resolveJustification(paragraphStyle: LayerParagraphStyle | undefined): Justification {
  const raw = paragraphStyle?.justification ?? "left";
  switch (raw) {
    case "left":
    case "justify-left":
      return "left";
    case "right":
    case "justify-right":
      return "right";
    case "center":
    case "justify-center":
      return "center";
    case "justify-all":
      return "left";
    default:
      return "left";
  }
}

function justificationOffset(justification: Justification, lineWidth: number): number {
  switch (justification) {
    case "left": return 0;
    case "right": return -lineWidth;
    case "center": return -lineWidth / 2;
  }
}

function collectIgnored(style: LayerTextStyle, into: Set<string>): void {
  for (const name of IGNORABLE_STYLE_NAMES) {
    const value = style[name];
    if (value !== undefined && value !== false) into.add(name);
  }
}

/** 墨迹范围：所有字形轮廓命令的锚点/控制点，变换到文档坐标系（y 轴向下）后
 *  取并集。贝塞尔曲线落在控制点的凸包内，所以控制点的包围盒天然是曲线的一个
 *  合法（可能略大）包围盒——不需要为了精确解曲线极值。 */
function computeInkBounds(
  glyphs: readonly PlacedGlyph[],
): { left: number; top: number; right: number; bottom: number } {
  let left = 0, top = 0, right = 0, bottom = 0;
  let touched = false;
  for (const g of glyphs) {
    for (const cmd of g.face.outline(g.codePoint)) {
      const points = pathCommandPoints(cmd);
      for (const [fx, fy] of points) {
        const px = g.x + (fx / g.face.unitsPerEm) * g.size * g.horizontalScale;
        // font units 的 y 轴向上，文档坐标系 y 轴向下——取负号完成换向。
        const py = g.y - (fy / g.face.unitsPerEm) * g.size * g.verticalScale;
        if (!touched) {
          left = right = px;
          top = bottom = py;
          touched = true;
        } else {
          if (px < left) left = px;
          if (px > right) right = px;
          if (py < top) top = py;
          if (py > bottom) bottom = py;
        }
      }
    }
  }
  return { left, top, right, bottom };
}

function pathCommandPoints(
  cmd: import("./font.js").PathCommand,
): ReadonlyArray<readonly [number, number]> {
  switch (cmd.type) {
    case "M":
    case "L":
      return [[cmd.x, cmd.y]];
    case "Q":
      return [[cmd.x1, cmd.y1], [cmd.x, cmd.y]];
    case "C":
      return [[cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [cmd.x, cmd.y]];
    case "Z":
      return [];
  }
}
