import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue, DocumentTypeContext } from "@unidocs/protocol";
import { encode } from "fast-png";
import { renderCached, renderRegion, renderLayer, downscale, DEFAULT_CACHE_BYTES, type RenderCtx } from "./render/index.js";
import { PixelCache } from "./render/pixel-source.js";
import type { DocRenderState } from "./render/doc-render-state.js";
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

/**
 * Budget for the encoded PNG, expressed in BASE64-EQUIVALENT bytes — despite
 * the "byte budget" framing, `fitToBudget` below compares against
 * `b64Length(png.length)` (what the PNG's size would be if base64-encoded),
 * not `png.length` itself. That formula predates the move to SBlob and is
 * left as-is rather than reworked, so the real ceiling on PNG bytes is
 * tighter than this constant reads: roughly `PREVIEW_BASE64_BUDGET * 3/4` ≈
 * 720 KiB, not 960 KiB.
 *
 * The PNG itself now travels as a CAS-backed SBlob, not an inline base64
 * string, so it no longer risks the codec's 1 MiB `maxStringBytes` cap. The
 * budget stays for a different reason: this PNG also gets handed to the
 * model as an image content part, and a multi-megabyte image is wasted
 * context — expensive to transfer, expensive to look at, and no more
 * informative past a certain resolution. Capping the ENCODED BYTES (rather
 * than a fixed dimension) is still the right lever, because size depends on
 * content, not pixel count: PNG cannot beat raw RGBA on detailed imagery, so
 * a dimension cap alone would force an unreasonably small universal ceiling.
 */
const PREVIEW_BASE64_BUDGET = 960 * 1024;
/** Never shrink a preview below this; past here it stops being informative. */
const MIN_PREVIEW_SIZE = 64;
/** Re-encode attempts. Each pass measures real bytes, so 3 is ample. */
const MAX_FIT_ATTEMPTS = 3;

type Px = { width: number; height: number; data: Uint8ClampedArray };

const b64Length = (byteLength: number): number => Math.ceil(byteLength / 3) * 4;
const longestSide = (px: Px): number => Math.max(px.width, px.height);

function pngOf(px: Px): Uint8Array {
  return encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
}

/**
 * Downscale to `maxSize`, then keep shrinking until the base64 fits
 * {@link PREVIEW_BASE64_BUDGET}.
 *
 * Each pass re-derives the target from the bytes actually measured — encoded
 * size is roughly proportional to pixel count, so scaling the longest side by
 * `sqrt(budget / actual)` lands close on the first retry — and every pass
 * downscales from the ORIGINAL pixels rather than from the previous (already
 * point-sampled) result, so repeated fitting cannot compound resampling
 * artefacts.
 */
function fitToBudget(source: Px, maxSize: number): { px: Px; png: Uint8Array } {
  let px = downscale(source, maxSize);
  let png = pngOf(px);
  for (let i = 0; i < MAX_FIT_ATTEMPTS && b64Length(png.length) > PREVIEW_BASE64_BUDGET; i++) {
    const side = longestSide(px);
    if (side <= MIN_PREVIEW_SIZE) break;
    const ratio = Math.sqrt(PREVIEW_BASE64_BUDGET / b64Length(png.length)) * 0.95;
    const next = Math.max(MIN_PREVIEW_SIZE, Math.floor(side * ratio));
    if (next >= side) break; // not converging — stop rather than spin
    px = downscale(source, next);
    png = pngOf(px);
  }
  return { px, png };
}

function requireCtx(ctx: DocumentTypeContext | undefined): DocumentTypeContext {
  if (!ctx) throw new Error("getPreview needs a DocumentTypeContext to store the rendered PNG");
  return ctx;
}

/** PNG-encode and hand out an SBlob reference; no more base64 (spec 5.3, 2.4). */
async function toImageResult(
  source: Px,
  region: [number, number, number, number],
  maxSize: number,
  ctx: DocumentTypeContext,
): Promise<QueryValue> {
  const { px, png } = fitToBudget(source, maxSize);
  const image = await ctx.makeSBlob({ data: png, contentType: "image/png" });
  return { image, width: px.width, height: px.height, region } as unknown as QueryValue;
}

export async function runQuery(
  q: PsdQuery,
  doc: PsdDoc,
  ctx?: DocumentTypeContext,
  render?: DocRenderState,
): Promise<QueryValue> {
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
      // With a `render` state (an Editor DO, which keeps one per document),
      // previews go through its resident compositor: decoded pixels stay warm
      // across requests and an edit only invalidates the tiles its dirty rect
      // covers. Byte-identical to the stateless path below — see
      // tests/doc-render-state.test.ts, which pins `composite`/`region`
      // against `render`/`renderRegion` across edits, rollback and eviction.
      //
      // Without one (resident docs, direct callers, tests) this falls back to
      // the original stateless path verbatim: a fresh PixelCache per call, and
      // the resident entrypoints' own defaultCtx() when there is no `ctx`.
      const rc: RenderCtx | undefined = render
        ? render.ctx
        : ctx
          ? { store: casBlobStore(ctx), cache: new PixelCache(DEFAULT_CACHE_BYTES) }
          : undefined;
      let px: { width: number; height: number; data: Uint8ClampedArray };
      let region: [number, number, number, number];
      if (p.layerId) {
        const l = findLayer(doc.layers, p.layerId);
        if (!l) throw new Error(`layer not found: ${p.layerId}`);
        // A single-layer preview renders an ISOLATED one-layer document, which
        // shares no tiles with this document — but it does share blobs, so it
        // still takes the warm decoded-pixel cache via `rc`.
        px = await renderLayer(doc, p.layerId, {}, rc);
        region = l.bounds;
      } else if (p.rect) {
        // `renderRegion` composites the whole canvas and then crops; the
        // tile-backed path composites only the tiles the rect touches.
        px = render ? await render.region(doc, p.rect) : await renderRegion(doc, p.rect, rc);
        region = p.rect;
      } else {
        px = render ? await render.composite(doc) : await renderCached(doc, rc);
        region = [0, 0, doc.canvas.height, doc.canvas.width];
      }
      return toImageResult(px, region, maxSize, requireCtx(ctx));
    }
  }
}
