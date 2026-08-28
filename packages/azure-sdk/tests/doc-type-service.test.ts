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
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "../../service-auth/src/index.js";
import type { CapabilityPermission, VerifiedCapability } from "../../service-auth/src/index.js";
import { startDocTypeService } from "../src/doc-type-service.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

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
  const docType = overrides.docType ?? "markdown";
  const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
  await pool.end();
  return startDocTypeService({
    docType,
    documentTypeFactory: overrides.documentType
      ? () => overrides.documentType!
      : createMarkdownDocumentType,
    port,
    host: "127.0.0.1",
    config: {
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      casStackId: "test-stack",
      docCapabilityVerifier: { verify: async token => verifyTestToken(token, "doc", docType) },
      casCapabilityVerifier: { verify: async token => verifyTestToken(token, "cas", docType) },
    },
  });
}

function internal(
  url: string,
  tenantId: string,
  sessionId: string,
  operation: "create" | "apply" | "query",
  init: RequestInit = {},
) {
  const suffix = operation === "create" ? "" : `/${operation}`;
  return fetch(`${url}/tenants/${tenantId}/sessions/${sessionId}${suffix}`, {
    ...init,
    headers: {
      Connection: "close",
      Authorization: `Bearer doc|${tenantId}|${sessionId}|${operation}`,
      "X-UniDocs-CAS-Capability": `cas|${tenantId}|${sessionId}|${operation}`,
      ...(init.headers ?? {}),
    },
  });
}

function verifyTestToken(token: string, expectedKind: "doc" | "cas", docType: string): VerifiedCapability {
  const [kind, tenantId, sessionId, operation] = token.split("|");
  if (kind !== expectedKind || !tenantId || !sessionId || !operation) throw new Error("invalid test token");
  const permissions: readonly CapabilityPermission[] = kind === "doc"
    ? operation === "create"
      ? [sessionCreatePermission(tenantId)]
      : operation === "query"
        ? [sessionReadPermission(tenantId, sessionId)]
        : [sessionWritePermission(tenantId, sessionId)]
    : operation === "create"
      ? [casWritePermission(tenantId)]
      : operation === "query"
        ? [casReadPermission(tenantId)]
        : [casReadPermission(tenantId), casWritePermission(tenantId)];
  return {
    protectedHeader: { alg: CapabilityAlgorithm, kid: "test-key", typ: CapabilityTokenType },
    claims: {
      ver: 1,
      iss: kind === "doc" ? "gateway" : "stack",
      sub: kind === "doc" ? "gateway" : `doc:${docType}`,
      aud: kind === "doc" ? `unidocs-doc:${docType}` : "unidocs-cas",
      iat: 1000,
      nbf: 995,
      exp: 1120,
      jti: `${kind}-jti`,
      tenantId,
      sessionId,
      permissions,
    },
  };
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  const sessionId = `svc-${Date.now()}`;

  const created = await internal(handle.url, "tenant-1", sessionId, "create", {
    method: "PUT",
  });
  const createdBody = await created.json();
  expect(createdBody, JSON.stringify(createdBody)).toMatchObject({ success: true });

  const applied = await internal(handle.url, "tenant-1", sessionId, "apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, "tenant-1", sessionId, "query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });

  const wrongTenant = await internal(handle.url, "another-tenant", sessionId, "query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
 * actually invokes `deps.cas.leaseNode("deadbeef")`, which goes through
 * the tenant CAS client to the 501 stub fetcher `doc-type-service.ts` wires up when
 * `casBaseUrl` is absent. The stub's 501 becomes a `CasClientError(501, ...)`
 * that `DocumentSession.apply()` lets propagate unchanged (session.ts step
 * 1's comment: "A CAS client error propagates verbatim"), and
 * `session-handler.ts`'s `errorResponse()` maps any `CasClientError` whose
 * status isn't 409 or 404 to HTTP 502 — so 502 is the status the code under
 * test actually produces, not a guess.
 */
test("without a CAS base URL, create() pinning TDoc SBlobs surfaces the 501 stub as 502", async () => {
  handle = await start(41998, {
    docType: "cas-probe",
    documentType: createCasProbeDocumentType(),
  });
  const sessionId = `cas-probe-${Date.now()}`;

  const created = await internal(handle.url, "tenant-1", sessionId, "create", {
    method: "PUT",
  });

  const body = await created.json();
  expect(created.status, JSON.stringify(body)).toBe(502);
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/updateRootRefs/);
  expect(body.error).toMatch(/501/);
});
