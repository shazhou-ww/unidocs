import { createHash } from "node:crypto";
import type { DocumentTypeContext, SBlob, SBlobSource } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec";

export function createMemorySBlobContext(): {
  ctx: DocumentTypeContext;
  nodes: Map<string, Uint8Array>;
} {
  const nodes = new Map<string, Uint8Array>();
  const contentTypes = new Map<string, string>();
  const ctx: DocumentTypeContext = {
    async makeSBlob(sourceOrHash: SBlobSource | string, loadSource?: () => Promise<SBlobSource>): Promise<SBlob> {
      if (typeof sourceOrHash === "string") {
        if (nodes.has(sourceOrHash)) return createSBlob(sourceOrHash);
        if (!loadSource) throw new Error(`CAS node ${sourceOrHash} not found`);
        const source = await loadSource();
        const data = await sourceBytes(source);
        nodes.set(sourceOrHash, data);
        contentTypes.set(sourceOrHash, source.contentType);
        return createSBlob(sourceOrHash);
      }
      const data = await sourceBytes(sourceOrHash);
      const hash = createHash("sha256").update(data).digest("hex");
      if (!nodes.has(hash)) {
        nodes.set(hash, data);
        contentTypes.set(hash, sourceOrHash.contentType);
      }
      return createSBlob(hash);
    },
    async openSBlob(blob: SBlob) {
      const data = nodes.get(blob.hash);
      if (!data) throw new Error(`CAS node ${blob.hash} not found`);
      return {
        size: data.length,
        contentType: contentTypes.get(blob.hash) ?? "image/png",
        read: (range?: { offset: number; length?: number }) => ({
          async *[Symbol.asyncIterator]() {
            const start = range?.offset ?? 0;
            const end = range?.length === undefined ? data.length : start + range.length;
            yield data.slice(start, end);
          },
        }),
        readBytes: async (range: { offset: number; length: number }) =>
          data.slice(range.offset, range.offset + range.length),
      };
    },
  };
  return { ctx, nodes };
}

export function createReadOnlySBlobContext(): DocumentTypeContext {
  return {
    makeSBlob: undefined as unknown as DocumentTypeContext["makeSBlob"],
    async openSBlob() {
      throw new Error("read-only");
    },
  };
}

async function sourceBytes(source: SBlobSource): Promise<Uint8Array> {
  if ("data" in source) return source.data.slice();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source.body) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
