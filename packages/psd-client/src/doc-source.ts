import { deserialize } from "@unidocs/doctype-psd/engine";
import type { BlobStore, PsdDoc } from "@unidocs/doctype-psd/engine";

/** Cold-starts a lazy in-browser {@link PsdDoc}: fetches the current IR JSON
 *  bytes directly from the gateway's `GET .../ir` endpoint and deserializes
 *  them. Layer pixels stay as unresolved CAS refs until faulted in during
 *  render, so `store` is still needed for that later resolution — but is no
 *  longer used to fetch the IR itself.
 *
 *  The IR is NOT reachable via `GET .../snapshot` + the user-scoped CAS: the
 *  snapshot hash is a 16-char durable-storage key (R2 `BlobCas`, see
 *  `computeHash` in server-core), not a 64-char user-CAS node hash, so
 *  fetching it through `store.get(hash)` 400s ("Invalid hash"). `/ir` hands
 *  the bytes back directly instead. */
export async function loadDoc(opts: {
  gw: string;
  user: string;
  type: string;
  docId: string;
  store: BlobStore;
  fetchImpl?: typeof fetch;
}): Promise<{ doc: PsdDoc; version: number }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fetchImpl(`${opts.gw}/users/${opts.user}/docs/${opts.type}/${opts.docId}/ir`);
  if (!res.ok) throw new Error(`loadDoc: GET ir failed with status ${res.status}`);
  const version = Number(res.headers.get("X-Doc-Version") ?? "0");
  const irBytes = new Uint8Array(await res.arrayBuffer());
  const doc = await deserialize(irBytes, opts.store);
  return { doc, version };
}
