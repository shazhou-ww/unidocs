import type { DocumentTypeContext } from "@unidocs/protocol";
import type { BlobStore } from "../render/pixel-source.js";

/**
 * Bridges the doctype-local content-addressed `BlobStore` (`put`/`get` by hash)
 * onto the runtime `DocumentTypeContext` (SValue protocol). `put` uploads PNG
 * bytes through `ctx.makeSBlob` (which stores to CAS and returns an SBlob with
 * the content hash); `get` reads a blob by hash via `ctx.readSBlob`.
 *
 * Only build this when a write-capable context is available — `put` requires
 * `ctx.makeSBlob` to be functional.
 */
export function casBlobStore(ctx: DocumentTypeContext): BlobStore {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const blob = await ctx.makeSBlob({ data: bytes, contentType: "image/png" });
      return blob.hash;
    },
    async get(hash: string): Promise<Uint8Array | null> {
      try {
        const blob = await ctx.makeSBlob(hash, async () => {
          throw new Error(`BlobStore.get: CAS read failed for ${hash}`);
        });
        const data = await ctx.readSBlob(blob);
        return data.data;
      } catch {
        return null;
      }
    },
  };
}
