/**
 * `setText` —— 改文字层里的**字**的唯一入口。
 *
 * 在它之前，agent 想改一个文字层只能调 `editPixels` 让图像模型把那块像素
 * 重画一遍。模型画不对字：实测里 `WWW.YOURSITE.COM` 被画成了
 * `WWW.NOUCNIDE.COM`。文字层同时装着文字描述（`layer.text`）和 Photoshop
 * 烘好的位图（`layer.pixels`），既然描述在手上，就该改描述、自己排版、自己
 * 栅格化，而不是让一个猜像素的模型去猜字形。
 *
 * 为什么是 effect：排版链本身是纯的（`layout.ts` / `raster.ts` 都是纯函数），
 * 但**取字体字节**和**把栅格化结果写进 CAS** 是 IO，op handler 不许做。所以
 * 这里做完全部 IO，交出去的 `set_text` op 只带算好的值和一个 blob 引用，
 * `apply` 仍然是纯函数、确定性可重放。
 *
 * 编排顺序：取旧 text → 算改动区间、重切分 runs → 选字体并装载 → 排版 →
 * 栅格化 → 写 blob → 算新 bounds → 产出 op。
 */
import { encode } from "fast-png";
import type {
  AgentTool,
  EffectContext,
  EffectOutcome,
  JsonValue,
  SBlob,
  SValueType,
} from "@unidocs/protocol";
import type { FontRef, LayerParagraphStyle, LayerText, LayerTextStyle, Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { PsdQuery } from "../queries.js";
import type { FaceResolver, FontFace } from "./font.js";
import { layoutText } from "./layout.js";
import { parseFontFace } from "./opentype-face.js";
import { rasterizeGlyphs } from "./raster.js";
import type { FontEntry, FontIndex } from "./registry.js";
import { resolveFaceChain, selectFonts } from "./registry.js";
import { diffRange, spliceParagraphRuns, spliceTextRuns } from "./runs.js";

/**
 * `setText` 的字体来源。
 *
 * 拆成三块而不是直接收一个 `FontIndex`，是因为索引与字节是**分开存**的
 * （裁定 R29）：租户级的字体 DO 只存元数据（它拿不到 CAS 权限），字节留在
 * CAS，由跑在编辑会话里的这个 effect 去读。所以除了索引本身，还需要知道
 * 回退链的顺序，以及怎么把索引里的内容哈希变成一个能交给 `ctx.readBlob`
 * 的 SBlob。
 */
export interface FontIndexSource {
  /** 取一次可用字体的索引，按 postScriptName。异步：真实实现要打一次字体 DO。 */
  readonly load: () => Promise<FontIndex>;
  /** 回退链，按优先级。请求的字体缺席、或者它不认识某个码位时逐个试。 */
  readonly fallbacks: readonly string[];
  /** 索引条目 → 可以读的 SBlob。字节在哪儿、怎么建这个引用由来源方决定。 */
  readonly blobFor: (entry: FontEntry) => SBlob;
}

/** 这层像素的出处。**不是**一个模型的名字 —— 它就是要跟"Photoshop 烘的"和
 *  "生图模型画的"区分开：这些像素是本仓库的排版链自己排出来的。 */
const TEXT_RENDERER = "unidocs-text-layout";

const pixelsToPng = (px: Pixels): Uint8Array =>
  encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });

const fail = (structuredContent: JsonValue): EffectOutcome<PsdOp> =>
  ({ ops: [], result: { structuredContent } });

/** getDoc 返回值里我们要的那一层。 */
interface TextLayerInfo {
  id: string;
  type: string;
  text?: LayerText;
  bounds: [number, number, number, number];
}

/**
 * `ctx.query` 的返回值静态类型是 `SValue`，编译期什么都保证不了。照
 * `edit-pixels.ts` 的 `asLayerPixels` 手写一次运行时形状校验：形状不对是
 * **内部契约被破坏**，不是模型能改措辞绕开的失败，所以抛异常而不是 fail()。
 */
function asTextLayer(data: unknown, layerId: string): TextLayerInfo {
  const bad = (what: string): never => {
    throw new Error(`setText: getDoc returned an unexpected shape (${what})`);
  };
  const d = data as { layers?: unknown } | null;
  if (!d || typeof d !== "object") bad("not an object");
  // 即使只要一层，getDoc 返回的也是数组。
  const layers = d!.layers;
  if (!Array.isArray(layers)) bad("layers is not an array");
  const layer = (layers as unknown[])[0] as Record<string, unknown> | undefined;
  if (!layer || typeof layer !== "object") bad(`layers[0] missing for ${layerId}`);
  if (typeof layer!.type !== "string") bad("layer.type is not a string");
  const bounds = layer!.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(n => typeof n === "number")) {
    bad("layer.bounds is not four numbers");
  }
  return layer as unknown as TextLayerInfo;
}

/**
 * 一行（= 一段）的对齐方式决定改字之后哪条边不动，所以这里只关心**第一段**
 * 的对齐 —— 图层框是整层的，不可能一段一个位置。
 *
 * `justify-*` 的降级与 `layout.ts` 的 `normalizeJustification` 保持一致
 * （那个函数没有导出，而 Task 6 不改 layout.ts）：有宽度约束才谈得上撑满
 * 一行，v1 不支持框文字，所以按对应的锚点降级，`justify-all` 退到 `left`。
 * 两处必须同步 —— 排版把字按对齐方式摆好，这里再按同一个对齐方式给图层框
 * 定锚点，判据不一致的话字会整体平移。
 */
function anchorEdge(text: LayerText): "left" | "right" | "center" {
  const first = text.paragraphRuns?.[0]?.style ?? text.paragraphStyle;
  switch ((first as LayerParagraphStyle | undefined)?.justification ?? "left") {
    case "right":
    case "justify-right":
      return "right";
    case "center":
    case "justify-center":
      return "center";
    default:
      return "left";
  }
}

/** caps 变换之后的字符串。选字体必须按**展开之后**的码位查覆盖：`caps` 会
 *  把 `ß` 变成 `SS`、把小写变成大写（见 `layout.ts` 的 `splitIntoLines`），
 *  按原字符查会漏装一套字体，那些字排版时直接变成 `missing`。 */
const expandCaps = (s: string, caps: LayerTextStyle["caps"]): string =>
  caps === "all" || caps === "small" ? s.toUpperCase() : s;

/**
 * 把内容按"这段请求的是哪套字体"分组。
 *
 * 分组而不是"整串内容 × 每套请求字体"各查一遍，是为了不多装字体：一层中英
 * 混排的文字里，英文那段请求的字体没必要为了中文那段再拉一套中文字体进来
 * —— 那段中文自己会去拉。
 *
 * 覆盖不满 `content` 的 runs 用空样式兜底，与 `layout.ts` 的
 * `resolveCharStyles` 同一姿态（校验 runs 完整性是 op handler 的事）。
 */
function charsByRequestedFont(text: LayerText): Map<string | undefined, string> {
  const out = new Map<string | undefined, string>();
  const push = (font: string | undefined, s: string): void => {
    if (s.length > 0) out.set(font, (out.get(font) ?? "") + s);
  };
  const content = text.content;
  if (text.runs && text.runs.length > 0) {
    let at = 0;
    for (const run of text.runs) {
      const slice = content.slice(at, at + run.length);
      at += run.length;
      push(run.style.font, expandCaps(slice, run.style.caps));
    }
    if (at < content.length) push(undefined, content.slice(at));
  } else {
    push(text.style?.font, expandCaps(content, text.style?.caps));
  }
  return out;
}

/** 请求的字体整套不在索引里时的替换记录。 */
interface FontSubstitution {
  requested: string;
  usedInstead: string[];
}

interface LoadedFonts {
  resolveFace: FaceResolver;
  /** 真正装载了的字体，用来写进 `doc.fonts` 保活。 */
  fonts: FontRef[];
  substitutions: FontSubstitution[];
}

/**
 * 选字体是**三步**，不是一步：
 *   1. `selectFonts` 只查 `coverage`，不读任何字节 —— 索引里存 coverage 就是
 *      为了让这一步不必先把字体文件拉下来；
 *   2. 逐个从 CAS 读字节、`parseFontFace` 成 `FontFace`（唯一的异步步骤）；
 *   3. `resolveFaceChain` 把它们包成一个**同步**的解析器交给 `layoutText`。
 *
 * `resolveFaceChain` 不收 `requestedFont` —— 那是 `FaceResolver` 每次调用时
 * 的参数（`layoutText` 逐字符传 `style.font`），见 `font.ts`。
 */
async function loadFonts(
  text: LayerText,
  source: FontIndexSource,
  index: FontIndex,
  ctx: EffectContext<PsdQuery>,
): Promise<LoadedFonts> {
  const needed = new Set<string>();
  const substitutions: FontSubstitution[] = [];
  for (const [requested, chars] of charsByRequestedFont(text)) {
    const chosen = selectFonts(index, requested, source.fallbacks, chars);
    for (const name of chosen) needed.add(name);
    // 请求的字体整套不在索引里：照常走回退链让编辑成功，但必须**显式报告**
    // （用户定的：字体缺就先用默认字体兜底，后面再优化）。自动兜底 + 显式
    // 报告，不是静默兜底 —— 字形和版面真的会变，模型得有机会说出来。
    if (requested !== undefined && !index.has(requested)) {
      substitutions.push({ requested, usedInstead: chosen });
    }
  }

  const loaded = new Map<string, FontFace>();
  const fonts: FontRef[] = [];
  for (const name of needed) {
    const entry = index.get(name);
    if (!entry) continue; // selectFonts 只会返回索引里有的名字；防御性。
    const blob = source.blobFor(entry);
    const bytes = await ctx.readBlob(blob);
    // 按**索引里的名字**入表，不是按 `face.postScriptName`：候选名单
    // （requested + fallbacks）用的是索引这套命名，`resolveFaceChain` 拿
    // 候选名去 `loaded` 里查，两边不同名就一个都查不到。
    loaded.set(name, parseFontFace(bytes.data));
    fonts.push({ postScriptName: name, blob });
  }

  return { resolveFace: resolveFaceChain(loaded, source.fallbacks), fonts, substitutions };
}

/** 码位数组 → 可读的字符串，给模型看的。去重：一句话里缺 20 个同样的字，
 *  报 20 遍只是噪音。 */
const missingChars = (codePoints: readonly number[]): string[] =>
  [...new Set(codePoints)].map(cp => String.fromCodePoint(cp));

export function createSetTextTool(source: FontIndexSource): AgentTool<PsdQuery, PsdOp> {
  return {
    kind: "effect",
    name: "setText",
    description:
      "WRITE. Change the WORDS of a TEXT layer. Pass the layer's complete new content; the layer is "
      + "re-typeset from the real font outlines and re-rasterised, so the letters come out exactly as "
      + "written. The style runs are re-split around your change and the layer's bounds move so the edge "
      + "fixed by the paragraph alignment stays put. Only works on text layers whose structure we can "
      + "re-typeset — it says so when it cannot.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string", description: "The text layer to retype." },
        text: {
          type: "string",
          description:
            "The layer's COMPLETE new content, not a diff and not just the part you changed. "
            + "Read the current content with getDoc first. Newlines separate paragraphs.",
        },
      },
      required: ["layerId", "text"],
    },

    async run(args, ctx: EffectContext<PsdQuery>): Promise<EffectOutcome<PsdOp>> {
      const layerId = args.layerId;
      const newContent = args.text;
      if (typeof layerId !== "string" || layerId.length === 0) {
        return fail({ ok: false, reason: "setText: layerId must be a non-empty string" });
      }
      if (typeof newContent !== "string") {
        return fail({ ok: false, reason: "setText: text must be a string" });
      }
      if (newContent.length === 0) {
        // 空内容排出来是一个 0×0 的图层框 —— 那不是"清空文字"，那是一个坏
        // 图层。想让这层不显示有别的路，说清楚比默默产出一个畸形结果强。
        return fail({
          ok: false,
          reason: "setText: text is empty. Clearing a text layer would leave a zero-sized layer;"
            + " hide it with setProps {visible:false} or delete it with removeLayer instead.",
        });
      }

      // 只要 text 和 bounds，不需要旧像素 —— getDoc 过了 stripLayer，
      // pixels 只剩 {width,height,omitted:true} 的元数据，对本任务够用。
      const { data } = await ctx.query({ kind: "getDoc", payload: { layerId } });
      const layer = asTextLayer(data, layerId);
      if (layer.type !== "text") {
        return fail({
          ok: false,
          reason: `setText: layer "${layerId}" is a ${layer.type} layer, not a text layer.`
            + " Only text layers carry the words to retype.",
        });
      }
      const old = layer.text;
      if (!old || typeof old.content !== "string") {
        return fail({
          ok: false,
          reason: `setText: layer "${layerId}" has no text description to edit.`,
        });
      }

      // 改动区间由这里推导，不让模型算字符偏移量 —— 它给的是整串新内容。
      const range = diffRange(old.content, newContent);
      const nextText: LayerText = { ...old, content: newContent };

      if (old.runs && old.runs.length > 0) {
        const spliced = spliceTextRuns(old.runs, range, old.content.length);
        if (!spliced.ok) return fail(spliceFailure(spliced.error, layerId, "character"));
        nextText.runs = spliced.runs;
      }
      if (old.paragraphRuns && old.paragraphRuns.length > 0) {
        const spliced = spliceParagraphRuns(old.paragraphRuns, range, old.content.length);
        if (!spliced.ok) return fail(spliceFailure(spliced.error, layerId, "paragraph"));
        nextText.paragraphRuns = spliced.runs;
      }

      const index = await source.load();
      const { resolveFace, fonts, substitutions } = await loadFonts(nextText, source, index, ctx);

      const laid = layoutText(nextText, resolveFace);
      if (!laid.ok) {
        // reason 已经是给人看的话（见 layout.ts 的 rejectionReason），原样透出。
        return fail({ ok: false, reason: `setText: ${laid.reason}` });
      }
      if (laid.glyphs.length === 0) {
        return fail({
          ok: false,
          reason: `setText: none of the characters could be drawn — no available font has a glyph`
            + ` for any of them (${missingChars(laid.missing).join("")}). The layer was not changed.`,
          missing: laid.missing as unknown as JsonValue,
        });
      }

      // ——— 新 bounds ———
      //
      // ⚠️ 两套四元组的**字段顺序不一样**，而且类型系统完全挡不住（都是四个
      // number）：
      //   layoutText 产出  inkBounds = { left, top, right, bottom }  具名对象，相对锚点
      //   Layer.bounds     [top, left, bottom, right]                位置数组 = [y0,x0,y1,x1]
      // 写成 [ink.left, ink.top, ink.right, ink.bottom] 会得到一个**转置**的
      // 图层框，表现是"文字跑到奇怪的位置"而不是崩溃。
      const ink = laid.inkBounds;
      const inkWidth = ink.right - ink.left;
      const inkHeight = ink.bottom - ink.top;
      const [oldTop, oldLeft, , oldRight] = layer.bounds;

      // 水平：按对齐方式决定哪条边不动（文字变长变短时锚定的那条边保持原位）。
      // 垂直：顶边不动。点文字的第一行基线是固定的，第一行的字号不变时墨迹
      // 顶边也就不变，多出来的行往下长 —— 与 Photoshop 里点文字加一行的行为
      // 一致。（不用 text.pointBase / text.transform 定位：那两个字段的确切
      // 语义没拿真实 PSD 核对过，而图层框是核对得了的。）
      const anchor = anchorEdge(nextText);
      const left = anchor === "right"
        ? oldRight - inkWidth
        : anchor === "center"
          ? (oldLeft + oldRight) / 2 - inkWidth / 2
          : oldLeft;
      const top = oldTop;
      // 取整向外扩：宁可多留一像素透明边，也不要把抗锯齿边缘切掉。
      const boundsLeft = Math.floor(left);
      const boundsTop = Math.floor(top);
      const boundsRight = Math.ceil(left + inkWidth);
      const boundsBottom = Math.ceil(top + inkHeight);
      const width = boundsRight - boundsLeft;
      const height = boundsBottom - boundsTop;
      if (width <= 0 || height <= 0) {
        return fail({
          ok: false,
          reason: "setText: the new text has no visible ink (only spaces?), which would leave a"
            + " zero-sized layer. The layer was not changed.",
        });
      }

      // 画布尺寸取**图层包围盒**的宽高，不是整页文档尺寸：栅格化是逐字形分配
      // 整幅画布做扫描线的，用整页尺寸在大文档上有明显性能代价。这也与仓库
      // 既有约定一致 —— layer.pixels 的尺寸本来就等于 bounds 的尺寸
      // （edit-pixels.ts 显式 resample 到 right-left × bottom-top）。
      //
      // origin 是画布左上角在"相对锚点"那套坐标系里的位置：墨迹左上角
      // (ink.left, ink.top) 落在文档的 (left, top)，画布左上角比它再往外
      // 取整多出来的那点就是这里的偏移。
      const raster = rasterizeGlyphs(laid.glyphs, width, height, {
        x: ink.left + (boundsLeft - left),
        y: ink.top + (boundsTop - top),
      });
      const blob = await ctx.writeBlob({ data: pixelsToPng(raster), contentType: "image/png" });

      const bounds: [number, number, number, number] = [boundsTop, boundsLeft, boundsBottom, boundsRight];
      const missing = missingChars(laid.missing);

      return {
        // 这个断言是必需的，不是懒：`PsdOp.payload` 是
        // `Record<string, unknown>`，`unknown` 不满足 SValueShape，于是
        // `SValueType<PsdOp>` 求值成 `never`。edit-pixels.ts / tools.ts 出于
        // 同一个原因用同一个写法。
        ops: [{
          kind: "set_text",
          payload: {
            layerId,
            text: nextText,
            // PixelRef，不是 Pixels：字节已经在 CAS 里，op 只带引用。
            pixels: { width, height, hash: blob.hash, blob },
            bounds,
            provenance: { model: TEXT_RENDERER, prompt: newContent },
            fonts,
          },
        }] as unknown as readonly SValueType<PsdOp>[],
        description: `setText(${layerId}): ${newContent.slice(0, 60)}`,
        result: {
          structuredContent: {
            ok: true,
            layerId,
            content: newContent,
            bounds: bounds as unknown as JsonValue,
            // layoutText 已经把这两个算好了，原样交出去 —— 模型据此告诉用户
            // "这几个样式没还原""这几个字这套字体没有"。
            ignored: laid.ignored as unknown as JsonValue,
            missing,
            fontFallbacks: substitutions as unknown as JsonValue,
          },
          content: [{ type: "text", text: summarize(layerId, newContent, laid.ignored, missing, substitutions) }],
        },
      };
    },
  };
}

/** 切分失败的两种原因各自的说法。`spans-runs` 必须给出**可执行**的建议：
 *  把跨样式的几段塌成一段必然丢样式（见 runs.ts 的注释），所以出路是分两次
 *  改，每次只碰一段。 */
function spliceFailure(
  error: { kind: string; styles?: number; runsTotal?: number; contentLength?: number },
  layerId: string,
  level: "character" | "paragraph",
): JsonValue {
  if (error.kind === "spans-runs") {
    return {
      ok: false,
      reason: `setText: that replacement spans ${error.styles} differently-styled ${level} runs in`
        + ` layer "${layerId}". Merging them would throw the styling away, so nothing was changed.`
        + ` Make the change in TWO calls instead, each one touching a single styled stretch`
        + ` (edit the first stretch, then edit the second).`,
      detail: { kind: error.kind, styles: error.styles ?? null } as JsonValue,
    };
  }
  return {
    ok: false,
    reason: `setText: layer "${layerId}" has inconsistent ${level} runs (they cover`
      + ` ${error.runsTotal} characters but the content is ${error.contentLength}), so it cannot be`
      + ` re-split safely. This layer's text can only be repainted, not retyped.`,
    detail: { kind: error.kind } as JsonValue,
  };
}

/** 给模型的一段人话。`ignored` / `missing` / 字体替换都得说出来 —— 不说的话
 *  这次编辑会被当成"和原来一模一样，只是换了几个字"。 */
function summarize(
  layerId: string,
  content: string,
  ignored: readonly string[],
  missing: readonly string[],
  substitutions: readonly FontSubstitution[],
): string {
  let text = `Done. Layer "${layerId}" now reads ${JSON.stringify(content)}, re-typeset and re-rasterised.`;
  if (substitutions.length > 0) {
    text += ` FONT SUBSTITUTED: ${substitutions
      .map(s => `"${s.requested}" is not available here, so ${s.usedInstead.length > 0 ? s.usedInstead.map(n => `"${n}"`).join(" + ") : "no font"} was used instead`)
      .join("; ")}. The letterforms and the line width WILL differ from the original — tell the user.`;
  }
  if (missing.length > 0) {
    text += ` MISSING GLYPHS: no available font can draw ${missing.map(c => JSON.stringify(c)).join(", ")};`
      + ` those characters are absent from the picture.`;
  }
  if (ignored.length > 0) {
    text += ` NOT REPRODUCED: this layer carries ${ignored.join(", ")}, which the renderer does not`
      + ` reproduce — the result is otherwise correct but lacks those.`;
  }
  return text;
}
