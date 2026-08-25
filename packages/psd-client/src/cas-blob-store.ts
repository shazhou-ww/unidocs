import type { BlobStore } from "@unidocs/doctype-psd/engine";

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    const hash = toHex(digest);
    const res = await this.fetchImpl(`${this.apiBaseUrl}/cas/nodes/${hash}`, {
      method: "POST",
      body: bytes as BodyInit,
    });
    if (!res.ok) throw new Error(`CasBlobStore.put: unexpected status ${res.status} for hash "${hash}"`);
    return hash;
  }
}
