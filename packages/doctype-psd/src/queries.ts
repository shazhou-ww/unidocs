import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue, DocumentTypeContext } from "@unidocs/core";
import { encode } from "fast-png";
import { renderCached, renderRegion, renderLayer, downscale } from "./render/index.js";
import { findLayer } from "./model/tree.js";

export type PsdQuery =
  | { kind: "getLayers"; payload?: Record<string, never> }
  | { kind: "getDoc"; payload?: { layerId?: string } }
  | { kind: "getPreview"; payload?: { rect?: [number, number, number, number]; layerId?: string; maxSize?: number } };

function summarize(l: Layer): any {
  return {
    id: l.id, type: l.type, name: l.name ?? "",
    opacity: l.opacity ?? 1, blendMode: l.blendMode ?? "normal",
    visible: l.visible ?? true, bounds: l.bounds ?? [0, 0, 0, 0],
    ...(l.children ? { children: l.children.map(summarize) } : {}),
  };
}

/** Deep-copy a layer with pixel/mask data stripped (keep dimensions + metadata). */
function stripLayer(l: Layer): any {
  const { pixels, mask, children, ...rest } = l;
  return {
    ...rest,
    ...(pixels ? { pixels: { width: pixels.width, height: pixels.height, omitted: true } } : {}),
    ...(mask ? { mask: { bounds: mask.bounds, defaultColor: mask.defaultColor, inverted: mask.inverted, pixels: { width: mask.pixels.width, height: mask.pixels.height, omitted: true } } } : {}),
    ...(children ? { children: children.map(stripLayer) } : {}),
  };
}

/** PNG-encode pixels and wrap as a base64 image the operator can show the agent. */
function toImageResult(px: { width: number; height: number; data: Uint8ClampedArray }, region: [number, number, number, number]): QueryValue {
  const png = encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) bin += String.fromCharCode(...png.subarray(i, i + chunk));
  return { $image: { base64: btoa(bin), mediaType: "image/png" }, width: px.width, height: px.height, region };
}

export async function runQuery(q: PsdQuery, doc: PsdDoc, _ctx?: DocumentTypeContext): Promise<QueryValue> {
  switch (q.kind) {
    case "getLayers":
      return doc.layers.map(summarize);

    case "getDoc": {
      const layerId = q.payload?.layerId;
      const layers = layerId
        ? (() => { const l = findLayer(doc.layers, layerId); if (!l) throw new Error(`layer not found: ${layerId}`); return [l]; })()
        : doc.layers;
      return { canvas: doc.canvas, layers: layers.map(stripLayer) } as unknown as QueryValue;
    }

    case "getPreview": {
      const p = q.payload ?? {};
      // Absent maxSize → a token-thrifty ceiling for the agent's eye.
      // An explicit maxSize (e.g. the viewer asking for full-res) is honored
      // as-is; downscale never upscales, so it's a no-op when already smaller.
      const cap = p.rect ? 1536 : 768;
      const maxSize = p.maxSize ?? cap;
      // Render RESIDENT: the render entrypoints fall back to their resident
      // defaultCtx() (no store) when no RenderCtx is passed. The lazy-pixel
      // path (rendering from a BlobStore) returns in a later stage.
      let px: { width: number; height: number; data: Uint8ClampedArray };
      let region: [number, number, number, number];
      if (p.layerId) {
        const l = findLayer(doc.layers, p.layerId);
        if (!l) throw new Error(`layer not found: ${p.layerId}`);
        px = await renderLayer(doc, p.layerId);
        region = l.bounds;
      } else if (p.rect) {
        px = await renderRegion(doc, p.rect);
        region = p.rect;
      } else {
        px = await renderCached(doc);
        region = [0, 0, doc.canvas.height, doc.canvas.width];
      }
      return toImageResult(downscale(px, maxSize), region);
    }
  }
}
