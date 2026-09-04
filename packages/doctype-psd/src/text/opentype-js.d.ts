/**
 * `opentype.js@2.0.0` 不带类型声明，`@types/opentype.js` 最新只到 1.3.10（对
 * 应 1.x 的 API，v2 做过重写，直接用会文不对题）。这里只写这个模块实际用到
 * 的那一小片 API 的最小类型声明，不追求覆盖 opentype.js 的全部能力。
 *
 * 必须从 ESM 子路径引，不能写裸的 `"opentype.js"`——那个包的 `main`/`browser`
 * 字段指向 CJS 构建，具名导入在这个仓库的模块解析下会失败（`parse` 之类的
 * 具名导出找不到）；`module` 字段指向的 `dist/opentype.mjs` 才是真正的 ESM
 * 入口。这个包的 `package.json` 没有 `exports` 字段，所以按子路径直接引用
 * 不受限——Node、Vite/vitest 的模块解析都会把它当成包内的一个具体文件，
 * 与 `main`/`browser`/`module` 字段选择无关，浏览器和 Cloudflare Worker 两
 * 种运行时下行为一致。
 */
declare module "opentype.js/dist/opentype.mjs" {
  export type OpentypePathCommand =
    | { type: "M"; x: number; y: number }
    | { type: "L"; x: number; y: number }
    | { type: "Q"; x1: number; y1: number; x: number; y: number }
    | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: "Z" };

  export class Path {
    commands: OpentypePathCommand[];
    unitsPerEm?: number;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    close(): void;
  }

  export interface GlyphConstructorOptions {
    name?: string | null;
    unicode?: number;
    unicodes?: number[];
    advanceWidth?: number;
    path?: Path;
    index?: number;
  }

  export class Glyph {
    constructor(options: GlyphConstructorOptions);
    readonly index: number;
    readonly name: string | null;
    readonly unicode: number | undefined;
    readonly advanceWidth: number;
    readonly path: Path;
  }

  export class GlyphSet {
    readonly length: number;
    get(index: number): Glyph;
  }

  export interface FontConstructorOptions {
    familyName: string;
    styleName: string;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs?: readonly Glyph[];
  }

  export interface CmapTable {
    /** 码位（十进制字符串 key）→ glyph index。只有真正有字形的码位才在这里。 */
    glyphIndexMap: Record<string, number>;
  }

  export class Font {
    constructor(options: FontConstructorOptions);
    readonly unitsPerEm: number;
    readonly ascender: number;
    readonly descender: number;
    readonly numGlyphs: number;
    readonly glyphs: GlyphSet;
    readonly tables: { cmap?: CmapTable; [key: string]: unknown };
    charToGlyphIndex(s: string): number;
    getKerningValue(leftGlyph: number, rightGlyph: number): number;
    getEnglishName(name: string): string | undefined;
    toArrayBuffer(): ArrayBuffer;
  }

  /**
   * 接受 `ArrayBuffer` 或 `Uint8Array`——传 `Uint8Array` 时内部走
   * `new Uint8Array(view)` 这条拷贝构造路径，会正确按这个视图自己的
   * `byteOffset`/`byteLength` 取数据，不会把它背后更大的 `ArrayBuffer` 整个
   * 带进来（源码 `parseBuffer` 里 `buffer.constructor !== ArrayBuffer` 分支，
   * 已用探针验证过）。
   */
  export function parse(buffer: ArrayBuffer | Uint8Array): Font;
}
