import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommittedTenantWrite } from "../../src/tenant/operator-dispatch.js";
import { createInitializationRedelivery, INITIALIZATION_REDELIVERY_SECONDS } from "../../src/tenant/initialization-redelivery.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const NOW = new Date("2026-09-15T00:10:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;

let real: RealD1;
let dispatch: ReturnType<typeof vi.fn<(write: CommittedTenantWrite) => Promise<void>>>;

// One database for the file, emptied before each test (see snapshot-retention.test.ts).
beforeAll(async () => {
  real = await startRealD1();
});

afterAll(async () => {
  await real.dispose();
});

beforeEach(async () => {
  await real.db.batch([real.db.prepare("DELETE FROM portal_documents"), real.db.prepare("DELETE FROM portal_document_types")]);
  await seedDocumentType("markdown", { builtinOperator: { operatorId: "op-1", baseUrl: "https://markdown.example" } });
  dispatch = vi.fn(async () => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedDocumentType(documentType: string, registration: object) {
  await real.db.prepare(
    "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, ?, '2026-09-14T00:00:00.000Z')",
  ).bind(documentType, documentType, JSON.stringify({ documentType, ...registration })).run();
}

async function seedDocument(documentId: string, options: { createdAt: number; currentVersionIdx?: number | null; redeliveredAt?: number | null }) {
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at, initialization_redelivered_at) VALUES ('t', ?, 'n', 'markdown', ?, ?, ?)",
  ).bind(documentId, options.currentVersionIdx ?? null, options.createdAt, options.redeliveredAt ?? null).run();
}

const redeliver = (now = NOW) => createInitializationRedelivery({ database: real.db, dispatch, now: () => now });

describe("initialization redelivery", () => {
  it("waits 20 seconds between asks", () => {
    expect(INITIALIZATION_REDELIVERY_SECONDS).toBe(20);
  });

  it("asks the Operator again for a document still without a version once the creation dispatch is 20 seconds old", async () => {
    await seedDocument("doc-1", { createdAt: NOW_SECONDS - INITIALIZATION_REDELIVERY_SECONDS });

    await redeliver()("t", "doc-1");

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: "document.created", tenantId: "t", documentId: "doc-1" });
    const row = await real.db.prepare("SELECT initialization_redelivered_at FROM portal_documents WHERE document_id = 'doc-1'").first();
    expect(row).toEqual({ initialization_redelivered_at: NOW_SECONDS });
    expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: "portal_document_initialization_redelivered", tenantId: "t", documentId: "doc-1" },
    ]);
  });

  it("leaves a document created less than 20 seconds ago to its creation dispatch", async () => {
    await seedDocument("doc-1", { createdAt: NOW_SECONDS - INITIALIZATION_REDELIVERY_SECONDS + 1 });
    await redeliver()("t", "doc-1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("counts the 20 seconds from the last redelivery, not from creation", async () => {
    await seedDocument("doc-1", { createdAt: NOW_SECONDS - 3600, redeliveredAt: NOW_SECONDS - 10 });
    await redeliver()("t", "doc-1");
    expect(dispatch).not.toHaveBeenCalled();

    await redeliver(new Date(NOW.getTime() + 10_000))("t", "doc-1");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never asks for a document that already has a version", async () => {
    await seedDocument("doc-1", { createdAt: NOW_SECONDS - 3600, currentVersionIdx: 0 });
    await redeliver()("t", "doc-1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks once when several readers arrive in the same window", async () => {
    await seedDocument("doc-1", { createdAt: NOW_SECONDS - 3600 });
    const ask = redeliver();
    await Promise.all([ask("t", "doc-1"), ask("t", "doc-1"), ask("t", "doc-1")]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never asks for a document whose type has no builtin Operator to initialize it", async () => {
    await seedDocumentType("plain", {});
    await real.db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'doc-plain', 'n', 'plain', NULL, ?)",
    ).bind(NOW_SECONDS - 3600).run();
    await redeliver()("t", "doc-plain");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does nothing for a document that does not exist", async () => {
    await redeliver()("t", "missing");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("logs a database failure and does not throw", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database;

    await expect(createInitializationRedelivery({ database, dispatch, now: () => NOW })("t", "doc-1")).resolves.toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toEqual({
      event: "portal_document_initialization_redelivery_failed", tenantId: "t", documentId: "doc-1", name: "Error", message: "D1 is down",
    });
  });
});
