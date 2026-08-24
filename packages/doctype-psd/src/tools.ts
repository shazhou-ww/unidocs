import type { AgentToolDefinition } from "@unidocs/protocol";

const BLEND_MODES = [
  "normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn",
  "lighten", "screen", "color-dodge", "linear-dodge", "overlay",
  "soft-light", "hard-light", "vivid-light", "linear-light",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity", "pass-through",
];
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

export const tools: Record<string, AgentToolDefinition> = {
  getLayers: {
    name: "query_getLayers",
    description: "READ. List the layer tree (id, type, name, opacity, blendMode, visible, bounds, children).",
    inputSchema: { type: "object", properties: {} },
  },
  getDoc: {
    name: "query_getDoc",
    description: "READ. Full structure of the document (or one layer via layerId): exact bounds, masks, adjustments, effects. Pixel data is omitted.",
    inputSchema: { type: "object", properties: { layerId: { type: "string" } } },
  },
  getPreview: {
    name: "query_getPreview",
    description: "READ (see the image). {} = whole canvas; {rect:[top,left,bottom,right]} = zoom into an area; {layerId} = one layer. Look here after edits to verify. Downscaled to maxSize (default 768, rect up to 1536).",
    inputSchema: {
      type: "object",
      properties: {
        rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        layerId: { type: "string" },
        maxSize: { type: "number" },
      },
    },
  },
  add_layer: {
    name: "apply_add_layer",
    description: "WRITE. Add a layer. Caller assigns the id; raster layers must include pixels.",
    inputSchema: {
      type: "object",
      properties: { layer: LAYER_SCHEMA, parentId: { type: ["string", "null"] }, index: { type: "number" } },
      required: ["layer", "parentId"],
    },
  },
  remove_layer: {
    name: "apply_remove_layer",
    description: "WRITE. Delete a layer by id.",
    inputSchema: { type: "object", properties: { layerId: { type: "string" } }, required: ["layerId"] },
  },
  reorder: {
    name: "apply_reorder",
    description: "WRITE. Move a layer to a new parent/index.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, parentId: { type: ["string", "null"] }, index: { type: "number" } },
      required: ["layerId", "parentId"],
    },
  },
  set_props: {
    name: "apply_set_props",
    description: "WRITE. Change name/opacity/blendMode/visible/locked/clipping of a layer.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string" },
        props: {
          type: "object",
          properties: {
            name: { type: "string" },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            blendMode: { enum: BLEND_MODES },
            visible: { type: "boolean" },
            locked: { type: "boolean" },
            clipping: { type: "boolean" },
          },
        },
      },
      required: ["layerId", "props"],
    },
  },
  crop: {
    name: "apply_crop",
    description: "WRITE. Crop the canvas to [top,left,bottom,right].",
    inputSchema: { type: "object", properties: { rect: BOUNDS }, required: ["rect"] },
  },
  transform: {
    name: "apply_transform",
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
  },
  adjust: {
    name: "apply_adjust",
    description: "WRITE. Change params of an existing adjustment layer.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, params: { type: "object" } },
      required: ["layerId", "params"],
    },
  },
  mask_edit: {
    name: "apply_mask_edit",
    description: "WRITE. Set, replace, or remove (null) a layer mask.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "string" }, mask: { type: ["object", "null"] } },
      required: ["layerId", "mask"],
    },
  },
  generative_fill: {
    name: "apply_generative_fill",
    description: "WRITE. Insert a pre-generated raster layer with provenance (pixels supplied by the tool step).",
    inputSchema: {
      type: "object",
      properties: { layer: LAYER_SCHEMA, parentId: { type: ["string", "null"] }, index: { type: "number" }, provenance: { type: "object" } },
      required: ["layer", "parentId", "provenance"],
    },
  },
};

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
- transformLayer supports translate ({op:{translate:[dx,dy]}}) and flip only — no scale or rotate.
- Clipping: a layer with clipping:true is confined to the alpha of the layer directly BELOW it (its base). To move a clipped image, move its base layer by the same delta too, or they will separate.
- Masks: a mask is grayscale coverage (black hides, white shows). Use editMask to set/replace/remove.
- New layers need a caller-assigned unique id. Raster layers must include pixel data; generate images (generativeFill) in your own tool step first, then insert the resulting layer.
- Adjustment layers: create with addLayer (type "adjustment") using a PSD adjustType key (brit=brightness/contrast, blwh=black & white, hue2=hue/saturation); change params later with setAdjustment. The field is adjustType, not adjustmentType.

WORKFLOW
Query (getDoc/getLayers) → reason about coordinates → edit → getPreview to verify → correct if needed.`;
