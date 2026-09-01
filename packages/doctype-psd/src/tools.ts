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
      return {
        content: [{
          type: "image",
          blob,
          mediaType: "image/png",
          // 裁剪降级时模型看到的就是这句（spec 6.2.3 第 1 级）。
          // 这点知识一直属于 PSD，此前却写在大模型适配层的 previewMeta 里。
          altText: `preview ${width}x${height} region=${JSON.stringify(region)} v${version}`,
        }],
        // 信封与 defaultQueryToolResult / docx 的 getImage 一致：查询结果放
        // data，版本号在外面。同一次会话里模型只该见到一种形状。
        structuredContent: { data: { width, height, region }, version } as JsonValue,
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
- New layers need a caller-assigned unique id. Raster layers must include pixel data; generate images (generativeFill) in your own tool step first, then insert the resulting layer.
- editPixels: change the pixels INSIDE a layer from a plain-language instruction — removing an object, replacing something, painting something in. This is the ONLY tool that can change pixels; every other write tool needs pixel data you cannot produce. Give it {layerId, instruction}. It lands the result as a new masked layer above the source and hands you back an after-preview, so you do NOT need a separate getPreview to check it.
- If editPixels comes back with ok:false, read the reason: "refused" means rephrase the instruction; "needs_mask" means narrow the area with getPreview {rect} first; "timeout"/"provider_error" mean the attempt failed and nothing was changed — decide whether it is worth retrying.
- Adjustment layers: create with addLayer (type "adjustment") using a PSD adjustType key (brit=brightness/contrast, blwh=black & white, hue2=hue/saturation); change params later with setAdjustment. The field is adjustType, not adjustmentType.

WORKFLOW
Query (getDoc/getLayers) → reason about coordinates → edit (layer ops, or editPixels for pixels) → getPreview to verify (editPixels already returns one) → correct if needed.`;
