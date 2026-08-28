import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSValue } from "../../../packages/svalue-codec/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

/**
 * `/ir` on a doc type whose SValue actually carries SBlob refs.
 *
 * The markdown coverage in `http-conformance-suite.mjs` cannot catch a missing
 * CAS grant on `ir`: a markdown doc is `{ content: "..." }` with zero refs, so
 * `#refreshCurrentRefs()` resolves an empty `Promise.all([])` and never reaches
 * the CAS client. A psd doc externalizes layer pixels into SBlobs, so the same
 * code path performs a real CAS read — which is why `ir` must be granted
 * `cas:read` (and must count as a read-only operation, so the ref check uses
 * `metadata` rather than renewing a lease).
 */
test("psd /ir returns canonical bytes for a doc whose refs live in CAS", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-psd-ir-"));
  const ports = {
    gateway: 33887, psd: 33888, cas: 33891,
    admin: 33892, mockOidc: 33893, edge: 33894,
  };
  runtime = await startLocalRuntime({ docTypes: ["psd"], persistPath, ports });

  const psd = readFileSync(
    join(process.cwd(), "packages/doctype-psd/tests/fixtures/sample.psd"),
  );
  const form = new FormData();
  form.append("file", new File([psd], "sample.psd", { type: "image/vnd.adobe.photoshop" }));
  const created = await closeFetch(`${runtime.urls.gateway}/tenants/alice/docs/psd/`, {
    method: "POST",
    body: form,
  });
  const createdBody = await created.json();
  expect(created.ok, JSON.stringify(createdBody)).toBe(true);
  const { docId } = createdBody;

  const ir = await closeFetch(
    `${runtime.urls.gateway}/tenants/alice/docs/psd/${docId}/ir`,
  );
  expect(ir.status, await ir.clone().text()).toBe(200);
  expect(ir.headers.get("content-type")).toBe(SValueContentType);
  expect(Number(ir.headers.get("X-Doc-Version"))).toBeGreaterThanOrEqual(1);

  const state = decodeSValue(new Uint8Array(await ir.arrayBuffer()));
  // sample.psd has layers; an empty doc would mean the import never landed and
  // the CAS ref check had nothing to verify, making the assertion vacuous.
  expect(Array.isArray(state.layers)).toBe(true);
  expect(state.layers.length).toBeGreaterThan(0);
}, 120_000);
