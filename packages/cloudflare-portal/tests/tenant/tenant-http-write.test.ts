import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@unidocs/portal-service";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { createLocationValidator } from "../../src/tenant/location-validator.js";
import { createTenantHttp } from "../../src/tenant/tenant-http.js";
import type { CommittedTenantWrite } from "../../src/tenant/operator-dispatch.js";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const tenant: TenantContext = { tenantId: "t-local", principalId: "user-local", transport: "session", sessionHash: "h" };
const agent: TenantContext = {
  tenantId: "t-local", principalId: "agent:markdown-primary", transport: "bearer",
  scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
};

let real: RealD1;
let handle: ReturnType<typeof createTenantHttp>;
let committed: ReturnType<typeof vi.fn<(write: CommittedTenantWrite) => void>>;

const snapshots: SnapshotStore = {
  read: async () => new ReadableStream({ start(controller) { controller.close(); } }),
  retain: async () => {},
  release: async () => {},
};

beforeEach(async () => {
  real = await startRealD1();
  handle = createTenantHttp({
    catalog: new D1TenantCatalogRepository(real.db),
    documents: new D1TenantDocumentRepository(real.db),
    versions: new D1TenantVersionRepository(real.db, snapshots),
    threads: new D1TenantThreadRepository(real.db),
    validateLocation: createLocationValidator(),
    onCommitted: committed = vi.fn(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await real.dispose();
});

async function enableDocumentType(documentType: string) {
  await real.db.prepare(
    "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, '{}', '2026-09-14T00:00:00.000Z')",
  ).bind(documentType, documentType).run();
}

/**
 * Task 6's seed plus the markdown type and its contract revision 0: creating a
 * thread loads the comment anchor by joining the version to
 * portal_document_contracts, which in turn references portal_document_types.
 */
async function seedDocumentWithVersion(documentId: string) {
  await real.db.prepare(
    "INSERT OR IGNORE INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, '{}', '2026-09-14T00:00:00.000Z')",
  ).run();
  await real.db.prepare(
    "INSERT OR IGNORE INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES ('markdown', 0, 'sha256:contract', ?, 0)",
  ).bind(JSON.stringify({
    documentType: "markdown",
    documentContractIdx: 0,
    formatVersion: 1,
    snapshot: {
      contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" },
      schemaHash: "sha256:snapshot",
    },
    location: {
      contentType: "application/vnd.unidocs.markdown.location+json;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      schemaHash: "sha256:location",
    },
    contractHash: "sha256:contract",
    createdAt: "2026-09-14T00:00:00.000Z",
  })).run();
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', ?, 'Notes', 'markdown', 0, 1757808000)",
  ).bind(documentId).run();
  await real.db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
     VALUES ('t-local', ?, 0, NULL, 0, 'agent:test', 'sub-0', '[]', 'hash', 4, 'application/vnd.unidocs.markdown.snapshot+cbor;version=1', 1757808000)`,
  ).bind(documentId).run();
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}, caller: TenantContext = tenant) =>
  handle(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), caller, "req-1");

async function count(table: string) {
  const row = await real.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// R10: an Agent bearer reads the tenant API and submits; it never takes the
// browser's write paths. Each body here is one the session caller's tests
// above accept, so a 403 can only come from the transport.
describe("tenant HTTP writes refuse an Agent bearer", () => {
  it("refuses POST documents with 403 and creates nothing", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" }, agent);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "forbidden", message: expect.any(String), requestId: "req-1" } });
    expect(await count("portal_documents")).toBe(0);
  });

  it("refuses moving the current version with 403", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/current-version", {
      observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "agent",
    }, {}, agent);
    expect(response.status).toBe(403);
  });

  it("refuses creating a thread and appending a comment with 403", async () => {
    await seedDocumentWithVersion("doc-1");
    const created = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 0, content: { text: "first", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" }, agent);
    expect(created.status).toBe(403);
    expect(await count("portal_comments")).toBe(0);

    const thread = await (await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 0, content: { text: "first", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" })).json() as { threadId: string };
    const appended = await post(`/api/v1/tenants/t-local/documents/doc-1/threads/${thread.threadId}/comments`, {
      baseVersionIdx: 0, content: { text: "second", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "c1" }, agent);
    expect(appended.status).toBe(403);
    expect(await count("portal_comments")).toBe(1);
    // Only the session's thread creation above committed.
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("refuses issuing a CAS capability with 403, not 503", async () => {
    const response = await post("/api/v1/tenants/t-local/cas-capabilities", {}, {}, agent);
    expect(response.status).toBe(403);
  });
});

describe("tenant HTTP writes", () => {
  it("creates a document with 201 and currentVersionIdx null", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ name: "Notes", documentType: "markdown", currentVersionIdx: null });
  });

  it("replays the same idempotency key without creating a second document", async () => {
    await enableDocumentType("markdown");
    const first = await (await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" })).json() as { documentId: string };
    const second = await (await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" })).json() as { documentId: string };
    expect(second.documentId).toBe(first.documentId);
    const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_documents").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("refuses a disabled document type with 409 document_type_disabled", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_type_disabled" } });
  });

  it("requires an idempotency key on creation", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" });
    expect(response.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const response = await handle(new Request(`${ORIGIN}/api/v1/tenants/t-local/documents`, {
      method: "POST", headers: { "content-type": "text/plain", "idempotency-key": "k1" }, body: "hello",
    }), tenant, "req-1");
    expect(response.status).toBe(400);
    // "hello" would also fail strict parsing and schema validation; only the
    // message shows the content-type check itself refused it.
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "A JSON request body is required", requestId: "req-1" },
    });
  });

  it("rejects a body with a duplicate key", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", '{"documentType":"markdown","name":"a","name":"b"}', { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    // Padded with insignificant whitespace so the request is otherwise valid:
    // a 200 000-character name would be refused by the service's name limit
    // even without the body bound.
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", `{"documentType":"markdown","name":"Notes"${" ".repeat(200_000)}}`, { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
  });

  it("rejects a schema-invalid body in the contract's invalid_request shape without logging it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: 42, name: "x" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("The request is invalid");
    expect(logged).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body without logging it as a failed operation", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post("/api/v1/tenants/t-local/documents", '{"documentType":', { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", requestId: "req-1" } });
    expect(logged).not.toHaveBeenCalled();
  });

  it("carries the current pointer in details on a version conflict", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/current-version", {
      observedCurrentVersionIdx: 7, targetVersionIdx: 0, reason: "stale",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "version_conflict", message: expect.any(String), requestId: "req-1", details: { currentVersionIdx: 0 } },
    });
  });

  it("answers 404 when moving the pointer of a missing document", async () => {
    const response = await post("/api/v1/tenants/t-local/documents/missing/current-version", {
      observedCurrentVersionIdx: null, targetVersionIdx: 0, reason: "x",
    });
    expect(response.status).toBe(404);
  });

  it("creates a thread against an existing version and appends to it", async () => {
    await seedDocumentWithVersion("doc-1");
    const created = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 0, content: { text: "first", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    expect(created.status).toBe(201);
    const thread = await created.json() as { threadId: string; comments: unknown[] };
    expect(thread.comments).toHaveLength(1);

    const appended = await post(`/api/v1/tenants/t-local/documents/doc-1/threads/${thread.threadId}/comments`, {
      baseVersionIdx: 0, content: { text: "second", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "c1" });
    expect(appended.status).toBe(201);
    await expect(appended.json()).resolves.toMatchObject({ commentIdx: 1 });
  });

  it("refuses a thread on a version that does not exist", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 9, content: { text: "x", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    expect(response.status).toBe(404);
  });
});

// The Operator is told about a write only once the service has committed it.
describe("tenant HTTP writes notify onCommitted", () => {
  it("reports a created document exactly once, and again on an idempotent replay", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(201);
    const { documentId } = await response.json() as { documentId: string };
    expect(committed.mock.calls).toEqual([[{ kind: "document.created", tenantId: "t-local", documentId }]]);

    await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(committed).toHaveBeenCalledTimes(2);
    expect(committed.mock.calls[1]).toEqual([{ kind: "document.created", tenantId: "t-local", documentId }]);
  });

  it("does not report a document the service refused", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(409);
    expect(committed).not.toHaveBeenCalled();
  });

  it("does not report a write refused to an Agent bearer", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" }, agent);
    expect(response.status).toBe(403);
    expect(committed).not.toHaveBeenCalled();
  });

  it("reports a new thread as comment 0 and an appended comment with its commentIdx", async () => {
    await seedDocumentWithVersion("doc-1");
    const created = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 0, content: { text: "first", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    const { threadId } = await created.json() as { threadId: string };
    expect(committed.mock.calls).toEqual([[{ kind: "comment.appended", tenantId: "t-local", documentId: "doc-1", threadId, commentIdx: 0 }]]);

    const appended = await post(`/api/v1/tenants/t-local/documents/doc-1/threads/${threadId}/comments`, {
      baseVersionIdx: 0, content: { text: "second", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "c1" });
    expect(appended.status).toBe(201);
    expect(committed).toHaveBeenCalledTimes(2);
    expect(committed.mock.calls[1]).toEqual([{ kind: "comment.appended", tenantId: "t-local", documentId: "doc-1", threadId, commentIdx: 1 }]);
  });

  it("does not report a thread on a version that does not exist", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 9, content: { text: "x", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    expect(response.status).toBe(404);
    expect(committed).not.toHaveBeenCalled();
  });

  it("reports a moved current version, and not a conflicting move", async () => {
    await seedDocumentWithVersion("doc-1");
    const conflict = await post("/api/v1/tenants/t-local/documents/doc-1/current-version", {
      observedCurrentVersionIdx: 7, targetVersionIdx: 0, reason: "stale",
    });
    expect(conflict.status).toBe(409);
    expect(committed).not.toHaveBeenCalled();

    const moved = await post("/api/v1/tenants/t-local/documents/doc-1/current-version", {
      observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "restore",
    });
    expect(moved.status).toBe(200);
    expect(committed.mock.calls).toEqual([[{ kind: "current_version.moved", tenantId: "t-local", documentId: "doc-1" }]]);
  });
});
