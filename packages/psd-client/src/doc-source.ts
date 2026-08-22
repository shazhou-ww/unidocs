import { deserialize } from "@unidocs/doctype-psd/engine";
import type { BlobStore, PsdDoc } from "@unidocs/doctype-psd/engine";

interface SnapshotResponse {
  success: boolean;
  version: number;
  hash: string;
  docType: string;
  docId: string;
}

/** Cold-starts a lazy in-browser {@link PsdDoc}: fetches the current
 *  snapshot (version + IR hash) from the gateway, pulls the IR JSON bytes
 *  through the CAS-backed {@link BlobStore}, and deserializes it. Layer
 *  pixels stay as unresolved CAS refs until faulted in during render. */
export async function loadDoc(opts: {
  gw: string;
  user: string;
  type: string;
  docId: string;
  store: BlobStore;
  fetchImpl?: typeof fetch;
}): Promise<{ doc: PsdDoc; version: number }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fetchImpl(`${opts.gw}/users/${opts.user}/docs/${opts.type}/${opts.docId}/snapshot`);
  if (!res.ok) throw new Error(`loadDoc: unexpected status ${res.status} fetching snapshot for doc "${opts.docId}"`);
  const snap = (await res.json()) as SnapshotResponse;

  const ir = await opts.store.get(snap.hash);
  if (ir === null) throw new Error(`IR blob missing for hash "${snap.hash}" (doc "${opts.docId}")`);

  const doc = await deserialize(ir, opts.store);
  return { doc, version: snap.version };
}
