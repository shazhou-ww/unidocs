import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unicas/tenant-protocol";
import type { DocumentTypeContext, MakeSBlob, SBlob, SBlobBytes, SBlobSource } from "@unidocs/protocol";
import { SValueContentType } from "@unidocs/protocol";
import { createSBlob, decodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { createDocxDocumentType } from "../src/index.js";

export interface TestDocumentTypeContext extends DocumentTypeContext {
  readonly stored: ReadonlyMap<string, SBlobBytes>;
}

export function createTestContext(): TestDocumentTypeContext {
  const stored = new Map<string, SBlobBytes>();

  async function store(source: SBlobSource): Promise<SBlob> {
    const bytes = "data" in source ? source.data.slice() : await collect(source.body);
    const refs = source.contentType === SValueContentType
      ? decodeSValueWithRefs(bytes).refs
      : [];
    const childHashes = refs.map(hexToHash);
    const header = encodeHeader(bytes.length, source.contentType, childHashes.length);
    const hash = hashToHex(await computeNodeDigest(
      header,
      source.contentType,
      childHashes,
      bytes,
    ));
    stored.set(hash, Object.freeze({ data: bytes, contentType: source.contentType }));
    return createSBlob(hash);
  }

  const makeSBlob = (async (
    input: string | SBlobSource,
    loadData?: () => Promise<SBlobSource>,
  ): Promise<SBlob> => {
    if (typeof input !== "string") return store(input);
    if (stored.has(input)) return createSBlob(input);
    if (!loadData) throw new Error(`Missing test SBlob ${input}`);
    const blob = await store(await loadData());
    if (blob.hash !== input) {
      throw new Error(`Test SBlob digest mismatch: expected ${input}, got ${blob.hash}`);
    }
    return blob;
  }) as MakeSBlob;

  return Object.freeze({
    makeSBlob,
    openSBlob: async (blob: SBlob) => {
      const data = stored.get(blob.hash);
      if (!data) throw new Error(`Missing test SBlob ${blob.hash}`);
      return Object.freeze({
        size: data.data.length,
        contentType: data.contentType,
        read: (range?: { offset: number; length?: number }) => ({
          async *[Symbol.asyncIterator]() {
            const start = range?.offset ?? 0;
            const end = range?.length === undefined ? data.data.length : start + range.length;
            yield data.data.slice(start, end);
          },
        }),
        readBytes: async (range: { offset: number; length: number }) =>
          data.data.slice(range.offset, range.offset + range.length),
      });
    },
    stored,
  });
}

export function createTestDocx(context = createTestContext()) {
  return { context, docx: createDocxDocumentType(context) };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
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