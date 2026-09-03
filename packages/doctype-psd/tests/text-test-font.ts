/**
 * 给 `text-opentype-face.test.ts` 用的测试字体：不提交任何第三方字体二进制
 * 到仓库,也不依赖系统字体（CI 上没有 `/System/Library/Fonts` 这类路径）。
 * 用 opentype.js 自己的构造 API（`Font`/`Glyph`/`Path`）在内存里现造一套
 * 字形已知的字体——度量是我们自己指定的,断言才有意义。
 */
import { Font, Glyph, Path } from "opentype.js/dist/opentype.mjs";

const UNITS_PER_EM = 1000;
const ASCENDER = 800;
const DESCENDER = -200;

interface RectGlyphSpec {
  /** 单个字符,用它的码位当这个字形的 unicode。 */
  char: string;
  /** 矩形轮廓的宽/高,font units。 */
  width: number;
  height: number;
  /** 步进宽度,font units。 */
  advanceWidth: number;
}

/** 造一个填满 `[0,width] x [0,height]`（font units,y 轴向上）的实心矩形
 *  字形,轮廓命令是 M → L → L → L → Z。 */
function rectGlyph(spec: RectGlyphSpec): Glyph {
  const path = new Path();
  path.moveTo(0, 0);
  path.lineTo(spec.width, 0);
  path.lineTo(spec.width, spec.height);
  path.lineTo(0, spec.height);
  path.close();
  return new Glyph({
    name: spec.char,
    unicode: spec.char.codePointAt(0),
    advanceWidth: spec.advanceWidth,
    path,
  });
}

/** 把一串矩形字形规格拼成一份可以被 `parseFontFace` 解析的字体文件字节。
 *  `.notdef` 必须显式给 advanceWidth——opentype.js 序列化时会检查每个字形
 *  的 advanceWidth 是不是数字,不给会在 `toArrayBuffer()` 时直接抛错。 */
export function buildRectFont(specs: readonly RectGlyphSpec[]): Uint8Array {
  const notdef = new Glyph({ name: ".notdef", advanceWidth: 0, path: new Path() });
  const font = new Font({
    familyName: "UnidocsTestFont",
    styleName: "Regular",
    unitsPerEm: UNITS_PER_EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs: [notdef, ...specs.map(rectGlyph)],
  });
  return new Uint8Array(font.toArrayBuffer());
}

/**
 * 一套只有 A/B 两个字形的字体（task-4-brief.md Step 2）。
 *
 * A 是 500x700 的实心矩形,advance 600——宽度（500）故意不等于 advance
 * （600）,逼实现老老实实读 `glyph.advanceWidth`,而不是从轮廓包围盒的宽度
 * 反推 advance（这两个数字凑巧相等的话,这个 bug 不会被测出来）。
 *
 * B 是 300x400 的实心矩形,advance 650——形状和 advance 都跟 A 不一样,用来
 * 验证按码位缓存不会把两个字形的结果串错（`has`/`advance`/`outline` 各自
 * 是一张 `Map<codePoint, …>`,如果实现手滑把 key 写死或者共用了一个缓存槽,
 * A、B 的结果会互相污染,这里给的两组不同的数值就是让这种串号能被测出来）。
 */
export function buildTestFont(): Uint8Array {
  return buildRectFont([
    { char: "A", width: 500, height: 700, advanceWidth: 600 },
    { char: "B", width: 300, height: 400, advanceWidth: 650 },
  ]);
}

/**
 * 专给 Step 7 端到端测试用的另一套字体：只有一个字形 "A",矩形宽度
 * **等于** advance（600x700,advance 600）,轮廓不留左右侧空隙。
 *
 * 这跟 `buildTestFont()` 的设计目的是矛盾的：`buildTestFont()` 故意让宽度
 * ≠ advance,为的是测出"advance 有没有从包围盒瞎猜"；而端到端测试要断言
 * "N 个字符排成一行,墨迹总宽度精确等于 N × advance/unitsPerEm × size",这
 * 个等式只有在每个字形的墨迹恰好占满自己的整个步进宽度（没有左右侧
 * bearing 空隙）时才成立——连续摆放的矩形才会首尾相接、中间不留缝。两个
 * 目的没法用同一套字体同时满足,所以要两个构造函数。
 */
export function buildGaplessTestFont(): Uint8Array {
  return buildRectFont([{ char: "A", width: 600, height: 700, advanceWidth: 600 }]);
}

/** 两个字形离得很远的码位（'A' = 0x41,'中' = 0x4E2D）,用来验证
 *  `fontCoverage` 不会把不相邻的码位错误合并成一个区间。 */
export function buildSparseCoverageTestFont(): Uint8Array {
  return buildRectFont([
    { char: "A", width: 500, height: 700, advanceWidth: 600 },
    { char: "中", width: 500, height: 700, advanceWidth: 600 },
  ]);
}
