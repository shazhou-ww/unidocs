/**
 * 排版测试用的假字体。不解析任何真实字体文件 —— 排版只依赖 `FontFace` 这层
 * 度量接口（`src/text/font.ts`），所以测试只需要能摆出确切数值的假实现。
 */
import type { FontFace, PathCommand } from "../src/text/font.js";

export interface FakeFaceOptions {
  postScriptName?: string;
  unitsPerEm?: number;
  ascender?: number;
  descender?: number;
  /** 每个字形的步进宽度，font units；同一套假字体里所有字形共用一个值。 */
  advance?: number;
  /** 字偶距表：key 是 `"<left codePoint>:<right codePoint>"`，值是 font units。 */
  kerning?: Record<string, number>;
  /** 这套字体不认识的码位（`has()` 返回 false）。缺省什么都认识。 */
  missing?: Iterable<number> | string;
  /** 每个码位的轮廓。缺省给一个占满 advance × unitsPerEm 的矩形，够算 ink bounds。 */
  outline?: (codePoint: number) => readonly PathCommand[];
}

export function fakeFace(opts: FakeFaceOptions = {}): FontFace {
  const unitsPerEm = opts.unitsPerEm ?? 1000;
  const advanceWidth = opts.advance ?? unitsPerEm;
  const missing = new Set<number>(
    typeof opts.missing === "string"
      ? Array.from(opts.missing).map(ch => ch.codePointAt(0)!)
      : opts.missing ?? [],
  );
  const kerningTable = opts.kerning ?? {};
  return {
    postScriptName: opts.postScriptName ?? "FakeFace",
    unitsPerEm,
    ascender: opts.ascender ?? Math.round(unitsPerEm * 0.8),
    descender: opts.descender ?? -Math.round(unitsPerEm * 0.2),
    has: cp => !missing.has(cp),
    advance: () => advanceWidth,
    kerning: (l, r) => kerningTable[`${l}:${r}`] ?? 0,
    outline: cp =>
      opts.outline?.(cp) ?? [
        { type: "M", x: 0, y: 0 },
        { type: "L", x: advanceWidth, y: 0 },
        { type: "L", x: advanceWidth, y: unitsPerEm },
        { type: "L", x: 0, y: unitsPerEm },
        { type: "Z" },
      ],
  };
}
