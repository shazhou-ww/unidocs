import type { FontRef, LayerText, PsdDoc } from "../model/types.js";
import type { PixelRef } from "../render/pixel-source.js";
import { findLayer } from "../model/tree.js";

/**
 * `set_text` 的载荷。**每一个值都由 effect 算好**（见 `text/set-text.ts`）——
 * 这个 handler 不排版、不栅格化、不选字体，它只落地与校验。
 *
 * op handler 必须是纯函数（design.md）：所有 IO 都在 effect 里做完了，
 * `apply` 才能确定性重放。
 */
export interface SetTextPayload {
  layerId: string;
  /** 新的完整 `LayerText`：`content` 与 `runs` 都已经切好。 */
  text: LayerText;
  /** 重新栅格化出来的像素，**PixelRef 不是 Pixels** —— 字节在 CAS 里，
   *  op 只带引用（理由见 `image/edit-pixels.ts` 结尾那段注释）。 */
  pixels: PixelRef;
  bounds: [number, number, number, number];
  provenance: { model: string; prompt: string };
  /** 这次排版真正用到的字体。写进 `doc.fonts` 是为了**保活**：CAS 的 GC 靠
   *  文档里的 SBlob 引用钉住 blob，只被租户索引引用的字体会被回收
   *  （设计文档 §3.6）。不写的话下一次打开这个文档想再改一次字，字节可能
   *  已经不在了。 */
  fonts?: FontRef[];
}

export function setText(doc: PsdDoc, p: SetTextPayload): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`set_text: layer not found: ${p.layerId}`);
  if (layer.type !== "text") {
    throw new Error(`set_text: layer ${p.layerId} is not a text layer (type=${layer.type})`);
  }
  const text = p.text;
  if (!text || typeof text.content !== "string") {
    throw new Error("set_text: text.content must be a string");
  }
  // runs 的长度之和必须等于 content 的长度。对不上就说明 effect 的重切分
  // 算错了 —— 落地之后样式和字符会**永久**错位（第二行的红色跑到第一行去），
  // 而那种错很难归因，所以宁可在这里炸掉整个 delta。
  if (text.runs) {
    const total = text.runs.reduce((n, r) => n + r.length, 0);
    if (total !== text.content.length) {
      throw new Error(
        `set_text: runs length ${total} does not cover content length ${text.content.length}`,
      );
    }
  }
  // 段落 runs 同理，而且 effect 那边两者走的是同一套切分（`spliceRuns`）——
  // 只兜住字符 runs 等于只兜住一半。`paragraphRuns[].length` 算错的后果是
  // 逐行对齐静默套错段（居中的标题被按左对齐排），一样是永久的。
  if (text.paragraphRuns) {
    const total = text.paragraphRuns.reduce((n, r) => n + r.length, 0);
    if (total !== text.content.length) {
      throw new Error(
        `set_text: paragraphRuns length ${total} does not cover content length ${text.content.length}`,
      );
    }
  }
  if (!Array.isArray(p.bounds) || p.bounds.length !== 4 || !p.bounds.every(Number.isFinite)) {
    throw new Error("set_text: bounds must be four finite numbers [top,left,bottom,right]");
  }

  // `text` / `pixels` / `provenance` 直接挂载荷对象：`applyOne` 每次都先
  // `structuredClone` 整份 doc 再交给 handler，op 与 op 之间本来就不共享对象，
  // 深拷一整份 `LayerText` 只是白花开销。（载荷可能来自 SValue 解码器、那些
  // 对象是冻结的——这条本身成立，但落地之后没有任何一处**原地**改写它们，
  // 所以不构成理由。）
  layer.text = text;
  layer.pixels = p.pixels;
  // 位置数组 [top,left,bottom,right]，与 inkBounds 那个 {left,top,right,bottom}
  // 具名对象的字段顺序**是反的**（见 set-text.ts 里换算那一段）。这一处拷贝
  // 是因为 `bounds` 是四个数的可变数组、图层把它当自己的东西用（`geometry-ops`
  // 的 `shiftBounds` 会整体换掉它），四个数的浅拷贝也不值一提。
  layer.bounds = [...p.bounds] as [number, number, number, number];
  // 这层像素不再是 Photoshop 烘的，UI 和 agent 都得知道 —— 写法与
  // generativeFill 同一套（没有 seed 字段：自研排版链没有种子这回事）。
  layer.provenance = p.provenance;

  if (p.fonts && p.fonts.length > 0) {
    // 合并而不是替换：同一份文档里别的文字层可能还在用别的字体，替换会把
    // 它们的保活引用一起抹掉，CAS 的 GC 随后就会回收那些字节。
    const byName = new Map((doc.fonts ?? []).map(f => [f.postScriptName, f]));
    for (const font of p.fonts) {
      if (!byName.has(font.postScriptName)) byName.set(font.postScriptName, font);
    }
    doc.fonts = [...byName.values()];
  }
}
