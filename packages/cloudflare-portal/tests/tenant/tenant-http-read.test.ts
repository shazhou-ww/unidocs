import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@unidocs/portal-service";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { createLocationValidator } from "../../src/tenant/location-validator.js";
import { createTenantHttp } from "../../src/tenant/tenant-http.js";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const tenant: TenantContext = { tenantId: "t-local", principalId: "user-local", transport: "session", sessionHash: "h" };
const SNAPSHOT_BYTES = new Uint8Array([0xa1, 0x61, 0x63, 0x60]);

let real: RealD1;
let handle: ReturnType<typeof createTenantHttp>;

const snapshots: SnapshotStore = {
  read: async () => new ReadableStream({ start(controller) { controller.enqueue(SNAPSHOT_BYTES); controller.close(); } }),
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
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await real.dispose();
});

async function seedDocumentWithVersion(documentId: string) {
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', ?, 'Notes', 'markdown', 0, 1757808000)",
  ).bind(documentId).run();
  await real.db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
     VALUES ('t-local', ?, 0, NULL, 0, 'agent:test', 'sub-0', '[]', 'hash', 4, 'application/vnd.unidocs.markdown.snapshot+cbor;version=1', 1757808000)`,
  ).bind(documentId).run();
}

const get = (path: string) => handle(new Request(`${ORIGIN}${path}`), tenant, "req-1");

describe("tenant HTTP reads", () => {
  it("lists documents as a page", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents");
    expect(response.status).toBe(200);
    const body = await response.json() as { items: { documentId: string }[]; nextCursor: string | null };
    expect(body.items.map(item => item.documentId)).toEqual(["doc-1"]);
    expect(body.nextCursor).toBeNull();
  });

  it("coerces a numeric limit from the query string", async () => {
    await seedDocumentWithVersion("doc-1");
    await seedDocumentWithVersion("doc-2");
    const response = await get("/api/v1/tenants/t-local/documents?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  it("returns 404 in the contract's error shape for a missing document", async () => {
    const response = await get("/api/v1/tenants/t-local/documents/missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String), requestId: "req-1" },
    });
  });

  it("refuses another tenant's path with 403", async () => {
    const response = await get("/api/v1/tenants/t-other/documents");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("streams a snapshot with the derived vendor content type", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents/doc-1/versions/0/snapshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.unidocs.markdown.snapshot+cbor;version=1");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SNAPSHOT_BYTES);
  });

  it("answers 503 unavailable for CAS capabilities, which v0 does not issue", async () => {
    const response = await handle(new Request(`${ORIGIN}/api/v1/tenants/t-local/cas-capabilities`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), tenant, "req-1");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unavailable" } });
  });

  it("does not leak an unexpected error's message", async () => {
    const exploding = createTenantHttp({
      catalog: new D1TenantCatalogRepository(real.db),
      documents: { ...new D1TenantDocumentRepository(real.db), list: async () => { throw new Error("SELECT secret_column FROM portal_documents"); } } as never,
      versions: new D1TenantVersionRepository(real.db, snapshots),
      threads: new D1TenantThreadRepository(real.db),
      validateLocation: createLocationValidator(),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await exploding(new Request(`${ORIGIN}/api/v1/tenants/t-local/documents`), tenant, "req-1");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret_column");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Tenant operation failed", requestId: "req-1" } });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({ event: "portal_operation_failed", name: "Error", requestId: "req-1" });
  });

  it("answers an unmatched route under the tenant base path with 404 in the contract's error shape", async () => {
    const response = await get("/api/v1/tenants/t-local/no-such-resource");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "The requested resource was not found", requestId: "req-1" },
    });
  });

  it("lists thread references for a document", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents/doc-1/threads?open=true");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });
});
