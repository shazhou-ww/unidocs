/**
 * 把 opentype.js 解析出来的字体适配成排版引擎需要的 `FontFace` 接口
 * （`font.ts`，上游、冻结，不改）。这是"排版 + 栅格化能用真实字体文件画字"
 * 这条链路的最后一块——`layout.ts`/`raster.ts` 全程只依赖 `FontFace`，
 * 完全不知道背后是 opentype.js。
 *
 * 零 IO：`parseFontFace` 只接受已经读好的字节，不碰网络、文件系统、DOM、
 * `canvas`，也不用任何 Node 内置模块——要同时跑在浏览器和 Cloudflare
 * Worker 里。
 */
import { Font, parse } from "opentype.js/dist/opentype.mjs";
import type { OpentypePathCommand } from "opentype.js/dist/opentype.mjs";
import type { FontFace, PathCommand } from "./font.js";

/**
 * 一套字体覆盖的码位范围：排好序、互不重叠、左闭右闭的区间数组
 * （`[start, end]`，`start <= end`，相邻区间已经合并）。Task 5 的字体索引
 * 用它决定"这套字体覆盖了哪些码位"，不需要真的加载字体字节就能做选字体的
 * 前置判断（见协调者裁定 R1：这个类型定义在这里，因为只有解析器知道怎么
 * 从 `cmap` 表读出覆盖范围）。
 */
export type FontCoverage = readonly (readonly [number, number])[];

/** `parseFontFace` 产出的 `FontFace` 实例 → 背后那个 opentype.js `Font` 对象
 *  的登记表。`fontCoverage` 需要读 `cmap` 表算覆盖范围，但那不在 `FontFace`
 *  接口里（`FontFace` 是上游冻结的接口，只有逐码位的 `has`，没有"枚举所有
 *  覆盖的码位"这种批量操作）——用 `WeakMap` 而不是把 `Font` 存成
 *  `OpentypeFontFace` 的公开字段，这样 `fontCoverage` 只能吃这个模块自己
 *  产出的 `FontFace`，别处手搭的假实现（比如测试用的 `fakeFace`）传进来
 *  会显式报错，而不是读到一个不存在的字段、默默返回错的空覆盖范围。 */
const backingFont = new WeakMap<FontFace, Font>();

class OpentypeFontFace implements FontFace {
  readonly postScriptName: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;

  /** 码位 → glyph index。`has`/`advance`/`outline`/`kerning` 都要查这张表，
   *  单独缓存一份，三个方法共享，不用各查各的。 */
  private readonly glyphIndexCache = new Map<number, number>();
  private readonly hasCache = new Map<number, boolean>();
  private readonly advanceCache = new Map<number, number>();
  private readonly outlineCache = new Map<number, readonly PathCommand[]>();

  constructor(private readonly font: Font) {
    this.unitsPerEm = font.unitsPerEm;
    this.ascender = font.ascender;
    this.descender = font.descender;
    // 真实字体总会有名字表；构造出来的字体（比如测试字体）理论上也总有，
    // 但接口要求 postScriptName 是 string 不是 string | undefined，给个空
    // 字符串兜底好过让下游意外拿到 undefined。
    this.postScriptName = font.getEnglishName("postScriptName") ?? "";
  }

  private glyphIndexOf(codePoint: number): number {
    const cached = this.glyphIndexCache.get(codePoint);
    if (cached !== undefined) return cached;
    // opentype.js 的 charToGlyphIndex 吃的是字符串（内部用 codePointAt(0)
    // 转回码位），不是数字——传数字它会在找 .codePointAt 时报错。
    const index = this.font.charToGlyphIndex(String.fromCodePoint(codePoint));
    this.glyphIndexCache.set(codePoint, index);
    return index;
  }

  has(codePoint: number): boolean {
    const cached = this.hasCache.get(codePoint);
    if (cached !== undefined) return cached;
    // glyph index 0 恒定是 .notdef，不是"这个码位真的有字形"。
    const result = this.glyphIndexOf(codePoint) > 0;
    this.hasCache.set(codePoint, result);
    return result;
  }

  advance(codePoint: number): number {
    const cached = this.advanceCache.get(codePoint);
    if (cached !== undefined) return cached;
    const index = this.glyphIndexOf(codePoint);
    // 查不到字形时退回 .notdef（index 0）的 advanceWidth，而不是抛异常：
    // layoutText 正常情况下不会对缺字的码位调用 advance（见 layout.ts 里
    // `if (!face) { missing.push(...); continue; }`——缺字直接跳过，根本
    // 不产生这个字形），这里只是防御性地不让"直接调用这个方法"这种非典型
    // 用法（比如测试）崩掉。
    const width = this.font.glyphs.get(index).advanceWidth;
    this.advanceCache.set(codePoint, width);
    return width;
  }

  kerning(left: number, right: number): number {
    // 没有按 pair 缓存：layoutText 对每一对相邻字形只查一次，不是"逐字形
    // 反复调用"的那种热点（brief 明确只点了 has/advance/outline 三个）。
    // 内部仍然复用了 glyphIndexCache，两次 charToGlyphIndex 查表本身是有
    // 缓存的。
    const leftIndex = this.glyphIndexOf(left);
    const rightIndex = this.glyphIndexOf(right);
    return this.font.getKerningValue(leftIndex, rightIndex);
  }

  outline(codePoint: number): readonly PathCommand[] {
    const cached = this.outlineCache.get(codePoint);
    if (cached !== undefined) return cached;
    const index = this.glyphIndexOf(codePoint);
    const glyph = this.font.glyphs.get(index);
    const commands = glyph.path.commands.map(translatePathCommand);
    this.outlineCache.set(codePoint, commands);
    return commands;
  }
}

/**
 * `glyph.path.commands`（原始轮廓，字体坐标系，y 轴向上，单位就是
 * font units）直接翻译成我们的 `PathCommand`——字段名逐一对应，两边都是
 * `{type:"M",x,y}` / `{type:"Q",x1,y1,x,y}` 这套形状。
 *
 * 判断：brief 原话建议"用 `glyph.getPath(0, 0, unitsPerEm)` 再把命令翻成
 * 我们的 `PathCommand`"，但实测 `getPath` 是为画布画字准备的，会把 y 取负
 * （见它内部 `y + -cmd.y * yScale` 这一段——canvas 坐标系 y 轴向下，取负是
 * 它自己的换向），且只有设置了描边（`stroke && strokeWidth`）才会补
 * 上收尾的 `Z`，纯填充轮廓会丢一个 `Z`。这两条都会跟我们"`outline()`
 * 直接是字体坐标系、y 轴向上"的契约对不上——照抄brief 的字面写法会产出
 * 上下翻转的轮廓。`glyph.path`（构造/解析都会把 `path.unitsPerEm` 设成
 * `font.unitsPerEm`，见 opentype.js 源码 `glyphset.js`）已经就是我们要的
 * 坐标系：不用再额外缩放，也不用翻符号，直接翻译字段名即可，还保留了原始
 * 的 `Z`。用生成测试字体的矩形做了实测验证（`glyph.path.commands` 与
 * `glyph.getPath(0,0,unitsPerEm).commands` 数值上只差一个 y 符号，符合这
 * 段推断）。
 */
function translatePathCommand(cmd: OpentypePathCommand): PathCommand {
  switch (cmd.type) {
    case "M":
      return { type: "M", x: cmd.x, y: cmd.y };
    case "L":
      return { type: "L", x: cmd.x, y: cmd.y };
    case "Q":
      return { type: "Q", x1: cmd.x1, y1: cmd.y1, x: cmd.x, y: cmd.y };
    case "C":
      return { type: "C", x1: cmd.x1, y1: cmd.y1, x2: cmd.x2, y2: cmd.y2, x: cmd.x, y: cmd.y };
    case "Z":
      return { type: "Z" };
  }
}

/**
 * 解析一份字体文件的字节，产出排版引擎能用的 `FontFace`。纯函数：只读传进
 * 来的字节，不做任何 IO。
 *
 * 直接把 `bytes` 这个 `Uint8Array` 传给 opentype 的 `parse`，不取
 * `bytes.buffer`——`bytes` 可能是更大 `ArrayBuffer` 上的一段视图（非零
 * `byteOffset`，或 `byteLength` 小于底层 buffer 的总长度），`.buffer` 会把
 * 视图之外的字节也带进去。opentype.js 接到非 `ArrayBuffer` 的输入时会走
 * `new Uint8Array(view).buffer` 这条拷贝构造路径，天然只取这个视图自己的
 * 那一段（见 `opentype-js.d.ts` 里 `parse` 的类型注释）。
 */
export function parseFontFace(bytes: Uint8Array): FontFace {
  const font = parse(bytes);
  const face = new OpentypeFontFace(font);
  backingFont.set(face, font);
  return face;
}

/**
 * 一套字体覆盖了哪些码位，供 Task 5 的字体索引用（不需要真的排版就能判断
 * "这套字体够不够用"）。
 *
 * 只接受 `parseFontFace` 在这个模块里产出的 `FontFace`——覆盖范围要读
 * `cmap` 表的 `glyphIndexMap`，那是 opentype.js 的内部结构，不在 `FontFace`
 * 这个抽象接口里，其他实现（比如测试用的假字体）没有对应的数据可读。传别
 * 处产出的 `FontFace` 进来会显式抛错，而不是静默返回一个错的空区间数组。
 */
export function fontCoverage(face: FontFace): FontCoverage {
  const font = backingFont.get(face);
  if (!font) {
    throw new Error("fontCoverage: face 必须是这个模块的 parseFontFace 产出的实例");
  }
  const glyphIndexMap = font.tables.cmap?.glyphIndexMap ?? {};
  const codePoints: number[] = [];
  for (const key in glyphIndexMap) {
    // glyphIndexMap 理论上只收录真的有字形的码位（index > 0），这里的
    // 过滤是防御性的——不信任这条不变量,免得万一某个字体真的把 .notdef
    // 塞进了 cmap，覆盖范围里混进一个假的"有字形"。
    if (glyphIndexMap[key] > 0) codePoints.push(Number(key));
  }
  codePoints.sort((a, b) => a - b);

  const intervals: [number, number][] = [];
  for (const codePoint of codePoints) {
    const last = intervals[intervals.length - 1];
    if (last && codePoint === last[1] + 1) {
      last[1] = codePoint;
    } else {
      intervals.push([codePoint, codePoint]);
    }
  }
  return intervals;
}
