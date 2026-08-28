import { createHash } from "node:crypto";
import { createSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeContext, SBlob, SBlobData } from "@unidocs/protocol";

/**
 * Minimal content-addressed CAS matching DocumentTypeContext's editor surface:
 * `makeSBlob` hashes the bytes and keeps them (data AND the contentType they
 * were stored with); `readSBlob` returns exactly what was stored — it must
 * not hardcode a contentType, or every test asserting on it would really be
 * testing this stub, not the code under test. Shared by every test that
 * needs a `ctx` but doesn't care where the bytes end up — extracted because
 * it used to be copy-pasted into cas-snapshot.test.ts and cas-render.test.ts
 * verbatim.
 */
export function memCas(): { ctx: DocumentTypeContext; nodes: Map<string, Uint8Array> } {
  const nodes = new Map<string, Uint8Array>();
  const contentTypes = new Map<string, string>();
  const ctx: DocumentTypeContext = {
    async makeSBlob(dataOrHash: SBlobData | string, loadData?: () => Promise<SBlobData>): Promise<SBlob> {
      if (typeof dataOrHash === "string") {
        if (nodes.has(dataOrHash)) return createSBlob(dataOrHash);
        if (!loadData) throw new Error(`CAS node ${dataOrHash} not found`);
        const loaded = await loadData();
        nodes.set(dataOrHash, loaded.data);
        contentTypes.set(dataOrHash, loaded.contentType);
        return createSBlob(dataOrHash);
      }
      const hash = createHash("sha256").update(dataOrHash.data).digest("hex");
      if (!nodes.has(hash)) {
        nodes.set(hash, dataOrHash.data);
        contentTypes.set(hash, dataOrHash.contentType);
      }
      return createSBlob(hash);
    },
    async readSBlob(blob: SBlob): Promise<SBlobData> {
      const data = nodes.get(blob.hash);
      const contentType = contentTypes.get(blob.hash);
      if (!data || contentType === undefined) throw new Error(`CAS node ${blob.hash} not found`);
      return { data, contentType };
    },
  };
  return { ctx, nodes };
}
