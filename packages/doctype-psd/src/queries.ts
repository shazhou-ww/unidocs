import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue, DocumentTypeContext } from "@unidocs/core";
import { encode } from "fast-png";
import { renderCached, renderRegion, renderLayer, downscale, DEFAULT_CACHE_BYTES, type RenderCtx } from "./render/index.js";
import { PixelCache } from "./render/pixel-source.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
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

export async function runQuery(q: PsdQuery, doc: PsdDoc, ctx?: DocumentTypeContext): Promise<QueryValue> {
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
      // Resident docs (no ctx.cas) render via the resident entrypoints — the
      // render entrypoints fall back to their own resident defaultCtx() (no
      // store) when no RenderCtx is passed, so this is byte-identical to
      // before. Lazy (PixelRef) docs pass a RenderCtx that faults pixels in
      // from the CAS as the compositor streams over each layer.
      const rc: RenderCtx | undefined = ctx
        ? { store: casBlobStore(ctx), cache: new PixelCache(DEFAULT_CACHE_BYTES) }
        : undefined;
      let px: { width: number; height: number; data: Uint8ClampedArray };
      let region: [number, number, number, number];
      if (p.layerId) {
        const l = findLayer(doc.layers, p.layerId);
        if (!l) throw new Error(`layer not found: ${p.layerId}`);
        px = await renderLayer(doc, p.layerId, {}, rc);
        region = l.bounds;
      } else if (p.rect) {
        px = await renderRegion(doc, p.rect, rc);
        region = p.rect;
      } else {
        px = await renderCached(doc, rc);
        region = [0, 0, doc.canvas.height, doc.canvas.width];
      }
      return toImageResult(downscale(px, maxSize), region);
    }
  }
}
