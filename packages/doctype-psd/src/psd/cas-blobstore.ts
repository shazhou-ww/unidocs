import type { DocumentTypeContext } from "@unidocs/core";
import type { BlobStore } from "../render/pixel-source.js";

/**
 * Bridges the doctype-local content-addressed `BlobStore` (`put`/`get` by hash)
 * onto the runtime CAS exposed via `ctx.cas`. `put` uploads PNG bytes through
 * `ctx.cas.store` (write-capable / editor-side context only), returning the CAS
 * content hash; `get` reads a blob by hash, translating a CAS miss (which throws)
 * into the BlobStore's `null` contract.
 *
 * Only build this when saving with a write-capable context — `serialize` calls
 * `put`, which requires `ctx.cas.store` to be present.
 */
export function casBlobStore(ctx: DocumentTypeContext): BlobStore {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      if (!ctx.cas.store) {
        throw new Error("casBlobStore: ctx.cas.store is required to put blobs (write-capable context expected)");
      }
      return ctx.cas.store(bytes, "image/png");
    },
    async get(hash: string): Promise<Uint8Array | null> {
      try {
        return await ctx.cas.read({ kind: "cas", hash });
      } catch {
        // CAS read throws on miss; the BlobStore contract returns null.
        return null;
      }
    },
  };
}
