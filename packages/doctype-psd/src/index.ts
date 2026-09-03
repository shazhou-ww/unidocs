export { createPsdDocumentType } from "./doctype.js";
export type { PsdDoc, PsdStoredDoc, PsdQuery, PsdOp } from "./doctype.js";
export type { PsdStoredFont } from "./state.js";
export type { FontEntry, FontIndex } from "./text/registry.js";
export { createPsdAgent } from "./agent.js";
export type { PsdAgentDeps } from "./agent.js";
export { createQwenImageEditor } from "./image/qwen-editor.js";
export type { QwenEditorOptions } from "./image/qwen-editor.js";
export type { ImageEditor, EditRequest, EditResult, EditorCapabilities, Coverage } from "./image/editor.js";
export { tools as psdTools, instructions as psdInstructions } from "./tools.js";
export type { Canvas, Layer, Mask, Pixels, BlendMode, LayerType } from "./model/types.js";

// Shared editing core — the browser UI imports these directly (design §5.3/§8).
export { render } from "./render/index.js";
export { apply, applyOne } from "./ops/index.js";
export { resolveDoc, resolveLayerPixels } from "./resolve.js";
export { load } from "./psd/load.js";
