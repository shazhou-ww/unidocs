/**
 * `startDocTypeService()` 的行为:它必须起一个能完整走 create → apply →
 * query 的服务,并且**每个请求新建一个 DocumentSession**（见
 * local-editor.ts 的模块注释：这是多副本正确性的前提，不是可以之后用
 * LRU 优化掉的实现细节）。
 */
import { afterEach, expect, test } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { DocumentType, SBlob } from "@unidocs/protocol";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { startDocTypeService } from "../src/doc-type-service.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

const SERVICE_ACCESS_KEY = "doc-key";
const CAS_ACCESS_KEY = "cas-key";
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
    documentTypeFactory: overrides.documentType
      ? () => overrides.documentType!
      : createMarkdownDocumentType,
    port,
    host: "127.0.0.1",
    config: {
      internalAuthMode: "legacy",
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      serviceAccessKey: SERVICE_ACCESS_KEY,
      casAccessKey: CAS_ACCESS_KEY,
    },
  });
}

function internal(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      "X-Internal-Token": SERVICE_ACCESS_KEY,
      "X-Tenant-Id": "tenant-1",
      "X-Session-Id": "session-1",
      "X-Doc-Type": "markdown",
      ...(init.headers ?? {}),
    },
  });
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  const sessionId = `svc-${Date.now()}`;

  const created = await internal(handle.url, `/sessions/${sessionId}`, {
    method: "PUT",
    headers: { "X-Session-Id": sessionId },
  });
  expect((await created.json()).success).toBe(true);

  const applied = await internal(handle.url, `/sessions/${sessionId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, `/sessions/${sessionId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });

  const wrongTenant = await internal(handle.url, `/sessions/${sessionId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
      "X-Tenant-Id": "another-tenant",
    },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(wrongTenant.status).toBe(404);
});

/**
 * Replaces a prior version of this test that hit an unrelated CAS path
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
  const sessionId = `cas-probe-${Date.now()}`;

  const created = await internal(handle.url, `/sessions/${sessionId}`, {
    method: "PUT",
    headers: { "X-Session-Id": sessionId },
  });

  expect(created.status).toBe(502);
  const body = await created.json();
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/updateRootRefs/);
  expect(body.error).toMatch(/501/);
});
