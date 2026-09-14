import { documentSnapshotContentType, type AgentSubmissionRequest, type AgentThreadUpdate, type SValueSchema } from "@unidocs/protocol-platform";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTenantSubmissionService, schemaHash, TENANT_LIMITS, TenantAccessError,
  type CommittedSubmissionReceipt, type SnapshotVerifier, type SubmissionCommitCommand, type SubmissionCommitOutcome,
  type SubmissionContract, type SubmissionState, type SubmissionThreadState, type TenantContext, type TenantSubmissionRepository,
} from "../src/index.js";

const NOW = new Date("2026-09-14T08:00:00.000Z");
const ALL_SCOPES = ["documents:read", "comments:read", "comments:reply", "versions:submit"];
const agent: TenantContext = { tenantId: "tenant-a", principalId: "agent:markdown-primary", transport: "bearer", scopes: ALL_SCOPES };
const snapshotSchema: SValueSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1", title: "snapshot" } as SValueSchema;
const locationSchema: SValueSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1", title: "location" } as SValueSchema;
const snapshotBlob = { blobHash: "b3:snapshot", size: 42, contentType: documentSnapshotContentType("markdown") };
const replyContent = { text: "Shortened as requested", richContent: null, attachments: [] };
const resultLocation = { documentContractIdx: 1, locationType: "unidocs.markdown.text-range/v1", payload: { start: 1, end: 9 } };

function thread(threadId: string, acknowledgedCommentIdx: number | null, comments: readonly { commentIdx: number; baseVersionIdx: number }[]): SubmissionThreadState {
  return { threadId, acknowledgedCommentIdx, latestCommentIdx: Math.max(-1, ...comments.map(c => c.commentIdx)), comments };
}

/** Comments 0..3 on th-1, acknowledged through 0; th-2 has two comments and no reply yet. */
function initialThreads(): Map<string, SubmissionThreadState> {
  return new Map([
    ["th-1", thread("th-1", 0, [{ commentIdx: 0, baseVersionIdx: 1 }, { commentIdx: 1, baseVersionIdx: 2 }, { commentIdx: 2, baseVersionIdx: 3 }, { commentIdx: 3, baseVersionIdx: 3 }])],
    ["th-2", thread("th-2", null, [{ commentIdx: 1, baseVersionIdx: 3 }, { commentIdx: 0, baseVersionIdx: 2 }])],
  ]);
}

function update(overrides: Partial<AgentThreadUpdate> = {}): AgentThreadUpdate {
  return { threadId: "th-1", observedAcknowledgedCommentIdx: 0, respondThroughCommentIdx: 2, content: replyContent, resultLocations: [], ...overrides };
}

function versionRequest(overrides: Partial<AgentSubmissionRequest> = {}): AgentSubmissionRequest {
  return {
    submissionId: "sub-1", observedCurrentVersionIdx: 3, newDocumentContractIdx: 1, newSnapshotBlob: snapshotBlob,
    threadUpdates: [update({ resultLocations: [resultLocation] })], ...overrides,
  };
}

function replyRequest(overrides: Partial<AgentSubmissionRequest> = {}): AgentSubmissionRequest {
  return { submissionId: "sub-1", threadUpdates: [update()], ...overrides };
}

/** Behaves like the interface: a durable receipt store, a live document state, and an atomic lock re-check at commit. */
class InMemorySubmissionRepository implements TenantSubmissionRepository {
  documentExists = true;
  documentType = "markdown";
  currentVersionIdx: number | null = 3;
  availableDocumentContractIdxs: number[] = [0, 1];
  threads = initialThreads();
  contracts = new Map<string, SubmissionContract>([["markdown#1", { snapshotSchema, locationSchema }], ["markdown#0", { snapshotSchema, locationSchema }]]);
  receipts = new Map<string, { fingerprint: string; receipt: CommittedSubmissionReceipt }>();
  /** Runs inside commit before the lock re-check: a concurrent writer landing between read and commit. */
  beforeCommit: (() => void)[] = [];
  /** Forces a conflict outcome regardless of state, for the rare race where the reread shows every lock holding. */
  forcedConflicts = 0;
  readonly commands: SubmissionCommitCommand[] = [];

  findReceipt = vi.fn(async (_context: TenantContext, documentId: string, submissionId: string) => this.receipts.get(`${documentId}/${submissionId}`) ?? null);

  loadState = vi.fn(async (_context: TenantContext, _documentId: string, threadIds: readonly string[]): Promise<SubmissionState | null> => {
    if (!this.documentExists) return null;
    const threads = new Map<string, SubmissionThreadState>();
    for (const id of threadIds) {
      const found = this.threads.get(id);
      if (found) threads.set(id, found);
    }
    return { documentType: this.documentType, currentVersionIdx: this.currentVersionIdx, availableDocumentContractIdxs: [...this.availableDocumentContractIdxs], threads };
  });

  loadContract = vi.fn(async (documentType: string, documentContractIdx: number) => this.contracts.get(`${documentType}#${documentContractIdx}`) ?? null);

  commit = vi.fn(async (command: SubmissionCommitCommand): Promise<SubmissionCommitOutcome> => {
    this.commands.push(command);
    this.beforeCommit.shift()?.();
    const { request } = command;
    if (this.forcedConflicts > 0) {
      this.forcedConflicts -= 1;
      return { kind: "conflict" };
    }
    const snapshot = request.newSnapshotBlob !== undefined;
    if (snapshot && (request.observedCurrentVersionIdx !== this.currentVersionIdx || !this.availableDocumentContractIdxs.includes(request.newDocumentContractIdx!))) return { kind: "conflict" };
    if (request.threadUpdates.some(u => this.threads.get(u.threadId)?.acknowledgedCommentIdx !== u.observedAcknowledgedCommentIdx)) return { kind: "conflict" };
    const at = command.now.toISOString();
    const version = snapshot ? {
      versionIdx: (this.currentVersionIdx ?? -1) + 1, parentVersionIdx: request.observedCurrentVersionIdx ?? null,
      documentContractIdx: request.newDocumentContractIdx!, authorAgentId: command.context.principalId, submissionId: request.submissionId,
      addressedComments: command.addressedComments, createdAt: at,
    } : null;
    const replies = request.threadUpdates.map((u, replyIdx) => ({
      replyIdx, respondThroughCommentIdx: u.respondThroughCommentIdx, content: u.content, resultLocations: u.resultLocations,
      authorAgentId: command.context.principalId, submissionId: request.submissionId, createdAt: at,
    }));
    const receipt: CommittedSubmissionReceipt = { submissionId: request.submissionId, state: "committed", version, replies, committedAt: at };
    if (version) this.currentVersionIdx = version.versionIdx;
    for (const u of request.threadUpdates) {
      const t = this.threads.get(u.threadId)!;
      this.threads.set(u.threadId, { ...t, acknowledgedCommentIdx: u.respondThroughCommentIdx });
    }
    this.receipts.set(`${command.documentId}/${request.submissionId}`, { fingerprint: command.fingerprint, receipt });
    return { kind: "committed", receipt };
  });
}

let repository: InMemorySubmissionRepository;
let verifySnapshot: ReturnType<typeof vi.fn<SnapshotVerifier>>;
let validateLocation: ReturnType<typeof vi.fn<(location: unknown, schema: SValueSchema) => boolean>>;

function service() {
  return createTenantSubmissionService(repository, { validateLocation, verifySnapshot, now: () => NOW });
}

beforeEach(() => {
  repository = new InMemorySubmissionRepository();
  verifySnapshot = vi.fn<SnapshotVerifier>(async () => "ok");
  validateLocation = vi.fn(() => true);
});

function expectNothingRead() {
  expect(repository.findReceipt).not.toHaveBeenCalled();
  expect(repository.loadState).not.toHaveBeenCalled();
  expect(repository.commit).not.toHaveBeenCalled();
}

describe("create — happy path", () => {
  test("commits a version with its replies and returns the committed receipt", async () => {
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "committed", submissionId: "sub-1", committedAt: NOW.toISOString(), version: { versionIdx: 4, parentVersionIdx: 3, documentContractIdx: 1 } });
    expect(repository.commit).toHaveBeenCalledTimes(1);
    const [command] = repository.commands;
    expect(command).toMatchObject({ context: agent, documentId: "doc-1", now: NOW });
    expect(command!.request).toEqual(versionRequest());
    expect(command!.observed).toMatchObject({ documentType: "markdown", currentVersionIdx: 3 });
    expect(repository.loadState).toHaveBeenCalledWith(agent, "doc-1", ["th-1"]);
  });
});

describe("step 1 — tenant scope and identifiers", () => {
  test("a path tenant that differs from the credential is forbidden", async () => {
    await expect(service().create(agent, "tenant-b", "doc-1", versionRequest())).rejects.toMatchObject({ code: "forbidden" });
    expectNothingRead();
  });

  test.each([
    ["documentId", () => service().create(agent, "tenant-a", "doc 1", versionRequest())],
    ["submissionId", () => service().create(agent, "tenant-a", "doc-1", versionRequest({ submissionId: "x".repeat(TENANT_LIMITS.identifier + 1) }))],
    ["threadId", () => service().create(agent, "tenant-a", "doc-1", replyRequest({ threadUpdates: [update({ threadId: "thé" })] }))],
  ])("an invalid %s is invalid_request", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: "invalid_request" });
    expectNothingRead();
  });

  test("identifiers are checked before scopes", async () => {
    const session: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
    await expect(service().create(session, "tenant-a", "doc 1", versionRequest())).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("step 2 — scopes", () => {
  test("a browser session cannot submit", async () => {
    const session: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session", scopes: ALL_SCOPES };
    const error = await service().create(session, "tenant-a", "doc-1", versionRequest()).catch(e => e);
    expect(error).toBeInstanceOf(TenantAccessError);
    expect(error.code).toBe("forbidden");
    expectNothingRead();
  });

  test("a snapshot needs versions:submit even when the token may reply", async () => {
    const replier: TenantContext = { ...agent, scopes: ["documents:read", "comments:reply"] };
    await expect(service().create(replier, "tenant-a", "doc-1", versionRequest())).rejects.toBeInstanceOf(TenantAccessError);
    expectNothingRead();
  });

  test("thread updates need comments:reply even when the token may submit versions", async () => {
    const submitter: TenantContext = { ...agent, scopes: ["documents:read", "versions:submit"] };
    await expect(service().create(submitter, "tenant-a", "doc-1", versionRequest())).rejects.toBeInstanceOf(TenantAccessError);
    expectNothingRead();
  });

  test("a version with no replies needs only versions:submit", async () => {
    const submitter: TenantContext = { ...agent, scopes: ["versions:submit"] };
    const receipt = await service().create(submitter, "tenant-a", "doc-1", versionRequest({ threadUpdates: [] }));
    expect(receipt.state).toBe("committed");
  });

  test("a pure reply needs only comments:reply", async () => {
    const replier: TenantContext = { ...agent, scopes: ["comments:reply"] };
    const receipt = await service().create(replier, "tenant-a", "doc-1", replyRequest());
    expect(receipt).toMatchObject({ state: "committed", version: null });
  });

  test("scopes are checked before structure", async () => {
    const session: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
    await expect(service().create(session, "tenant-a", "doc-1", replyRequest({ threadUpdates: [] }))).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe("step 3 — structure", () => {
  const attachment = { blobHash: "b3:a", size: 1, contentType: "image/webp" };
  test.each([
    ["an empty submission", () => replyRequest({ threadUpdates: [] })],
    ["more than 50 thread updates", () => replyRequest({ threadUpdates: Array.from({ length: 51 }, (_, i) => update({ threadId: `th-${i}` })) })],
    ["a repeated thread", () => replyRequest({ threadUpdates: [update(), update()] })],
    ["reply text beyond the message bound", () => replyRequest({ threadUpdates: [update({ content: { ...replyContent, text: "a".repeat(TENANT_LIMITS.messageText + 1) } })] })],
    ["too many attachments", () => replyRequest({ threadUpdates: [update({ content: { ...replyContent, attachments: Array.from({ length: TENANT_LIMITS.attachments + 1 }, () => attachment) } })] })],
    ["a result location payload beyond its byte bound", () => versionRequest({ threadUpdates: [update({ resultLocations: [{ ...resultLocation, payload: { text: "a".repeat(TENANT_LIMITS.locationPayloadBytes) } }] })] })],
    ["a lone surrogate in a location payload", () => versionRequest({ threadUpdates: [update({ resultLocations: [{ ...resultLocation, payload: { text: "\ud800" } }] })] })],
    ["result locations without a snapshot", () => replyRequest({ threadUpdates: [update({ resultLocations: [resultLocation] })] })],
  ])("%s is invalid_request, not limit_exceeded", async (_name, body) => {
    await expect(service().create(agent, "tenant-a", "doc-1", body())).rejects.toMatchObject({ code: "invalid_request" });
    expectNothingRead();
  });

  test("exactly 50 thread updates and bodies at their bounds are accepted structurally", async () => {
    repository.documentExists = false;
    const body = replyRequest({ threadUpdates: Array.from({ length: 50 }, (_, i) => update({ threadId: `th-${i}`, content: { ...replyContent, text: "a".repeat(TENANT_LIMITS.messageText) } })) });
    await expect(service().create(agent, "tenant-a", "doc-1", body)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("step 4/5 — fingerprint and idempotent replay", () => {
  test("the fingerprint covers the operation, the document and the body", async () => {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    const expected = await schemaHash({ operation: "createSubmission", documentId: "doc-1", body: versionRequest() });
    expect(repository.commands[0]!.fingerprint).toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the same id with the same body replays the stored receipt without reading state or committing", async () => {
    const first = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    repository.commit.mockClear();
    repository.loadState.mockClear();
    verifySnapshot.mockClear();
    // The state has moved on, so a fresh decision would now be a version conflict.
    const replay = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(replay).toEqual(first);
    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.loadState).not.toHaveBeenCalled();
    expect(verifySnapshot).not.toHaveBeenCalled();
  });

  test("the same id with a different body is invalid_request", async () => {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    repository.commit.mockClear();
    const changed = versionRequest({ threadUpdates: [update({ content: { ...replyContent, text: "Different" }, resultLocations: [resultLocation] })] });
    await expect(service().create(agent, "tenant-a", "doc-1", changed)).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.commit).not.toHaveBeenCalled();
  });
});

describe("step 6 — document and threads exist", () => {
  test("a missing document is not_found", async () => {
    repository.documentExists = false;
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "not_found" });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("a thread that is not in the document is not_found", async () => {
    await expect(service().create(agent, "tenant-a", "doc-1", replyRequest({ threadUpdates: [update(), update({ threadId: "th-ghost" })] }))).rejects.toMatchObject({ code: "not_found" });
    expect(repository.commit).not.toHaveBeenCalled();
  });
});

describe("step 7 — optimistic locks reject without committing", () => {
  test("a stale version pointer is rejected as version_conflict", async () => {
    repository.currentVersionIdx = 4;
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toEqual({
      submissionId: "sub-1", state: "rejected", reason: "version_conflict", rejectedAt: NOW.toISOString(),
      conflict: { currentVersionIdx: 4, availableDocumentContractIdxs: [0, 1], threads: [{ threadId: "th-1", acknowledgedCommentIdx: 0, latestCommentIdx: 3 }] },
    });
    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.receipts.size).toBe(0);
  });

  test("an unavailable contract revision is rejected as document_contract_conflict", async () => {
    repository.availableDocumentContractIdxs = [0];
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "document_contract_conflict", conflict: { availableDocumentContractIdxs: [0] } });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("a stale reply watermark is rejected as reply_watermark_conflict", async () => {
    repository.threads.set("th-1", { ...repository.threads.get("th-1")!, acknowledgedCommentIdx: 1 });
    const receipt = await service().create(agent, "tenant-a", "doc-1", replyRequest());
    expect(receipt).toMatchObject({
      state: "rejected", reason: "reply_watermark_conflict",
      conflict: { currentVersionIdx: 3, threads: [{ threadId: "th-1", acknowledgedCommentIdx: 1, latestCommentIdx: 3 }] },
    });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("the conflict lists thread watermarks in request order", async () => {
    repository.currentVersionIdx = 9;
    const body = versionRequest({ threadUpdates: [update({ threadId: "th-2", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 1 }), update()] });
    const receipt = await service().create(agent, "tenant-a", "doc-1", body);
    expect(receipt.state === "rejected" && receipt.conflict.threads.map(t => t.threadId)).toEqual(["th-2", "th-1"]);
    expect(receipt.state === "rejected" && receipt.conflict.threads[0]).toEqual({ threadId: "th-2", acknowledgedCommentIdx: null, latestCommentIdx: 1 });
  });

  test("when the version and thread locks both fail the reason is version_conflict", async () => {
    repository.currentVersionIdx = 4;
    repository.threads.set("th-1", { ...repository.threads.get("th-1")!, acknowledgedCommentIdx: 1 });
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "version_conflict" });
  });

  test("when the version and contract locks both fail the reason is version_conflict", async () => {
    repository.currentVersionIdx = 4;
    repository.availableDocumentContractIdxs = [0];
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "version_conflict" });
  });

  test("when the contract and thread locks both fail the reason is document_contract_conflict", async () => {
    repository.availableDocumentContractIdxs = [0];
    repository.threads.set("th-1", { ...repository.threads.get("th-1")!, acknowledgedCommentIdx: 1 });
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "document_contract_conflict" });
  });

  test("observing no version against a document with no version passes the version lock", async () => {
    repository.currentVersionIdx = null;
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest({ observedCurrentVersionIdx: null }));
    expect(receipt).toMatchObject({ state: "committed", version: { versionIdx: 0, parentVersionIdx: null } });
  });

  test("a pure reply does not take the version lock", async () => {
    repository.currentVersionIdx = 7;
    repository.availableDocumentContractIdxs = [];
    const receipt = await service().create(agent, "tenant-a", "doc-1", replyRequest());
    expect(receipt.state).toBe("committed");
  });

  test("a lock failure is reported before watermark bounds and snapshot verification", async () => {
    repository.threads.set("th-1", { ...repository.threads.get("th-1")!, acknowledgedCommentIdx: 3 });
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "reply_watermark_conflict" });
    expect(verifySnapshot).not.toHaveBeenCalled();
    expect(repository.loadContract).not.toHaveBeenCalled();
  });
});

describe("step 8 — watermark bounds", () => {
  test.each([
    ["not beyond the acknowledged watermark", 0],
    ["beyond the latest comment", 4],
  ])("respondThrough %s is invalid_request", async (_name, respondThroughCommentIdx) => {
    await expect(service().create(agent, "tenant-a", "doc-1", replyRequest({ threadUpdates: [update({ respondThroughCommentIdx })] }))).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("respondThrough may equal the latest comment", async () => {
    const receipt = await service().create(agent, "tenant-a", "doc-1", replyRequest({ threadUpdates: [update({ respondThroughCommentIdx: 3 })] }));
    expect(receipt.state).toBe("committed");
  });

  test("an unacknowledged thread accepts respondThrough 0", async () => {
    const receipt = await service().create(agent, "tenant-a", "doc-1", replyRequest({ threadUpdates: [update({ threadId: "th-2", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0 })] }));
    expect(receipt.state).toBe("committed");
  });

  test("watermark bounds are checked before the snapshot is verified", async () => {
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest({ threadUpdates: [update({ respondThroughCommentIdx: 9 })] }))).rejects.toMatchObject({ code: "invalid_request" });
    expect(verifySnapshot).not.toHaveBeenCalled();
  });
});

describe("step 9 — snapshot", () => {
  test("verifies the snapshot against the paired revision's schema and content type", async () => {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(repository.loadContract).toHaveBeenCalledWith("markdown", 1);
    expect(verifySnapshot).toHaveBeenCalledWith(snapshotBlob, snapshotSchema, "application/vnd.unidocs.markdown.snapshot+cbor;version=1");
  });

  test("a missing contract revision is unavailable", async () => {
    repository.contracts.delete("markdown#1");
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "unavailable" });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("a snapshot with a different content type is invalid_request and is not read", async () => {
    const body = versionRequest({ newSnapshotBlob: { ...snapshotBlob, contentType: "application/json" } });
    await expect(service().create(agent, "tenant-a", "doc-1", body)).rejects.toMatchObject({ code: "invalid_request" });
    expect(verifySnapshot).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test.each(["invalid_request", "content_unavailable", "unavailable"] as const)("a verifier result of %s is thrown as that code", async result => {
    verifySnapshot.mockResolvedValue(result);
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: result });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("a pure reply loads no contract and verifies nothing", async () => {
    await service().create(agent, "tenant-a", "doc-1", replyRequest());
    expect(repository.loadContract).not.toHaveBeenCalled();
    expect(verifySnapshot).not.toHaveBeenCalled();
  });
});

describe("step 10 — result locations", () => {
  test("each location is validated against the new revision's location schema", async () => {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(validateLocation).toHaveBeenCalledWith(resultLocation, locationSchema);
  });

  test("a location naming another revision is location_contract_violation", async () => {
    const body = versionRequest({ threadUpdates: [update({ resultLocations: [{ ...resultLocation, documentContractIdx: 0 }] })] });
    await expect(service().create(agent, "tenant-a", "doc-1", body)).rejects.toMatchObject({ code: "location_contract_violation" });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("a location failing the schema is location_contract_violation", async () => {
    validateLocation.mockReturnValue(false);
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "location_contract_violation" });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  test("the snapshot is verified before locations are checked", async () => {
    verifySnapshot.mockResolvedValue("content_unavailable");
    validateLocation.mockReturnValue(false);
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "content_unavailable" });
    expect(validateLocation).not.toHaveBeenCalled();
  });
});

describe("step 11 — addressedComments", () => {
  test("covers exactly the comments after the observed watermark through respondThrough, with their base versions", async () => {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(repository.commands[0]!.addressedComments).toEqual([
      { threadId: "th-1", commentIdx: 1, baseVersionIdx: 2 },
      { threadId: "th-1", commentIdx: 2, baseVersionIdx: 3 },
    ]);
  });

  test("follows thread update order, then ascending comment index; an unacknowledged thread starts at 0", async () => {
    const body = versionRequest({ threadUpdates: [update({ threadId: "th-2", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 1 }), update({ respondThroughCommentIdx: 1 })] });
    await service().create(agent, "tenant-a", "doc-1", body);
    expect(repository.commands[0]!.addressedComments).toEqual([
      { threadId: "th-2", commentIdx: 0, baseVersionIdx: 2 },
      { threadId: "th-2", commentIdx: 1, baseVersionIdx: 3 },
      { threadId: "th-1", commentIdx: 1, baseVersionIdx: 2 },
    ]);
  });

  test("is empty when no version is created", async () => {
    await service().create(agent, "tenant-a", "doc-1", replyRequest());
    expect(repository.commands[0]!.addressedComments).toEqual([]);
  });
});

describe("step 12 — commit conflicts", () => {
  test("a conflict at commit is explained by rereading the state, without a second attempt", async () => {
    repository.beforeCommit.push(() => { repository.currentVersionIdx = 4; });
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "version_conflict", rejectedAt: NOW.toISOString(), conflict: { currentVersionIdx: 4 } });
    expect(repository.commit).toHaveBeenCalledTimes(1);
    expect(repository.loadState).toHaveBeenCalledTimes(2);
    expect(repository.findReceipt).toHaveBeenCalledTimes(1);
    expect(verifySnapshot).toHaveBeenCalledTimes(1);
    expect(repository.receipts.size).toBe(0);
  });

  test("a conflict whose reread shows a moved watermark is reply_watermark_conflict", async () => {
    repository.beforeCommit.push(() => { repository.threads.set("th-1", { ...repository.threads.get("th-1")!, acknowledgedCommentIdx: 2 }); });
    const receipt = await service().create(agent, "tenant-a", "doc-1", replyRequest());
    expect(receipt).toMatchObject({ state: "rejected", reason: "reply_watermark_conflict", conflict: { threads: [{ threadId: "th-1", acknowledgedCommentIdx: 2 }] } });
  });

  test("when the reread shows every lock holding, the whole decision runs once more", async () => {
    repository.forcedConflicts = 1;
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt.state).toBe("committed");
    expect(repository.commit).toHaveBeenCalledTimes(2);
    expect(repository.findReceipt).toHaveBeenCalledTimes(2);
  });

  test("the second attempt replays a receipt a concurrent identical submission committed", async () => {
    const racing = new InMemorySubmissionRepository();
    const winner = await createTenantSubmissionService(racing, { validateLocation, verifySnapshot, now: () => NOW }).create(agent, "tenant-a", "doc-1", versionRequest());
    repository.forcedConflicts = 1;
    repository.beforeCommit.push(() => { repository.receipts = racing.receipts; });
    const receipt = await service().create(agent, "tenant-a", "doc-1", versionRequest());
    expect(receipt).toEqual(winner);
    expect(repository.commit).toHaveBeenCalledTimes(1);
  });

  test("two conflicts whose rereads show every lock holding are unavailable", async () => {
    repository.forcedConflicts = 2;
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "unavailable" });
    expect(repository.commit).toHaveBeenCalledTimes(2);
  });

  test("a document that disappears between conflict and reread is not_found", async () => {
    repository.forcedConflicts = 1;
    repository.beforeCommit.push(() => { repository.documentExists = false; });
    await expect(service().create(agent, "tenant-a", "doc-1", versionRequest())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("get", () => {
  async function seeded() {
    await service().create(agent, "tenant-a", "doc-1", versionRequest());
    return repository.receipts.get("doc-1/sub-1")!.receipt;
  }

  test("returns the durable receipt to any Agent scope", async () => {
    const stored = await seeded();
    const reader: TenantContext = { ...agent, scopes: ["documents:read"] };
    await expect(service().get(reader, "tenant-a", "doc-1", "sub-1")).resolves.toEqual(stored);
    expect(repository.findReceipt).toHaveBeenLastCalledWith(reader, "doc-1", "sub-1");
  });

  test("an unknown or rejected submission is not_found", async () => {
    await expect(service().get(agent, "tenant-a", "doc-1", "sub-never")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a browser session is forbidden", async () => {
    await seeded();
    const session: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
    await expect(service().get(session, "tenant-a", "doc-1", "sub-1")).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("a bearer without any Agent scope is forbidden", async () => {
    await seeded();
    repository.findReceipt.mockClear();
    await expect(service().get({ ...agent, scopes: [] }, "tenant-a", "doc-1", "sub-1")).rejects.toBeInstanceOf(TenantAccessError);
    await expect(service().get({ ...agent, scopes: ["admin:everything"] }, "tenant-a", "doc-1", "sub-1")).rejects.toBeInstanceOf(TenantAccessError);
    expect(repository.findReceipt).not.toHaveBeenCalled();
  });

  test("tenant scope and identifiers are enforced", async () => {
    await expect(service().get(agent, "tenant-b", "doc-1", "sub-1")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service().get(agent, "tenant-a", "doc 1", "sub-1")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service().get(agent, "tenant-a", "doc-1", "")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
