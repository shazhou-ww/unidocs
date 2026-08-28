import { createHash } from "node:crypto";
import { createSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeContext, SBlob, SBlobData } from "@unidocs/protocol";

/**
 * Minimal content-addressed CAS matching DocumentTypeContext's editor surface:
 * `makeSBlob` hashes the bytes and keeps them; `readSBlob` returns them
 * verbatim. Shared by every test that needs a `ctx` but doesn't care where
 * the bytes end up — extracted because it used to be copy-pasted into
 * cas-snapshot.test.ts and cas-render.test.ts verbatim.
 */
export function memCas(): { ctx: DocumentTypeContext; nodes: Map<string, Uint8Array> } {
  const nodes = new Map<string, Uint8Array>();
  const ctx: DocumentTypeContext = {
    async makeSBlob(dataOrHash: SBlobData | string, loadData?: () => Promise<SBlobData>): Promise<SBlob> {
      if (typeof dataOrHash === "string") {
        if (nodes.has(dataOrHash)) return createSBlob(dataOrHash);
        if (!loadData) throw new Error(`CAS node ${dataOrHash} not found`);
        const loaded = await loadData();
        nodes.set(dataOrHash, loaded.data);
        return createSBlob(dataOrHash);
      }
      const hash = createHash("sha256").update(dataOrHash.data).digest("hex");
      if (!nodes.has(hash)) nodes.set(hash, dataOrHash.data);
      return createSBlob(hash);
    },
    async readSBlob(blob: SBlob): Promise<SBlobData> {
      const data = nodes.get(blob.hash);
      if (!data) throw new Error(`CAS node ${blob.hash} not found`);
      return { data, contentType: "image/png" };
    },
  };
  return { ctx, nodes };
}
