import { describe, expect, it } from "vitest";
import {
  GatewayDirectoryConflictError,
  MemoryGatewayDocumentDirectory,
} from "../src/document-directory.js";

function reservation(overrides: Partial<Parameters<MemoryGatewayDocumentDirectory["reserve"]>[0]> = {}) {
  return {
    docId: "doc-1",
    tenantId: "tenant-1",
    docType: "markdown",
    serviceId: "markdown",
    sessionId: "session-1",
    idempotencyKey: "create-1",
    requestedDocId: null,
    now: 100,
    ...overrides,
  };
}

describe("MemoryGatewayDocumentDirectory", () => {
  it("advances only ready higher versions without changing time for stale observations", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve(reservation());
    await directory.advanceVersion("tenant-1", "doc-1", 2, 200);
    expect(await directory.get("tenant-1", "doc-1")).toMatchObject({ state: "creating", version: null, updatedAt: 100 });
    await directory.markReady("tenant-1", "doc-1", 1, 120);
    await Promise.all([directory.advanceVersion("tenant-1", "doc-1", 5, 200), directory.advanceVersion("tenant-1", "doc-1", 3, 300)]);
    await directory.advanceVersion("tenant-1", "doc-1", 5, 400);
    expect(await directory.get("tenant-1", "doc-1")).toMatchObject({ version: 5, updatedAt: 200 });
    await directory.advanceVersion("tenant-1", "doc-1", 6, 150);
    expect(await directory.get("tenant-1", "doc-1")).toMatchObject({ version: 6, updatedAt: 200 });
    await directory.advanceVersion("other-tenant", "doc-1", 99, 900);
    expect(await directory.get("tenant-1", "doc-1")).toMatchObject({ version: 6, updatedAt: 200 });
    await expect(directory.advanceVersion("tenant-1", "doc-1", 0, 300)).rejects.toThrow();
  });

  it("returns the original document and session for a repeated idempotency key", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    const first = await directory.reserve(reservation());
    const retry = await directory.reserve(reservation({
      docId: "discarded-doc",
      sessionId: "discarded-session",
      now: 200,
    }));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.record.docId).toBe("doc-1");
    expect(retry.record.sessionId).toBe("session-1");
  });

  it("rejects reusing an idempotency key for a different route", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve(reservation());

    await expect(directory.reserve(reservation({ docType: "docx" })))
      .rejects.toBeInstanceOf(GatewayDirectoryConflictError);
  });

  it("rejects one idempotency key for different explicitly requested doc IDs", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve(reservation({ docId: "doc-a", requestedDocId: "doc-a" }));

    await expect(directory.reserve(reservation({
      docId: "doc-b",
      sessionId: "session-b",
      requestedDocId: "doc-b",
    }))).rejects.toBeInstanceOf(GatewayDirectoryConflictError);
  });

  it("lists only ready documents by recency", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve(reservation());
    await directory.reserve(reservation({
      docId: "doc-2",
      sessionId: "session-2",
      idempotencyKey: "create-2",
      now: 110,
    }));
    await directory.markReady("tenant-1", "doc-1", 1, 120);
    await directory.markReady("tenant-1", "doc-2", 2, 130);

    await expect(directory.list("tenant-1", "markdown")).resolves.toEqual([
      expect.objectContaining({ docId: "doc-2", version: 2 }),
      expect.objectContaining({ docId: "doc-1", version: 1 }),
    ]);
  });

  it("isolates equal document and idempotency IDs across tenants", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve(reservation());
    await directory.reserve(reservation({
      tenantId: "tenant-2",
      sessionId: "session-2",
    }));

    await expect(directory.get("tenant-1", "doc-1")).resolves.toMatchObject({
      tenantId: "tenant-1",
      sessionId: "session-1",
    });
    await expect(directory.get("tenant-2", "doc-1")).resolves.toMatchObject({
      tenantId: "tenant-2",
      sessionId: "session-2",
    });
  });
});