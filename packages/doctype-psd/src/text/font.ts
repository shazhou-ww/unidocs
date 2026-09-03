/**
 * 排版引擎需要的字体度量接口。
 *
 * `layoutText`（见 `layout.ts`）只依赖这里的度量，不依赖任何具体的字体解析
 * 库 —— 这样它能用假字体（`tests/text-fake-face.ts`）完整单测，opentype.js
 * 到 Task 4（真正解析字体文件）才出现。同一份排版代码要同时跑在浏览器和
 * Cloudflare Worker 里，提前把"解析字体"和"用字体度量排版"这两件事切开，
 * 排版这一半就不用管 Node/DOM 环境差异。
 */

/** 字体坐标系里的轮廓命令，y 轴向上，单位是 font units。 */
export type PathCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "Q"; x1: number; y1: number; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Z" };

export interface FontFace {
  readonly postScriptName: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  /** 这个码位有没有字形。逐字符回退靠它。 */
  has(codePoint: number): boolean;
  /** 步进宽度，font units。 */
  advance(codePoint: number): number;
  /** 字偶距，font units；没有就是 0。 */
  kerning(left: number, right: number): number;
  outline(codePoint: number): readonly PathCommand[];
}

/**
 * 按码位挑字体。**逐字符**，不是逐 run —— 一个 run 里完全可能中英混排，
 * 选一套覆盖不了（设计文档 §3.4）。返回 null 表示整条回退链都没有这个字。
 *
 * 裁定 R2：这是**同步**函数。装载字体是异步 IO，由上层（effect 工具）先做
 * 完，把已经装载好的 `FontFace` 交给排版；`layoutText` 内部绝不做任何异步
 * 或 IO，纯函数才能被完整单测覆盖，也才能安全地跑在两种运行时里。
 */
export type FaceResolver = (codePoint: number, requestedFont: string | undefined) => FontFace | null;
