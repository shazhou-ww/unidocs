import { describe, expect, it, vi } from "vitest";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { databaseDouble } from "./d1-double.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

const addressedComments = [
  { threadId: "thread-1", commentIdx: 0, baseVersionIdx: 0 },
];

const CREATED_AT_SECONDS = Math.floor(Date.parse("2026-09-14T00:00:00.000Z") / 1000);

const row = (over: Record<string, unknown> = {}) => ({
  version_idx: 0,
  parent_version_idx: null,
  document_contract_idx: 0,
  author_agent_id: "agent-1",
  submission_id: "sub-1",
  addressed_comments_json: JSON.stringify(addressedComments),
  created_at: CREATED_AT_SECONDS,
  ...over,
});

function snapshotStoreDouble(body: ReadableStream<Uint8Array> = new ReadableStream()) {
  return {
    read: vi.fn().mockResolvedValue(body),
    retain: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("D1TenantVersionRepository.list", () => {
  it("orders by version_idx ascending (birth order) and restores addressedComments", async () => {
    const database = databaseDouble({
      rows: [row({ version_idx: 0 }), row({ version_idx: 1, parent_version_idx: 0 })],
    });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    const page = await repository.list(context, "doc-1", { limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.versionIdx).toBe(0);
    expect(page.items[1]?.versionIdx).toBe(1);
    expect(page.items[0]?.addressedComments).toEqual(addressedComments);
    expect(database.statements[0]?.sql).toContain("ORDER BY version_idx ASC");
  });

  it("returns a null cursor when the page is not full", async () => {
    const database = databaseDouble({ rows: [row()] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    const page = await repository.list(context, "doc-1", { limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it("returns a cursor and drops the probe row when a further page exists", async () => {
    const database = databaseDouble({
      rows: [row({ version_idx: 0 }), row({ version_idx: 1 })],
    });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    const page = await repository.list(context, "doc-1", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.versionIdx).toBe(0);
    expect(page.nextCursor).not.toBeNull();
  });

  it("binds the decoded cursor into the query as a version_idx keyset", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    const { encodeCursor } = await import("../../src/tenant/cursor.js");
    await repository.list(context, "doc-1", { cursor: encodeCursor({ at: 5, id: "5" }) });
    expect(database.statements[0]?.sql).toContain("version_idx > ?");
    expect(database.statements[0]?.args).toContain(5);
  });

  it("does not return another tenant's versions for the same document id", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    await repository.list({ ...context, tenantId: "t-other" }, "doc-1", {});
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });
});

describe("D1TenantVersionRepository.get", () => {
  it("returns the record when it exists, including a nullable parentVersionIdx", async () => {
    const database = databaseDouble({ firsts: [row({ version_idx: 2, parent_version_idx: null })] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    const record = await repository.get(context, "doc-1", 2);
    expect(record).not.toBeNull();
    expect(record?.versionIdx).toBe(2);
    expect(record?.parentVersionIdx).toBeNull();
  });

  it("returns null when it does not exist", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    await expect(repository.get(context, "doc-1", 99)).resolves.toBeNull();
  });

  it("scopes the lookup by tenant", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantVersionRepository(database, snapshotStoreDouble());
    await repository.get({ ...context, tenantId: "t-other" }, "doc-1", 0);
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });
});

describe("D1TenantVersionRepository.readSnapshot", () => {
  it("reads the CasBlobRef assembled from the row, tagged with the document's documentType", async () => {
    const body = new ReadableStream<Uint8Array>();
    const store = snapshotStoreDouble(body);
    const database = databaseDouble({
      firsts: [{
        snapshot_blob_hash: "hash-1",
        snapshot_size: 1024,
        snapshot_content_type: "application/cbor",
        document_type: "markdown",
      }],
    });
    const repository = new D1TenantVersionRepository(database, store);
    const snapshot = await repository.readSnapshot(context, "doc-1", 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.documentType).toBe("markdown");
    expect(snapshot?.body).toBe(body);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.read.mock.calls[0]?.[0]).toEqual({ blobHash: "hash-1", size: 1024, contentType: "application/cbor" });
  });

  it("returns null without calling the snapshot store when the version does not exist", async () => {
    const store = snapshotStoreDouble();
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantVersionRepository(database, store);
    const snapshot = await repository.readSnapshot(context, "doc-1", 99);
    expect(snapshot).toBeNull();
    expect(store.read).not.toHaveBeenCalled();
  });

  it("joins on the document's own tenant scope, not just the version's document id", async () => {
    const store = snapshotStoreDouble();
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantVersionRepository(database, store);
    await repository.readSnapshot({ ...context, tenantId: "t-other" }, "doc-1", 0);
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });
});
