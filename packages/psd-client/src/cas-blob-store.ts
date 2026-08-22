import type { BlobStore } from "@unidocs/doctype-psd/engine";

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HTTP-backed {@link BlobStore} that fetches/stores PSD layer blobs against
 *  the CAS gateway (`{gw}/users/{user}/cas/nodes/{hash}`). */
export class CasBlobStore implements BlobStore {
  private readonly gw: string;
  private readonly user: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { gw: string; user: string; fetchImpl?: typeof fetch }) {
    this.gw = opts.gw;
    this.user = opts.user;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${this.gw}/users/${this.user}/cas/nodes/${hash}/content`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CasBlobStore.get: unexpected status ${res.status} for hash "${hash}"`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    const hash = toHex(digest);
    const res = await this.fetchImpl(`${this.gw}/users/${this.user}/cas/nodes/${hash}`, {
      method: "POST",
      body: bytes as BodyInit,
    });
    if (!res.ok) throw new Error(`CasBlobStore.put: unexpected status ${res.status} for hash "${hash}"`);
    return hash;
  }
}
