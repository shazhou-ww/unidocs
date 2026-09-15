import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CasClientError } from "@unicas/tenant-blob-client";
import type { CasBlobRef } from "@unidocs/protocol-platform";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { createSnapshotRetention, snapshotRetainRequestId } from "../../src/tenant/snapshot-retention.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const NOW = new Date("2026-09-15T00:10:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const CONTENT_TYPE = "application/vnd.unidocs.markdown.snapshot+cbor;version=1";

let real: RealD1;

function fakeStore() {
  return { read: vi.fn(), retain: vi.fn(async (_ref: CasBlobRef, _requestId: string) => {}), release: vi.fn() } satisfies Record<keyof SnapshotStore, unknown>;
}

// One database for the file, emptied before each test: every Miniflare start
// costs dozens of loopback connections, and the package's real-D1 suites
// together already come close to exhausting the ephemeral port range.
beforeAll(async () => {
  real = await startRealD1();
});

afterAll(async () => {
  await real.dispose();
});

beforeEach(async () => {
  await real.db.batch([real.db.prepare("DELETE FROM portal_versions"), real.db.prepare("DELETE FROM portal_documents")]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedVersion(tenantId: string, documentId: string, versionIdx: number, options: { createdAt: number; retainedAt: number | null }) {
  await real.db.prepare(
    "INSERT OR IGNORE INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, 'n', 'markdown', NULL, ?)",
  ).bind(tenantId, documentId, options.createdAt).run();
  await real.db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id,
       addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at, snapshot_retained_at)
     VALUES (?, ?, ?, NULL, 0, 'agent:x', ?, '[]', ?, 7, ?, ?, ?)`,
  ).bind(tenantId, documentId, versionIdx, `sub-${versionIdx}`, `blob-${documentId}-${versionIdx}`, CONTENT_TYPE, options.createdAt, options.retainedAt).run();
}

async function outcome(tenantId: string, documentId: string, versionIdx: number) {
  return real.db.prepare("SELECT snapshot_retained_at AS retained, snapshot_retain_attempted_at AS attempted, snapshot_lost_at AS lost FROM portal_versions WHERE tenant_id = ? AND document_id = ? AND version_idx = ?")
    .bind(tenantId, documentId, versionIdx).first<{ retained: number | null; attempted: number | null; lost: number | null }>();
}

async function retainedAt(tenantId: string, documentId: string, versionIdx: number) {
  return (await outcome(tenantId, documentId, versionIdx))?.retained;
}

describe("snapshotRetainRequestId", () => {
  it("is the same for the same version, so UniCAS counts a repeated retain once", () => {
    expect(snapshotRetainRequestId("doc-1", 3)).toBe("portal-version-snapshot:doc-1:3");
    expect(snapshotRetainRequestId("doc-1", 3)).toBe(snapshotRetainRequestId("doc-1", 3));
  });
});

describe("retainVersion", () => {
  it("retains an unretained version under its deterministic requestId and records when", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS, retainedAt: null });
    const store = fakeStore();
    const retention = createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW });

    await retention.retainVersion("t", "doc-1", 0);

    expect(store.retain).toHaveBeenCalledTimes(1);
    expect(store.retain).toHaveBeenCalledWith({ blobHash: "blob-doc-1-0", size: 7, contentType: CONTENT_TYPE }, "portal-version-snapshot:doc-1:0");
    expect(await retainedAt("t", "doc-1", 0)).toBe(NOW_SECONDS);
  });

  it("does not call CAS for a version already retained", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: 1, retainedAt: 2 });
    const store = fakeStore();
    await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).retainVersion("t", "doc-1", 0);
    expect(store.retain).not.toHaveBeenCalled();
    expect(await retainedAt("t", "doc-1", 0)).toBe(2);
  });

  it("leaves the version unretained and logs, without throwing, when the retain fails", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS, retainedAt: null });
    const store = fakeStore();
    store.retain.mockRejectedValue(new CasClientError(503, "Service Unavailable", "retain"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).retainVersion("t", "doc-1", 0)).resolves.toBeUndefined();

    expect(await outcome("t", "doc-1", 0)).toEqual({ retained: null, attempted: NOW_SECONDS, lost: null });
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      event: "portal_snapshot_retain_failed", tenantId: "t", documentId: "doc-1", versionIdx: 0, blobHash: "blob-doc-1-0",
      name: "CasClientError", message: "CAS retain failed: 503 Service Unavailable",
    }]);
  });

  it("logs a blob UniCAS no longer has as lost, not as a retryable failure", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS, retainedAt: null });
    const store = fakeStore();
    store.retain.mockRejectedValue(new CasClientError(404, "Not Found", "retain"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).retainVersion("t", "doc-1", 0);

    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({ event: "portal_snapshot_lost", documentId: "doc-1", versionIdx: 0 });
    expect(await outcome("t", "doc-1", 0)).toEqual({ retained: null, attempted: null, lost: NOW_SECONDS });
  });

  it("does not ask UniCAS again for a blob it reported lost", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS - 600, retainedAt: null });
    await real.db.prepare("UPDATE portal_versions SET snapshot_lost_at = ?").bind(NOW_SECONDS - 300).run();
    const store = fakeStore();
    const retention = createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW });

    await retention.retainVersion("t", "doc-1", 0);
    expect(await retention.sweep()).toEqual({ retained: 0, failed: 0 });

    expect(store.retain).not.toHaveBeenCalled();
  });

  it("logs a failure to record a retain UniCAS accepted apart from a retain failure", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS, retainedAt: null });
    const store = fakeStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = {
      prepare: (sql: string) => sql.trimStart().startsWith("UPDATE") ? { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) } : real.db.prepare(sql),
    } as unknown as D1Database;

    await createSnapshotRetention({ database, snapshots: () => store, now: () => NOW }).retainVersion("t", "doc-1", 0);

    expect(store.retain).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      event: "portal_snapshot_retention_record_failed", tenantId: "t", documentId: "doc-1", versionIdx: 0, column: "snapshot_retained_at", name: "Error", message: "D1 write failed",
    }]);
  });

  it("does nothing for a version that does not exist", async () => {
    const store = fakeStore();
    await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).retainVersion("t", "missing", 0);
    expect(store.retain).not.toHaveBeenCalled();
  });
});

describe("sweep", () => {
  it("retains every unretained version older than the grace period, each through its own tenant's store", async () => {
    await seedVersion("t-a", "doc-1", 0, { createdAt: NOW_SECONDS - 600, retainedAt: null });
    await seedVersion("t-b", "doc-2", 0, { createdAt: NOW_SECONDS - 120, retainedAt: null });
    await seedVersion("t-a", "doc-3", 0, { createdAt: NOW_SECONDS - 600, retainedAt: NOW_SECONDS - 599 });
    // Still inside the grace period: its own submission request is retaining it right now.
    await seedVersion("t-a", "doc-4", 0, { createdAt: NOW_SECONDS - 5, retainedAt: null });
    const stores = new Map([["t-a", fakeStore()], ["t-b", fakeStore()]]);
    const snapshots = vi.fn((tenantId: string) => stores.get(tenantId)!);

    const result = await createSnapshotRetention({ database: real.db, snapshots, now: () => NOW }).sweep();

    expect(result).toEqual({ retained: 2, failed: 0 });
    expect(stores.get("t-a")!.retain).toHaveBeenCalledTimes(1);
    expect(stores.get("t-a")!.retain).toHaveBeenCalledWith(expect.objectContaining({ blobHash: "blob-doc-1-0" }), "portal-version-snapshot:doc-1:0");
    expect(stores.get("t-b")!.retain).toHaveBeenCalledWith(expect.objectContaining({ blobHash: "blob-doc-2-0" }), "portal-version-snapshot:doc-2:0");
    expect(await retainedAt("t-a", "doc-1", 0)).toBe(NOW_SECONDS);
    expect(await retainedAt("t-b", "doc-2", 0)).toBe(NOW_SECONDS);
    expect(await retainedAt("t-a", "doc-4", 0)).toBeNull();
  });

  it("stops at the batch limit, oldest first", async () => {
    for (let idx = 0; idx < 3; idx += 1) await seedVersion("t", "doc-1", idx, { createdAt: NOW_SECONDS - 1000 + idx, retainedAt: null });
    const store = fakeStore();

    const result = await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).sweep({ limit: 2 });

    expect(result).toEqual({ retained: 2, failed: 0 });
    expect(store.retain.mock.calls.map(([, requestId]) => requestId)).toEqual(["portal-version-snapshot:doc-1:0", "portal-version-snapshot:doc-1:1"]);
  });

  it("counts a failed retain and keeps going", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS - 600, retainedAt: null });
    await seedVersion("t", "doc-2", 0, { createdAt: NOW_SECONDS - 500, retainedAt: null });
    const store = fakeStore();
    store.retain.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).sweep();

    expect(result).toEqual({ retained: 1, failed: 1 });
    expect(await retainedAt("t", "doc-1", 0)).toBeNull();
    expect(await retainedAt("t", "doc-2", 0)).toBe(NOW_SECONDS);
  });

  it("is not held up by a full batch of versions whose retain keeps failing", async () => {
    for (let idx = 0; idx < 2; idx += 1) await seedVersion("t", "stuck", idx, { createdAt: NOW_SECONDS - 3600, retainedAt: null });
    await seedVersion("t", "fine", 0, { createdAt: NOW_SECONDS - 600, retainedAt: null });
    const store = fakeStore();
    store.retain.mockImplementation(async ref => { if (ref.blobHash.startsWith("blob-stuck")) throw new Error("boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The first sweep fills its batch of two with the oldest, failing rows.
    expect(await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).sweep({ limit: 2 })).toEqual({ retained: 0, failed: 2 });
    // Once the grace period has passed again, the failed rows wait behind the one never tried.
    const later = new Date(NOW.getTime() + 61_000);
    expect(await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => later }).sweep({ limit: 2 })).toEqual({ retained: 1, failed: 1 });
    expect(await retainedAt("t", "fine", 0)).toEqual(later.getTime() / 1000 | 0);
  });

  it("leaves a version whose retain just failed until the grace period has passed again", async () => {
    await seedVersion("t", "doc-1", 0, { createdAt: NOW_SECONDS - 3600, retainedAt: null });
    await real.db.prepare("UPDATE portal_versions SET snapshot_retain_attempted_at = ?").bind(NOW_SECONDS - 30).run();
    const store = fakeStore();

    expect(await createSnapshotRetention({ database: real.db, snapshots: () => store, now: () => NOW }).sweep()).toEqual({ retained: 0, failed: 0 });
    expect(store.retain).not.toHaveBeenCalled();
  });

  it("logs and reports nothing retained when the database cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database;

    await expect(createSnapshotRetention({ database, snapshots: () => fakeStore(), now: () => NOW }).sweep()).resolves.toEqual({ retained: 0, failed: 0 });

    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toEqual({ event: "portal_snapshot_retention_sweep_failed", name: "Error", message: "D1 is down" });
  });
});
