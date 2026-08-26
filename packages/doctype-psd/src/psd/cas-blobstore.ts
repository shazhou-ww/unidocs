import type { DocumentTypeContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec";
import type { BlobStore } from "../render/pixel-source.js";

/**
 * Bridges the doctype-local content-addressed `BlobStore` (`put`/`get` by hash)
 * onto the runtime `DocumentTypeContext` (SValue protocol). `put` uploads PNG
 * bytes through `ctx.makeSBlob` (which stores to CAS and returns an SBlob with
 * the content hash); `get` reads a blob by hash via `ctx.readSBlob`.
 *
 * Only build this when a write-capable context is available — `put` requires
 * `ctx.makeSBlob` to be functional.
 *
 * `get` reads and only reads. It used to go through `ctx.makeSBlob(hash, …)`
 * first, whose `#ensure` path calls `leaseExisting()` — and a lease is a
 * **write**-class CAS operation (it moves the node's expiry forward). Under
 * Gateway-issued capabilities a `query`/`export` operation is delegated
 * `cas:read` only, so that lease was rejected on every preview render. The
 * pixels a read needs are already pinned by the document's root refs, so
 * re-leasing them on read bought nothing and cost the whole read path.
 */
export function casBlobStore(ctx: DocumentTypeContext): BlobStore {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const blob = await ctx.makeSBlob({ data: bytes, contentType: "image/png" });
      return blob.hash;
    },
    async get(hash: string): Promise<Uint8Array | null> {
      try {
        const data = await ctx.readSBlob(createSBlob(hash));
        return data.data;
      } catch (err) {
        // 只有"确实不存在"才是 null。其余错误——鉴权被拒、网络不通、
        // 内容摘要不匹配——必须冒泡:此前这里是个裸 catch，把 401 伪装成
        // "blob 不存在"，于是 `PixelSource: no blob found in store` 这条
        // 消息会把排查引向数据缺失，而真正的原因是权限。
        if (typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404) {
          return null;
        }
        throw err;
      }
    },
  };
}
