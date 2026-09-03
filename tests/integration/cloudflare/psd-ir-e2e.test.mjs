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

/**
 * Real-worker coverage for the CF side of two final-review fixes — neither
 * had any test touching the actual `EditorDO` before this (its route logic
 * only runs under a real Durable Object, so a plain vitest unit test can't
 * reach it; `packages/cloudflare-sdk/tests/` has nothing for
 * `editor-do-svalue.ts`, and `http-conformance-suite.mjs`'s `format=missing`
 * coverage is dead code — nothing in this repo ever calls
 * `runHttpConformanceSuite`):
 *
 *  - Important 2: an unregistered `format` on `/_internal/create` (import)
 *    used to fall into the generic `catch` (`CasClientError` or 500) because
 *    `selectFormat`'s plain `Error` wasn't special-cased — now
 *    `UnknownFormatError`/`AmbiguousFormatError` map to 400 there too, same
 *    as the export branch's pre-existing manual 400.
 *  - M3: `?format=` (present but empty) used to hit `formats[""]` (always
 *    missing) and 400 instead of falling back to `defaultFormat` like a bare
 *    `/export` — `??` only catches a missing param, not an empty one.
 */
test("psd CF worker: unregistered format is 400 on both import and export, empty ?format= falls back to defaultFormat", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-psd-format-"));
  const ports = {
    gateway: 33897, psd: 33898, cas: 33901,
    admin: 33902, mockOidc: 33903, edge: 33904,
  };
  runtime = await startLocalRuntime({ docTypes: ["psd"], persistPath, ports });

  const psd = readFileSync(
    join(process.cwd(), "packages/doctype-psd/tests/fixtures/sample.psd"),
  );

  // Import: an explicit, unregistered `format` field must 400, not 500.
  const badImportForm = new FormData();
  badImportForm.append("file", new File([psd], "sample.psd", { type: "image/vnd.adobe.photoshop" }));
  badImportForm.append("format", "jpeg");
  const badImport = await closeFetch(`${runtime.urls.gateway}/tenants/alice/docs/psd/`, {
    method: "POST",
    body: badImportForm,
  });
  const badImportBody = await badImport.json();
  expect(badImport.status, JSON.stringify(badImportBody)).toBe(400);
  expect(badImportBody).toMatchObject({ success: false, error: "Unknown format: jpeg" });

  // Create a real document to exercise the export branch against.
  const goodForm = new FormData();
  goodForm.append("file", new File([psd], "sample.psd", { type: "image/vnd.adobe.photoshop" }));
  const created = await closeFetch(`${runtime.urls.gateway}/tenants/alice/docs/psd/`, {
    method: "POST",
    body: goodForm,
  });
  const createdBody = await created.json();
  expect(created.ok, JSON.stringify(createdBody)).toBe(true);
  const { docId } = createdBody;
  const exportUrl = `${runtime.urls.gateway}/tenants/alice/docs/psd/${docId}/export`;

  // Export: an unregistered format is still 400 (pre-existing behavior —
  // this branch is a manual lookup, not `selectFormat` — kept as a control).
  const badExport = await closeFetch(`${exportUrl}?format=missing`);
  const badExportBody = await badExport.json();
  expect(badExport.status, JSON.stringify(badExportBody)).toBe(400);
  expect(badExportBody).toMatchObject({ success: false, error: "Unknown format: missing" });

  // Export: `?format=` (empty) must behave exactly like no `format` param at
  // all — both resolve to `defaultFormat` ("psd").
  const bareExport = await closeFetch(exportUrl);
  const emptyParamExport = await closeFetch(`${exportUrl}?format=`);
  expect(emptyParamExport.status, await emptyParamExport.clone().text()).toBe(200);
  expect(emptyParamExport.headers.get("content-type")).toBe(bareExport.headers.get("content-type"));
  expect(emptyParamExport.headers.get("content-disposition")).toBe(bareExport.headers.get("content-disposition"));
}, 120_000);
