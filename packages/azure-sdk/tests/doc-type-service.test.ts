/**
 * `startDocTypeService()` 的行为:它必须起一个能完整走 create → apply →
 * query 的服务,并且**每个请求新建一个 DocumentSession**（见
 * local-editor.ts 的模块注释：这是多副本正确性的前提，不是可以之后用
 * LRU 优化掉的实现细节）。
 */
import { afterEach, expect, test } from "vitest";
import { createSBlob } from "@unidocs/core";
import type { DocumentType, SBlob } from "@unidocs/core";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { startDocTypeService } from "../src/doc-type-service.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

const INTERNAL_TOKEN = "test-token";
let handle: { url: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

interface CasProbeDoc {
  blob: SBlob;
}

interface CasProbeOp {
  kind: "noop";
}

const PROBE_HASH = "d".repeat(64);

/**
 * A minimal synthetic `DocumentType` whose TDoc carries a branded SBlob.
 * JSON apply payloads cannot transport the SBlob brand, so this probe pins
 * refs at create() via collectSBlobRefs(init()), which hits updateRootRefs
 * on the 501 CAS stub.
 */
function createCasProbeDocumentType(): DocumentType<CasProbeDoc, unknown, CasProbeOp> {
  return {
    init: async () => ({ blob: createSBlob(PROBE_HASH) }),
    query: async () => null,
    apply: async (_operations, doc) => doc,
    formats: {
      text: {
        mediaTypes: ["text/plain"],
        extensions: [".txt"],
        load: async () => ({ blob: createSBlob(PROBE_HASH) }),
        save: async () => new TextEncoder().encode("{}"),
      },
    },
    defaultFormat: "text",
    contentType: "text/plain",
    tools: {},
    instructions: "",
  };
}

async function start(
  port: number,
  overrides: { docType?: string; documentType?: DocumentType<any, any, any> } = {},
) {
  const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
  await pool.end();
  return startDocTypeService({
    docType: overrides.docType ?? "markdown",
    documentType: overrides.documentType ?? createMarkdownDocumentType({}),
    port,
    host: "127.0.0.1",
    config: {
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      internalToken: INTERNAL_TOKEN,
    },
  });
}

function internal(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      "X-Internal-Token": INTERNAL_TOKEN,
      "X-User-Id": "u1",
      "X-Doc-Type": "markdown",
      ...(init.headers ?? {}),
    },
  });
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  // `createDocTypeHandler` (server-core) parses `/users/{userId}/{docId}/{method}`
  // — the shape it receives *after* a gateway has already stripped `/docs/{docType}`
  // (see doc-type-handler.ts's module doc). This test calls the service directly,
  // with no gateway in front, so it must send that already-stripped shape itself.
  // Creation in particular is a bare `POST /users/{userId}/` (docId comes back in
  // the response, or can be pinned via `X-Doc-Id` as done here) — there is no
  // `/create` method route.
  const docId = `svc-${Date.now()}`;

  const created = await internal(handle.url, "/users/u1/", {
    method: "POST",
    headers: { "X-Doc-Id": docId },
  });
  expect((await created.json()).success).toBe(true);

  const applied = await internal(handle.url, `/users/u1/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, `/users/u1/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });
});

/**
 * Replaces a prior version of this test that hit `/users/u1/cas/nodes/...`
 * directly. That request 404s inside `createDocTypeHandler`'s own router
 * before `buildDeps()`'s `cas` construction is ever touched — `"cas"` isn't
 * a `docId` any editor/operator method recognizes, and `doc-type-handler.ts`
 * has no CAS route at all (that only exists in `gateway-handler.ts`, which
 * isn't wired into `startDocTypeService`). It asserted `[404, 501]`, which
 * meant it passed unconditionally regardless of whether the CAS stub wiring
 * in `doc-type-service.ts` was correct.
 *
 * This version reaches the stub for real: `createCasProbeDocumentType()`'s
 * `refsFromOp` returns a non-empty ref, so `apply()`'s `leaseOpRefs` call
 * actually invokes `deps.cas.leaseExisting("deadbeef")`, which goes through
 * `CasClient` to the 501 stub fetcher `doc-type-service.ts` wires up when
 * `casBaseUrl` is absent. The stub's 501 becomes a `CasClientError(501, ...)`
 * that `DocumentSession.apply()` lets propagate unchanged (session.ts step
 * 1's comment: "A CasClientError propagates verbatim"), and
 * `session-handler.ts`'s `errorResponse()` maps any `CasClientError` whose
 * status isn't 409 or 404 to HTTP 502 — so 502 is the status the code under
 * test actually produces, not a guess.
 */
test("without casBaseUrl, create() pinning TDoc SBlobs hits the 501 stub and surfaces as 502", async () => {
  handle = await start(41998, {
    docType: "cas-probe",
    documentType: createCasProbeDocumentType(),
  });
  const docId = `cas-probe-${Date.now()}`;

  const created = await internal(handle.url, "/users/u1/", {
    method: "POST",
    headers: { "X-Doc-Id": docId },
  });

  expect(created.status).toBe(502);
  const body = await created.json();
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/updateRootRefs/);
  expect(body.error).toMatch(/501/);
});
