import { decodeSValue } from "@unidocs/core";
import { materializePsdDocFromStore } from "@unidocs/doctype-psd/engine";
import type { BlobStore, PsdDoc, PsdStoredDoc } from "@unidocs/doctype-psd/engine";

/** Cold-start a lazy in-browser PsdDoc from canonical PsdStoredDoc bytes. */
export async function loadDoc(opts: {
  gw: string;
  user: string;
  type: string;
  docId: string;
  store: BlobStore;
  fetchImpl?: typeof fetch;
}): Promise<{ doc: PsdDoc; version: number; snapshot: Uint8Array }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fetchImpl(`${opts.gw}/users/${opts.user}/docs/${opts.type}/${opts.docId}/ir`);
  if (!res.ok) throw new Error(`loadDoc: GET current state failed with status ${res.status}`);
  const version = Number(res.headers.get("X-Doc-Version") ?? "0");
  const snapshot = new Uint8Array(await res.arrayBuffer());
  const state = decodeSValue(snapshot) as unknown as PsdStoredDoc;
  const doc = await materializePsdDocFromStore(state, opts.store);
  return { doc, version, snapshot };
}
