import type { AgentToolDefinition } from "@unidocs/core";

export const tools: Record<string, AgentToolDefinition> = {
  getLayers: { name: "query_getLayers", description: "List the layer tree (id, name, type, opacity, blendMode, bounds).", inputSchema: {} },
  add_layer: { name: "apply_add_layer", description: "Add a layer. Caller assigns the layer id and (for raster) pixels.", inputSchema: { type: "object", properties: { layer: { type: "object" }, parentId: { type: ["string", "null"] }, index: { type: "number" } }, required: ["layer", "parentId"] } },
  remove_layer: { name: "apply_remove_layer", description: "Delete a layer by id.", inputSchema: { type: "object", properties: { layerId: { type: "string" } }, required: ["layerId"] } },
  reorder: { name: "apply_reorder", description: "Move a layer to a new parent/index.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, parentId: { type: ["string", "null"] }, index: { type: "number" } }, required: ["layerId", "parentId"] } },
  set_props: { name: "apply_set_props", description: "Change name/opacity/blendMode/visible/locked/clipping.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, props: { type: "object" } }, required: ["layerId", "props"] } },
  crop: { name: "apply_crop", description: "Crop the canvas to [top,left,bottom,right].", inputSchema: { type: "object", properties: { rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } }, required: ["rect"] } },
  transform: { name: "apply_transform", description: "Translate or flip a layer (scale/rotate not yet supported).", inputSchema: { type: "object", properties: { layerId: { type: "string" }, op: { type: "object" } }, required: ["layerId", "op"] } },
  adjust: { name: "apply_adjust", description: "Change params of an existing adjustment layer.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, params: { type: "object" } }, required: ["layerId", "params"] } },
  mask_edit: { name: "apply_mask_edit", description: "Set, replace, or remove (null) a layer mask.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, mask: { type: ["object", "null"] } }, required: ["layerId", "mask"] } },
  generative_fill: { name: "apply_generative_fill", description: "Insert a pre-generated raster layer with provenance (result pixels supplied by the tool layer).", inputSchema: { type: "object", properties: { layer: { type: "object" }, parentId: { type: ["string", "null"] }, index: { type: "number" }, provenance: { type: "object" } }, required: ["layer", "parentId", "provenance"] } },
};

export const instructions = `You are a PSD image editor operator. Query the layer tree with query_getLayers, then edit with apply_* tools.
Rules:
- Every new layer needs a caller-assigned unique id. Raster layers and generative results must include their pixel data.
- Generate images (generative_fill) in your own tool step first, then apply the resulting layer.
- Adjustment layers: create with apply_add_layer (type "adjustment"); change their params with apply_adjust.
- transform currently supports translate and flip only.`;
