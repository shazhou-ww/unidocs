/**
 * The Agent submissions adapter over real D1 and an in-memory snapshot store:
 * the repository's locks and receipts are real SQL, while CAS is replaced by a
 * store whose `read` serves preset bytes and whose `retain` records its calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasClientError } from "@unicas/tenant-blob-client";
import { documentSnapshotContentType, type AgentSubmissionRequest, type CasBlobRef } from "@unidocs/protocol-platform";
import type { SubmissionCommitCommand, TenantContext, TenantSubmissionRepository } from "@unidocs/portal-service";
import { encodeSValue } from "@unidocs/svalue-codec";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { createAgentHttp, isSubmissionPath } from "../../src/tenant/agent-http.js";
import { CasUnavailableError } from "../../src/tenant/cas-unavailable.js";
import { createLocationValidator } from "../../src/tenant/location-validator.js";
import { MAX_SNAPSHOT_BYTES } from "../../src/tenant/snapshot-validator.js";
import { D1TenantSubmissionRepository } from "../../src/tenant/submission-repository.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const BASE = `${ORIGIN}/api/v1/tenants/t-local/documents/doc-1/submissions`;
const DIALECT = "https://schemas.unidocs.dev/svalue/v1";
const SNAPSHOT_CONTENT_TYPE = documentSnapshotContentType("markdown");

const agent: TenantContext = {
  tenantId: "t-local", principalId: "agent:markdown-primary", transport: "bearer",
  scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
};
const session: TenantContext = { tenantId: "t-local", principalId: "user-local", transport: "session", sessionHash: "h" };

const contractRecord = {
  documentType: "markdown",
  documentContractIdx: 0,
  formatVersion: 1,
  snapshot: {
    contentType: SNAPSHOT_CONTENT_TYPE,
    schema: { $schema: DIALECT, type: "object", required: ["content"], additionalProperties: false, properties: { content: { type: "string" } } },
    schemaHash: "sha256:snapshot",
  },
  location: {
    contentType: "application/vnd.unidocs.markdown.location+json;version=1",
    schema: { $schema: DIALECT, type: "object" },
    schemaHash: "sha256:location",
  },
  contractHash: "sha256:contract",
  createdAt: "2026-09-14T00:00:00.000Z",
};

const replyContent = { text: "done", richContent: null, attachments: [] };

/** A CAS stand-in: `read` serves preset bytes (or a preset failure), `retain` records its calls. */
class MemorySnapshotStore implements SnapshotStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly failures = new Map<string, unknown>();
  readonly streams = new Map<string, () => ReadableStream<Uint8Array>>();
  readonly retain = vi.fn(async (_ref: CasBlobRef, _requestId: string) => {});
  readonly read = vi.fn(async (ref: CasBlobRef): Promise<ReadableStream<Uint8Array>> => {
    if (this.failures.has(ref.blobHash)) throw this.failures.get(ref.blobHash);
    const stream = this.streams.get(ref.blobHash);
    if (stream) return stream();
    const bytes = this.blobs.get(ref.blobHash);
    if (!bytes) throw new CasClientError(404, "Not Found", "openBlob");
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  });
  readonly release = vi.fn(async () => {});

  put(blobHash: string, value: unknown): CasBlobRef {
    const bytes = encodeSValue(value as never);
    this.blobs.set(blobHash, bytes);
    return { blobHash, size: bytes.byteLength, contentType: SNAPSHOT_CONTENT_TYPE };
  }
}

let real: RealD1;
let snapshots: MemorySnapshotStore;
let repository: TenantSubmissionRepository;

function handler(overrides: Partial<{ submissions: TenantSubmissionRepository; snapshots: SnapshotStore }> = {}) {
  return createAgentHttp({
    submissions: overrides.submissions ?? repository,
    snapshots: overrides.snapshots ?? snapshots,
    validateLocation: createLocationValidator(),
  });
}

const post = (body: unknown, caller: TenantContext = agent, handle = handler()) =>
  handle(new Request(BASE, {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), caller, "req-1");

const get = (submissionId: string, caller: TenantContext = agent, handle = handler()) =>
  handle(new Request(`${BASE}/${submissionId}`), caller, "req-1");

async function count(table: string): Promise<number> {
  return (await real.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

function versionRequest(submissionId: string, ref: CasBlobRef, observedCurrentVersionIdx: number | null = null): AgentSubmissionRequest {
  return { submissionId, observedCurrentVersionIdx, newDocumentContractIdx: 0, newSnapshotBlob: ref, threadUpdates: [] };
}

function replyRequest(submissionId: string): AgentSubmissionRequest {
  return {
    submissionId,
    threadUpdates: [{ threadId: "th-1", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 1, content: replyContent, resultLocations: [] }],
  };
}

function errorLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

beforeEach(async () => {
  real = await startRealD1();
  snapshots = new MemorySnapshotStore();
  repository = new D1TenantSubmissionRepository(real.db);
  await real.db.prepare(
    "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, ?, '2026-09-14T00:00:00.000Z')",
  ).bind(JSON.stringify({
    documentType: "markdown",
    viewBundle: { viewBundleId: "vb-1", manifest: { supportedDocumentContractIdxs: [0] } },
    builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { markdown: [0] } } },
  })).run();
  await real.db.prepare(
    "INSERT INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES ('markdown', 0, 'sha256:contract', ?, 0)",
  ).bind(JSON.stringify(contractRecord)).run();
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', 'doc-1', 'Doc', 'markdown', NULL, 0)",
  ).run();
  await real.db.prepare("INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES ('t-local', 'doc-1', 'th-1', 0)").run();
  for (const idx of [0, 1, 2]) {
    await real.db.prepare(
      `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
       VALUES ('t-local', 'doc-1', 'th-1', ?, 0, '{"text":"c","richContent":null,"attachments":[]}', NULL, 'user-1', 0)`,
    ).bind(idx).run();
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await real.dispose();
});

describe("isSubmissionPath", () => {
  it.each([
    ["/api/v1/tenants/t-local/documents/doc-1/submissions", true],
    ["/api/v1/tenants/t-local/documents/doc-1/submissions/sub-1", true],
    ["/api/v1/tenants/t-local/documents/doc-1/submissions/", true],
    ["/api/v1/tenants/t-local/documents/doc-1", false],
    ["/api/v1/tenants/t-local/documents/doc-1/threads", false],
    ["/api/v1/tenants/t-local/documents/doc-1/submissionsx", false],
    ["/api/v1/tenants/t-local/documents/submissions", false],
    ["/api/v1/tenants/t-local/documents/doc-1/versions/0/submissions", false],
  ])("%s -> %s", (path, expected) => {
    expect(isSubmissionPath(path)).toBe(expected);
  });
});

describe("POST submissions", () => {
  it("commits a first version with 201 and retains its blob exactly once, after the commit", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    let versionsAtRetain = -1;
    snapshots.retain.mockImplementation(async () => { versionsAtRetain = await count("portal_versions"); });

    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ state: "committed", submissionId: "sub-1", version: { versionIdx: 0, parentVersionIdx: null, documentContractIdx: 0 }, replies: [] });
    expect(snapshots.retain).toHaveBeenCalledTimes(1);
    expect(snapshots.retain).toHaveBeenCalledWith(ref, "req-1");
    expect(versionsAtRetain).toBe(1);
  });

  it("replays the same submission with 201 and the stored receipt, without retaining again", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const first = await (await post(versionRequest("sub-1", ref))).json();
    snapshots.retain.mockClear();

    const replay = await post(versionRequest("sub-1", ref));
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toEqual(first);
    expect(snapshots.retain).not.toHaveBeenCalled();
    expect(await count("portal_versions")).toBe(1);
  });

  it("does not retain when a twin with the same body committed the submission first", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    // From this request's point of view its commit conflicted: the twin's commit landed first.
    const twinFirst: TenantSubmissionRepository = {
      findReceipt: (...args) => repository.findReceipt(...args),
      loadState: (...args) => repository.loadState(...args),
      loadContract: (...args) => repository.loadContract(...args),
      commit: async (command: SubmissionCommitCommand) => {
        await repository.commit(command);
        return { kind: "conflict" };
      },
    };
    const response = await post(versionRequest("sub-1", ref), agent, handler({ submissions: twinFirst }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ state: "committed", submissionId: "sub-1" });
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("answers a different body under a used submission id with 400", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    await post(versionRequest("sub-1", ref));
    const response = await post({ ...versionRequest("sub-1", ref), observedCurrentVersionIdx: 0 });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_request", message: expect.any(String), requestId: "req-1" } });
  });

  it("answers a version lock failure with a 201 rejected receipt carrying the conflict, and retains nothing", async () => {
    const first = snapshots.put("blob-1", { content: "# one" });
    await post(versionRequest("sub-1", first));
    snapshots.retain.mockClear();

    const stale = snapshots.put("blob-2", { content: "# two" });
    const response = await post({ ...versionRequest("sub-2", stale), threadUpdates: replyRequest("x").threadUpdates });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      state: "rejected", submissionId: "sub-2", reason: "version_conflict", rejectedAt: expect.any(String),
      conflict: { currentVersionIdx: 0, availableDocumentContractIdxs: [0], threads: [{ threadId: "th-1", acknowledgedCommentIdx: null, latestCommentIdx: 2 }] },
    });
    expect(snapshots.retain).not.toHaveBeenCalled();
    expect(await count("portal_versions")).toBe(1);
    expect(await count("portal_replies")).toBe(0);
  });

  it("retains nothing when the lock moves between the decision and the commit", async () => {
    const competing = snapshots.put("blob-0", { content: "# competing" });
    const ref = snapshots.put("blob-1", { content: "# mine" });
    const racing: TenantSubmissionRepository = {
      findReceipt: (...args) => repository.findReceipt(...args),
      loadState: (...args) => repository.loadState(...args),
      loadContract: (...args) => repository.loadContract(...args),
      commit: async (command: SubmissionCommitCommand) => {
        if (command.request.submissionId === "sub-1") {
          const state = await repository.loadState(agent, "doc-1", []);
          await repository.commit({ ...command, request: versionRequest("sub-other", competing), fingerprint: "fp-other", observed: state! });
        }
        return repository.commit(command);
      },
    };
    const response = await post(versionRequest("sub-1", ref), agent, handler({ submissions: racing }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ state: "rejected", reason: "version_conflict" });
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("commits a pure reply with 201 without reading or retaining any blob", async () => {
    const response = await post(replyRequest("reply-1"));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ state: "committed", version: null, replies: [{ replyIdx: 0, respondThroughCommentIdx: 1 }] });
    expect(snapshots.read).not.toHaveBeenCalled();
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("answers snapshot bytes that do not satisfy the snapshot schema with 400", async () => {
    const ref = snapshots.put("blob-1", { content: 1 });
    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", requestId: "req-1" } });
    expect(await count("portal_versions")).toBe(0);
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("answers a blob CAS does not have with 409 content_unavailable", async () => {
    const response = await post(versionRequest("sub-1", { blobHash: "blob-missing", size: 10, contentType: SNAPSHOT_CONTENT_TYPE }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "content_unavailable", message: expect.any(String), requestId: "req-1" } });
    expect(await count("portal_submissions")).toBe(0);
  });

  it("answers the snapshot store's size mismatch with 409", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    snapshots.failures.set("blob-1", new Error(`Snapshot blob blob-1 is ${ref.size + 1} bytes, but the version record declares ${ref.size}`));
    expect((await post(versionRequest("sub-1", ref))).status).toBe(409);
  });

  it("answers bytes whose length differs from the declared size with 409", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    expect((await post(versionRequest("sub-1", { ...ref, size: ref.size + 1 }))).status).toBe(409);
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("answers any other snapshot read failure with 503 and logs it as a read failure, not as missing CAS", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = snapshots.put("blob-1", { content: "# hello" });
    snapshots.failures.set("blob-1", new CasClientError(500, "Internal Server Error", "openBlob"));
    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unavailable", requestId: "req-1" } });
    expect(errorLines(logged)).toEqual([{
      event: "portal_snapshot_read_failed", requestId: "req-1", name: "CasClientError", message: "CAS openBlob failed: 500 Internal Server Error",
    }]);
  });

  it("logs portal_cas_unavailable and answers 503 when the snapshot store cannot be built", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = snapshots.put("blob-1", { content: "# hello" });
    snapshots.failures.set("blob-1", new CasUnavailableError(new TypeError("Portal CAS binding CAS_ORIGIN is missing")));
    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("CAS_ORIGIN");
    expect(errorLines(logged)).toContainEqual({
      event: "portal_cas_unavailable", requestId: "req-1", name: "TypeError", message: "Portal CAS binding CAS_ORIGIN is missing",
    });
  });

  it("answers a snapshot content type that is not the document type's with 400 before reading CAS", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const response = await post(versionRequest("sub-1", { ...ref, contentType: "application/octet-stream" }));
    expect(response.status).toBe(400);
    expect(snapshots.read).not.toHaveBeenCalled();
  });

  it("answers a declared size over the snapshot limit with 400 without reading CAS", async () => {
    const response = await post(versionRequest("sub-1", { blobHash: "blob-huge", size: MAX_SNAPSHOT_BYTES + 1, contentType: SNAPSHOT_CONTENT_TYPE }));
    expect(response.status).toBe(400);
    expect(snapshots.read).not.toHaveBeenCalled();
  });

  it("stops reading a stream that runs past the snapshot limit and answers 400", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    snapshots.streams.set("blob-1", () => new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES / chunk.byteLength + 2);
    expect(cancelled).toBe(true);
  });

  it("answers a result location outside the new contract revision with 422", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const response = await post({
      ...versionRequest("sub-1", ref),
      threadUpdates: [{ ...replyRequest("x").threadUpdates[0]!, resultLocations: [{ documentContractIdx: 1, locationType: "text-range", payload: { start: 0, end: 1 } }] }],
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "location_contract_violation", requestId: "req-1" } });
    expect(snapshots.retain).not.toHaveBeenCalled();
  });

  it("answers a missing document with 404", async () => {
    const response = await handler()(new Request(`${ORIGIN}/api/v1/tenants/t-local/documents/doc-missing/submissions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(replyRequest("reply-1")),
    }), agent, "req-1");
    expect(response.status).toBe(404);
  });

  it("forbids a browser session with 403", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const response = await post(versionRequest("sub-1", ref), session);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "forbidden", message: expect.any(String), requestId: "req-1" } });
    expect(snapshots.read).not.toHaveBeenCalled();
    expect(await count("portal_submissions")).toBe(0);
  });

  it("forbids a path tenant other than the credential's with 403", async () => {
    const response = await handler()(new Request(`${ORIGIN}/api/v1/tenants/t-other/documents/doc-1/submissions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(replyRequest("reply-1")),
    }), agent, "req-1");
    expect(response.status).toBe(403);
  });

  it("still answers 201 when retain fails, and logs portal_snapshot_retain_failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = snapshots.put("blob-1", { content: "# hello" });
    snapshots.retain.mockRejectedValue(new CasClientError(503, "Service Unavailable", "retain"));
    const response = await post(versionRequest("sub-1", ref));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ state: "committed" });
    expect(errorLines(logged)).toContainEqual({
      event: "portal_snapshot_retain_failed", requestId: "req-1", blobHash: "blob-1",
      name: "CasClientError", message: "CAS retain failed: 503 Service Unavailable",
    });
    expect(await count("portal_submissions")).toBe(1);
  });

  it.each([
    ["a non-JSON content type", { "content-type": "text/plain" }, "{}"],
    ["malformed JSON", { "content-type": "application/json" }, "{"],
    ["a body the contract rejects", { "content-type": "application/json" }, JSON.stringify({ submissionId: "sub-1" })],
    ["a body over 1 MiB", { "content-type": "application/json" }, JSON.stringify({ ...replyRequest("reply-1"), padding: "x".repeat(1_048_576) })],
  ])("answers %s with 400", async (_label, headers, body) => {
    const response = await handler()(new Request(BASE, { method: "POST", headers, body }), agent, "req-1");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", requestId: "req-1" } });
  });

  it("answers an unexpected failure with 500 and logs it without leaking its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: TenantSubmissionRepository = {
      findReceipt: async () => { throw new Error("no such table: portal_submissions"); },
      loadState: (...args) => repository.loadState(...args),
      loadContract: (...args) => repository.loadContract(...args),
      commit: (...args) => repository.commit(...args),
    };
    const response = await post(replyRequest("reply-1"), agent, handler({ submissions: broken }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("portal_submissions");
    expect(errorLines(logged)).toContainEqual(expect.objectContaining({ event: "portal_operation_failed", requestId: "req-1", message: "no such table: portal_submissions" }));
  });
});

describe("GET submissions/{id}", () => {
  it("returns the committed receipt with 200", async () => {
    const ref = snapshots.put("blob-1", { content: "# hello" });
    const created = await (await post(versionRequest("sub-1", ref))).json();
    const response = await get("sub-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(created);
  });

  it("answers an unknown id and a rejected id with 404", async () => {
    const first = snapshots.put("blob-1", { content: "# one" });
    await post(versionRequest("sub-1", first));
    const rejected = await post(versionRequest("sub-2", snapshots.put("blob-2", { content: "# two" })));
    await expect(rejected.json()).resolves.toMatchObject({ state: "rejected" });

    for (const id of ["sub-never", "sub-2"]) {
      const response = await get(id);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: expect.any(String), requestId: "req-1" } });
    }
  });

  it("forbids a browser session with 403", async () => {
    await post(replyRequest("reply-1"));
    expect((await get("reply-1", session)).status).toBe(403);
  });

  it("answers a path outside the contract with 404", async () => {
    const response = await handler()(new Request(`${BASE}/sub-1/extra`), agent, "req-1");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found", requestId: "req-1" } });
  });
});
