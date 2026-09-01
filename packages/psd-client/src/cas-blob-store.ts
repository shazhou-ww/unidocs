import {
  CanonicalNodeContentType,
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
} from "@unicas/codec";
import type { BlobStore } from "@unidocs/doctype-psd/engine";

const PIXEL_CONTENT_TYPE = "image/png";

/** HTTP-backed {@link BlobStore} against an authorized Gateway API base. */
export class CasBlobStore implements BlobStore {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiBaseUrl: string; fetchImpl?: typeof fetch }) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/cas/nodes/${hash}/content`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CasBlobStore.get: unexpected status ${res.status} for hash "${hash}"`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(bytes: Uint8Array): Promise<string> {
    const header = encodeHeader(bytes.length, PIXEL_CONTENT_TYPE, 0);
    const canonicalBytes = concatenateNodeBytes(
      header,
      new TextEncoder().encode(PIXEL_CONTENT_TYPE),
      [],
      bytes,
    );
    const hash = hashToHex(await computeNodeDigest(header, PIXEL_CONTENT_TYPE, [], bytes));
    const res = await this.fetchImpl(`${this.apiBaseUrl}/cas/nodes/${hash}/lease`, {
      method: "POST",
      headers: { "Content-Type": CanonicalNodeContentType },
      body: canonicalBytes as BodyInit,
    });
    if (!res.ok) throw new Error(`CasBlobStore.put: unexpected status ${res.status} for hash "${hash}"`);
    return hash;
  }
}
