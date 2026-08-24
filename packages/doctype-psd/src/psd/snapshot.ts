import { encode } from "fast-png";
import { createSBlob } from "@unidocs/svalue-codec";
import type { CasReferences, DocumentTypeContext } from "@unidocs/protocol";
import type { Layer, Mask, PsdDoc } from "../model/types.js";
import { isRef, type BlobStore } from "../render/pixel-source.js";
import { serialize, deserialize } from "./ir.js";
import { save } from "./save.js";
import { load } from "./load.js";
import { casBlobStore } from "./cas-blobstore.js";

// First non-whitespace byte of an IR JSON snapshot is `{` (0x7b). A raw
// imported PSD begins with the `8BPS` magic (0x38 0x42 0x50 0x53).
const OPEN_BRACE = 0x7b;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]); // space, tab, LF, CR

/** Index of the first non-whitespace byte, or -1 if all whitespace/empty. */
function firstNonWs(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    if (!WS.has(bytes[i])) return i;
  }
  return -1;
}

/** True when the bytes are an IR JSON snapshot (first non-ws byte is `{`). */
function isJsonSnapshot(bytes: Uint8Array): boolean {
  const i = firstNonWs(bytes);
  return i !== -1 && bytes[i] === OPEN_BRACE;
}

async function persistMask(mask: Mask, store: BlobStore): Promise<void> {
  if (mask.blob || mask.pixels.width === 0) return;
  const png = encode({
    width: mask.pixels.width,
    height: mask.pixels.height,
    data: mask.pixels.data,
    channels: 4,
    depth: 8,
  });
  const hash = await store.put(png);
  mask.blob = createSBlob(hash);
}

async function persistLayer(layer: Layer, store: BlobStore): Promise<void> {
  if (layer.pixels !== undefined) {
    if (isRef(layer.pixels)) {
      layer.pixels = {
        width: layer.pixels.width,
        height: layer.pixels.height,
        hash: layer.pixels.hash,
        blob: layer.pixels.blob ?? createSBlob(layer.pixels.hash),
      };
    } else {
      const png = encode({
        width: layer.pixels.width,
        height: layer.pixels.height,
        data: layer.pixels.data,
        channels: 4,
        depth: 8,
      });
      const hash = await store.put(png);
      layer.pixels = {
        width: layer.pixels.width,
        height: layer.pixels.height,
        hash,
        blob: createSBlob(hash),
      };
    }
  }
  if (layer.mask) await persistMask(layer.mask, store);
  if (layer.children) {
    for (const child of layer.children) await persistLayer(child, store);
  }
}

/**
 * Upload resident pixels, then hang branded SBlobs on the in-memory TDoc so
 * `collectSBlobRefs` can pin them after save. Mask buffers stay resident for
 * the compositor. Existing PixelRefs keep their hash and gain a blob handle.
 */
async function persistDoc(doc: PsdDoc, store: BlobStore): Promise<void> {
  for (const layer of doc.layers) await persistLayer(layer, store);
}

/**
 * Serialize a document to snapshot bytes. With a write-capable CAS context
 * (`ctx.makeSBlob` present), produces the byte-free IR JSON and uploads every
 * layer/mask pixel blob to the CAS. Without one (legacy / no-ctx), falls back
 * to a full PSD (`8BPS`) so existing callers keep working.
 */
export async function saveSnapshot(doc: PsdDoc, ctx?: DocumentTypeContext): Promise<Uint8Array> {
  if (ctx?.makeSBlob) {
    const store = casBlobStore(ctx);
    await persistDoc(doc, store);
    return serialize(doc, store);
  }
  return save(doc);
}

/**
 * Reconstruct a document from snapshot bytes. IR JSON (`{`) yields a lazy
 * document whose layer pixels stay as `PixelRef`s (faulted in on demand from
 * the CAS) — this requires a CAS context. A raw PSD (`8BPS`) is imported into a
 * fully resident document.
 */
export async function loadSnapshot(bytes: Uint8Array, ctx?: DocumentTypeContext): Promise<PsdDoc> {
  if (isJsonSnapshot(bytes)) {
    if (!ctx) {
      throw new Error("loadSnapshot: an IR JSON snapshot requires a CAS context to resolve its lazy pixel blobs");
    }
    return deserialize(bytes, casBlobStore(ctx));
  }
  return load(bytes);
}

/** IR shapes as they appear on disk — only the fields we walk for refs. */
interface RefMask {
  pixels?: { hash?: string };
}
interface RefLayer {
  pixels?: { hash?: string };
  mask?: RefMask | null;
  children?: RefLayer[];
}

function collectLayerRefs(layer: RefLayer, out: Record<string, number>): void {
  const pixHash = layer.pixels?.hash;
  if (typeof pixHash === "string") out[pixHash] = 1;
  const maskHash = layer.mask?.pixels?.hash;
  if (typeof maskHash === "string") out[maskHash] = 1;
  if (layer.children) {
    for (const c of layer.children) collectLayerRefs(c, out);
  }
}

/**
 * Extract every CAS hash referenced by a snapshot — synchronous and pure, never
 * touching any store. For an IR JSON snapshot, walks all layers (recursively
 * into group children) and masks, collecting each `pixels.hash` and
 * `mask.pixels.hash`. A PSD (or empty/non-JSON) snapshot references nothing.
 *
 * Kept as a test/debug helper; DocumentType no longer exposes refsFromSnapshot.
 */
export function refsFromSnapshot(bytes: Uint8Array): CasReferences {
  if (!isJsonSnapshot(bytes)) return {};
  const ir = JSON.parse(new TextDecoder().decode(bytes)) as { layers?: RefLayer[] };
  const out: Record<string, number> = {};
  if (ir.layers) {
    for (const l of ir.layers) collectLayerRefs(l, out);
  }
  return out;
}
