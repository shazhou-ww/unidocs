import type { AgentTool, JsonValue, SValueType } from "@unidocs/protocol";
import { requireNumber, requireNumberArray, requireRecord, requireSBlob } from "@unidocs/svalue-codec";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

const BLEND_MODES = [
  "normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn",
  "lighten", "screen", "color-dodge", "linear-dodge", "overlay",
  "soft-light", "hard-light", "vivid-light", "linear-light",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity", "pass-through",
];

const RGB = {
  type: "object",
  properties: {
    r: { type: "number", minimum: 0, maximum: 255 },
    g: { type: "number", minimum: 0, maximum: 255 },
    b: { type: "number", minimum: 0, maximum: 255 },
  },
  required: ["r", "g", "b"],
} as const;

const LAYER_TYPES = ["raster", "adjustment", "fill", "text", "smartObject", "group"];
const ADJUST_TYPES = ["brit", "blwh", "hue2", "levl", "curv"];

const BOUNDS = {
  type: "array", items: { type: "number" }, minItems: 4, maxItems: 4,
  description: "[top, left, bottom, right] in canvas pixels (y increases downward)",
};

// Shape of a Layer the caller supplies to addLayer / generativeFill.
const LAYER_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "caller-assigned unique id" },
    type: { enum: LAYER_TYPES },
    name: { type: "string" },
    bounds: BOUNDS,
    opacity: { type: "number", minimum: 0, maximum: 1 },
    blendMode: { enum: BLEND_MODES },
    visible: { type: "boolean" },
    clipping: { type: "boolean", description: "if true, clipped to the layer directly below" },
    adjustType: { enum: ADJUST_TYPES, description: "for type=adjustment (PSD key)" },
    params: { type: "object", description: "adjustment parameters" },
  },
  required: ["id", "type", "bounds"],
};

/**
 * `toQuery` for the three read tools: {} never masks a default, so an
 * argument-less call comes out as `{kind}` rather than `{kind, payload:{}}`.
 */
const psdQuery = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    (Object.keys(args).length === 0 ? { kind } : { kind, payload: args }) as unknown as SValueType<PsdQuery>;

/** `toOps` for the nine write tools: the model's arguments become the op payload verbatim. */
const psdOp = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    [{ kind, payload: args }] as unknown as readonly SValueType<PsdOp>[];

export const tools: readonly AgentTool<PsdQuery, PsdOp>[] = [
  {
    kind: "query",
    name: "getLayers",
    description: "READ. List the layer tree (id, type, name, opacity, blendMode, visible, bounds, children).",
    inputSchema: { type: "object", properties: {} },
    toQuery: psdQuery("getLayers"),
  },
  {
    kind: "query",
    name: "getDoc",
    description: "READ. Full structure of the document (or one layer via layerId): exact bounds, masks, adjustments, effects. Pixel data is omitted.",
    inputSchema: { type: "object", properties: { layerId: { type: "string" } } },
    toQuery: psdQuery("getDoc"),
  },
  {
    kind: "query",
    name: "getPreview",
    description: "READ (see the image). {} = whole canvas; {rect:[top,left,bottom,right]} = zoom into an area; {layerId} = one layer. Look here after edits to verify. Downscaled to maxSize (default 768, rect up to 1536), and shrunk further when needed to keep the image transferable — on a detailed document the whole canvas comes back smaller than you asked, so use rect to actually inspect detail. The returned width/height are what you got.",
    inputSchema: {
      type: "object",
      properties: {
        rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        layerId: { type: "string" },
        maxSize: { type: "number" },
      },
    },
    toQuery: psdQuery("getPreview"),
    toResult: (data, version) => {
      const d = requireRecord(data, "getPreview 结果");
      // The image is the field a bad result is most likely to be missing
      // (an SBlob that never got made), so check it before width/height —
      // that's the failure worth surfacing loudly, not a generic NaN.
      const blob = requireSBlob(d.image, "getPreview image");
      const width = requireNumber(d.width, "width");
      const height = requireNumber(d.height, "height");
      const region = requireNumberArray(d.region, "getPreview region", 4);
      const a = requireRecord(d.alpha, "getPreview alpha");
      const alpha = {
        opaque: requireNumber(a.opaque, "alpha.opaque"),
        transparent: requireNumber(a.transparent, "alpha.transparent"),
        soft: requireNumber(a.soft, "alpha.soft"),
      };
      // 透明度必须**用文字说**，不能指望模型从图上看出来。实测：把同一个图形
      // 分别放在全透明背景和真实黑底上问 operator 模型，它把透明那张读成
      // "白色背景"，而且因为图形也是白的，它连图形都没看见（"白色图形在白色
      // 背景上而几乎不可见"）；黑底那张描述得一清二楚。图上现在铺了棋盘格让
      // 内容重新可见，但"到底有多少透明"这种量的判断仍然只能靠数字。
      const alphaNote = alpha.opaque === 1
        ? " fully-opaque"
        : ` alpha(opaque=${alpha.opaque} transparent=${alpha.transparent} soft=${alpha.soft});`
          + " transparent areas are shown as a grey/white checkerboard, which is NOT part of the image";
      return {
        content: [{
          type: "image",
          blob,
          mediaType: "image/png",
          // 裁剪降级时模型看到的就是这句（spec 6.2.3 第 1 级）。
          // 这点知识一直属于 PSD，此前却写在大模型适配层的 previewMeta 里。
          altText: `preview ${width}x${height} region=${JSON.stringify(region)} v${version}${alphaNote}`,
        }],
        // 信封与 defaultQueryToolResult / docx 的 getImage 一致：查询结果放
        // data，版本号在外面。同一次会话里模型只该见到一种形状。
        structuredContent: { data: { width, height, region, alpha }, version } as JsonValue,
      };
    },
  },
  {
    kind: "op",
    name: "addLayer",
    description: "WRITE. Add a layer. Caller assigns the id; raster layers must include pixels.",
    inputSchema: {
      type: "object",
      properties: { layer: LAYER_SCHEMA, parentId: { type: ["string", "null"] }, index: { type: "number" } },
      required: ["layer", "parentId"],
    },
    toOps: psdOp("add_layer"),
  },
  {
    kind: "op",
    name: "removeLayer",
    description: "WRITE. Delete a layer by id.",
    inputSchema: { type: "object", properties: { layerId: { type: "string" } }, required: ["layerId"] },
    toOps: psdOp("remove_layer"),
  },
  {
    kind: "op",
    name: "reorder",
    description: "WRITE. Move a layer to a new parent/index.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, parentId: { type: ["string", "null"] }, index: { type: "number" } },
      required: ["layerId", "parentId"],
    },
    toOps: psdOp("reorder"),
  },
  {
    kind: "op",
    name: "setProps",
    description:
      "WRITE. Change name/opacity/fillOpacity/blendMode/visible/locked/clipping of a layer, "
      + "or set its stroke / colorOverlay / dropShadow effect. Pass null for an effect to remove it.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string" },
        props: {
          type: "object",
          properties: {
            name: { type: "string" },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            fillOpacity: { type: "number", minimum: 0, maximum: 1 },
            blendMode: { enum: BLEND_MODES },
            visible: { type: "boolean" },
            locked: { type: "boolean" },
            clipping: { type: "boolean" },
            stroke: {
              type: ["object", "null"],
              properties: {
                color: RGB,
                opacity: { type: "number", minimum: 0, maximum: 1 },
                size: { type: "number", minimum: 0 },
                position: { enum: ["inside", "outside", "center"] },
                blendMode: { enum: BLEND_MODES },
              },
              required: ["color", "opacity", "size", "position", "blendMode"],
            },
            colorOverlay: {
              type: ["object", "null"],
              properties: {
                r: { type: "number", minimum: 0, maximum: 255 },
                g: { type: "number", minimum: 0, maximum: 255 },
                b: { type: "number", minimum: 0, maximum: 255 },
                opacity: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["r", "g", "b", "opacity"],
            },
            dropShadow: {
              type: ["object", "null"],
              properties: {
                color: RGB,
                opacity: { type: "number", minimum: 0, maximum: 1 },
                blendMode: { enum: BLEND_MODES },
                angle: { type: "number" },
                distance: { type: "number" },
                size: { type: "number", minimum: 0 },
                choke: { type: "number", minimum: 0 },
              },
              required: ["color", "opacity", "blendMode", "angle", "distance", "size", "choke"],
            },
          },
        },
      },
      required: ["layerId", "props"],
    },
    toOps: psdOp("set_props"),
  },
  {
    kind: "op",
    name: "crop",
    description: "WRITE. Crop the canvas to [top,left,bottom,right].",
    inputSchema: { type: "object", properties: { rect: BOUNDS }, required: ["rect"] },
    toOps: psdOp("crop"),
  },
  {
    kind: "op",
    name: "transform",
    description: "WRITE. Translate or flip a layer. Only translate/flip are supported (no scale/rotate).",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string" },
        op: {
          type: "object",
          properties: {
            translate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[dx, dy] in pixels" },
            flip: { enum: ["horizontal", "vertical"] },
          },
        },
      },
      required: ["layerId", "op"],
    },
    toOps: psdOp("transform"),
  },
  {
    kind: "op",
    name: "setAdjustment",
    description: "WRITE. Change params of an existing adjustment layer.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, params: { type: "object" } },
      required: ["layerId", "params"],
    },
    toOps: psdOp("adjust"),
  },
  {
    kind: "op",
    name: "editMask",
    description: "WRITE. Set, replace, or remove (null) a layer mask.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, mask: { type: ["object", "null"] } },
      required: ["layerId", "mask"],
    },
    toOps: psdOp("mask_edit"),
  },
  {
    kind: "op",
    name: "generativeFill",
    description: "WRITE. Insert a pre-generated raster layer with provenance (pixels supplied by the tool step).",
    inputSchema: {
      type: "object",
      properties: { layer: LAYER_SCHEMA, parentId: { type: ["string", "null"] }, index: { type: "number" }, provenance: { type: "object" } },
      required: ["layer", "parentId", "provenance"],
    },
    toOps: psdOp("generative_fill"),
  },
];

export const instructions = `You are a PSD image editor operator. You edit a layer tree by calling tools.

MODEL & COORDINATES
- The document is a tree of layers over a fixed-size canvas. Get the canvas size and full structure with getDoc.
- Every rectangle is bounds = [top, left, bottom, right], in canvas pixels. The origin is the top-left corner and y increases DOWNWARD. So a layer's width = right - left, height = bottom - top.
- Layers arranged left-to-right differ in their left/right (x); arranged top-to-bottom differ in top/bottom (y). Check the numbers before moving anything.

READING (do this before and after edits)
- getLayers: quick summary tree (ids, types, bounds).
- getDoc: full structure of a layer/subtree (exact bounds, masks, adjustments, effects) with pixel data omitted.
- getPreview: RENDER you can SEE. Call with {} for the whole canvas, {rect:[t,l,b,r]} to zoom into an area, or {layerId} to see one layer. ALWAYS look with getPreview after an edit to verify it did what you intended, and adjust if not.

EDITING
- transform supports translate ({op:{translate:[dx,dy]}}) and flip only — no scale or rotate.
- Clipping: a layer with clipping:true is confined to the alpha of the layer directly BELOW it (its base). To move a clipped image, move its base layer by the same delta too, or they will separate.
- Masks: a mask is grayscale coverage (black hides, white shows). Use editMask to set/replace/remove.
- New layers need a caller-assigned unique id. A RASTER layer needs pixel data in the arguments, which you cannot produce — so add a raster layer only when its pixels were handed to you. Adjustment, fill and group layers need no pixels and are yours to create freely.
- Adjustment layers: create with addLayer (type "adjustment") using a PSD adjustType key (brit=brightness/contrast, blwh=black & white, hue2=hue/saturation); change params later with setAdjustment. The field is adjustType, not adjustmentType.

THE SELECTION MARKER
- When the user has something selected, their message starts with one <<selection ...>> marker. The layers=[{"id":..,"name":..}] list is what they picked: the id goes STRAIGHT into layerId on any tool, so you never have to translate a name through getLayers, and you never have to guess when two layers share a name. bounds=[t,l,b,r] appears only for a dragged region; a layer selection has no bounds because the layer has its own, readable from getLayers.
- NO marker means nothing is selected. If the user then writes "the selected layer", "this layer", "the part I picked" — they are referring to something you cannot see. Do NOT go hunting through getLayers/getPreview for what they might have meant. Say which layers you can see and ask them to select one, in one turn.

WORKFLOW
Query (getDoc/getLayers) → reason about coordinates → edit → getPreview to verify → correct if needed.

WHEN TO STOP
- "correct if needed" is not unlimited. If two attempts at the same goal have not produced it, stop and report: what you tried, what came back, and what you would need in order to continue. A clear "here is where it went wrong" is worth far more to the user than a third attempt.
- Stop and ask, rather than guessing, whenever the target is ambiguous: the thing they described is nowhere in the document, several layers match equally well, or they referred to a selection that no marker carried.
- Never keep calling tools just to look busy. Running out of turns produces an error with no result and no explanation — that is the worst outcome available to you, and it is always avoidable by reporting instead.`;

/**
 * 只有注入了 ImageEditor 时才追加的一段。
 *
 * 与工具表分开的理由，是一次真实故障教出来的：工具表本来就是条件的
 * （没 editor 就不注册 editPixels），但提示词是无条件的，于是没配 key 的
 * 部署里，模型的系统提示词白纸黑字写着"editPixels 是唯一能改像素的工具"，
 * 而工具列表里没有它。模型于是道歉、并建议用户改用 Photoshop —— 它没有
 * 幻觉，是提示词在骗它。
 *
 * 一个模型看得见的工具就会去调；一个描述了却不存在的工具比没有更糟。
 */
export const editPixelsInstructions = `

PIXEL EDITING
- editPixels: change the pixels INSIDE a layer from a plain-language instruction — removing an object, replacing something, painting something in. This is the ONLY tool that can change pixels. Give it {layerId, instruction}. It lands the result as a new layer above the source, transparent outside the changed region, and hands you back an after-preview — so you do NOT need a separate getPreview to check it.
- SHAPE: does this edit change the OUTLINE of the layer's non-transparent pixels? Re-lettering in a different font, reshaping a cut-out, adding a glow or outline past the current edges — those do; pass reshape: true, and the source layer gets hidden so its old outline cannot show through. Repainting inside the existing outline — swapping a hat inside a photo, recolouring, deleting an object — does not; leave reshape off, and the layer keeps its exact outline including anti-aliased edges. The question only arises when the layer HAS transparency: getPreview reports alpha(opaque=... transparent=... soft=...), and at opaque=1 there is no outline to preserve, so reshape changes nothing.
- You CANNOT see transparency. A PNG's alpha is flattened to white before you see it, so a transparent area looks like white paper and pale content on it can be invisible. Previews therefore paint transparent areas as a grey/white CHECKERBOARD — that pattern is not part of the image. For anything quantitative, read the alpha(...) numbers rather than judging from the picture.
- Write the instruction so it stands on its own: it is passed straight to an image model that sees only the layer and your sentence. "replace the hat with voluminous hair, with a bow hair accessory on top" works; "change it" does not.
- If editPixels comes back with ok:false, read the reason: "refused" means rephrase the instruction; "timeout"/"provider_error" mean the attempt failed and nothing was changed — decide whether it is worth retrying.`;
