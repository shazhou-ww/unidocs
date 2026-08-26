import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unicas/server-common";
import type { DocumentTypeContext, MakeSBlob, SBlob, SBlobData } from "@unidocs/protocol";
import { SValueContentType } from "@unidocs/protocol";
import { createSBlob, decodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { createDocxDocumentType } from "../src/index.js";

export interface TestDocumentTypeContext extends DocumentTypeContext {
  readonly stored: ReadonlyMap<string, SBlobData>;
}

export function createTestContext(): TestDocumentTypeContext {
  const stored = new Map<string, SBlobData>();

  async function store(data: SBlobData): Promise<SBlob> {
    const bytes = data.data.slice();
    const refs = data.contentType === SValueContentType
      ? decodeSValueWithRefs(bytes).refs
      : [];
    const childHashes = refs.map(hexToHash);
    const header = encodeHeader(bytes.length, data.contentType, childHashes.length);
    const hash = hashToHex(await computeNodeDigest(
      header,
      data.contentType,
      childHashes,
      bytes,
    ));
    stored.set(hash, Object.freeze({ data: bytes, contentType: data.contentType }));
    return createSBlob(hash);
  }

  const makeSBlob = (async (
    input: string | SBlobData,
    loadData?: () => Promise<SBlobData>,
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
    readSBlob: async (blob: SBlob) => {
      const data = stored.get(blob.hash);
      if (!data) throw new Error(`Missing test SBlob ${blob.hash}`);
      return Object.freeze({ data: data.data.slice(), contentType: data.contentType });
    },
    stored,
  });
}

export function createTestDocx(context = createTestContext()) {
  return { context, docx: createDocxDocumentType(context) };
}