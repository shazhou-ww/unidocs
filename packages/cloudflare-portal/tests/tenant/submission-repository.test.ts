/**
 * The submission repository's correctness lives in SQL: the lock guards, the
 * CHECK-driven rollback, the primary keys that adjudicate index races and the
 * derived watermarks. All of it is proven against real D1 under Miniflare.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { AddressedComment, AgentSubmissionRequest } from "@unidocs/protocol-platform";
import { TenantOperationError, type SubmissionCommitCommand, type TenantContext } from "@unidocs/portal-service";
import { D1TenantSubmissionRepository } from "../../src/tenant/submission-repository.js";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const agent: TenantContext = {
  tenantId: "t-local", principalId: "agent:markdown-primary", transport: "bearer",
  scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
};

const NOW = new Date("2026-09-14T08:00:00.789Z");
const NOW_ISO = "2026-09-14T08:00:00.000Z";

const snapshot = { blobHash: "blob-1", size: 12, contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1" };
const replyContent = { text: "done", richContent: null, attachments: [] };

const contractRow = {
  documentType: "markdown",
  documentContractIdx: 0,
  formatVersion: 1,
  snapshot: {
    contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1",
    schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object", title: "snapshot" },
    schemaHash: "sha256:snapshot",
  },
  location: {
    contentType: "application/vnd.unidocs.markdown.location+json;version=1",
    schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object", title: "location" },
    schemaHash: "sha256:location",
  },
  contractHash: "sha256:contract",
  createdAt: "2026-09-11T00:00:00.000Z",
};

function registration(over: Record<string, unknown> = {}) {
  return {
    documentType: "markdown",
    viewBundle: { viewBundleId: "vb-1", manifest: { supportedDocumentContractIdxs: [0, 1] } },
    builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { markdown: [2, 1] } } },
    ...over,
  };
}

/** Runs `before` ahead of every batch, simulating a writer that lands between the index read and the commit. */
function interceptBatch(db: D1Database, before: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Parameters<D1Database["batch"]>[0]) => {
          await before();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("D1TenantSubmissionRepository (real D1)", () => {
  let real: RealD1;
  let db: D1Database;
  let repository: D1TenantSubmissionRepository;

  beforeEach(async () => {
    real = await startRealD1();
    db = real.db;
    repository = new D1TenantSubmissionRepository(db);
    await seedDocumentType(registration());
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', 'doc-1', 'Doc', 'markdown', NULL, 0)",
    ).run();
    await seedThread("th-1", 3);
    await seedThread("th-2", 2);
  });

  afterEach(async () => {
    await real.dispose();
  });

  async function seedDocumentType(value: Record<string, unknown>) {
    await db.prepare(
      "INSERT OR REPLACE INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, ?, '2026-09-11T00:00:00.000Z')",
    ).bind(JSON.stringify(value)).run();
  }

  async function seedThread(threadId: string, comments: number) {
    await db.prepare("INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES ('t-local', 'doc-1', ?, 0)").bind(threadId).run();
    for (let idx = 0; idx < comments; idx++) await seedComment(threadId, idx);
  }

  async function seedComment(threadId: string, commentIdx: number) {
    await db.prepare(
      `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
       VALUES ('t-local', 'doc-1', ?, ?, 0, '{"text":"c","richContent":null,"attachments":[]}', NULL, 'user-1', 0)`,
    ).bind(threadId, commentIdx).run();
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const { results } = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    const counts: Record<string, number> = {};
    for (const { name } of results) {
      counts[name] = (await db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>())!.n;
    }
    expect(counts).toHaveProperty("portal_mutation_guard");
    return counts;
  }

  async function count(table: string): Promise<number> {
    return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  }

  async function currentVersionIdx(): Promise<number | null> {
    return (await db.prepare("SELECT current_version_idx FROM portal_documents WHERE document_id = 'doc-1'").first<{ current_version_idx: number | null }>())!.current_version_idx;
  }

  type RequestInput = Omit<AgentSubmissionRequest, "threadUpdates"> & { threadUpdates?: AgentSubmissionRequest["threadUpdates"] };

  async function command(input: RequestInput, options: { addressedComments?: AddressedComment[] } = {}): Promise<SubmissionCommitCommand> {
    const request: AgentSubmissionRequest = { threadUpdates: [], ...input };
    const observed = await repository.loadState(agent, "doc-1", request.threadUpdates.map(update => update.threadId));
    return {
      context: agent, documentId: "doc-1", fingerprint: `fp-${request.submissionId}`, request, observed: observed!,
      addressedComments: options.addressedComments ?? [], now: NOW,
    };
  }

  const versionRequest = (submissionId: string, observedCurrentVersionIdx: number | null): RequestInput => ({
    submissionId, observedCurrentVersionIdx, newDocumentContractIdx: 0, newSnapshotBlob: snapshot,
  });

  const update = (threadId: string, observedAcknowledgedCommentIdx: number | null, respondThroughCommentIdx: number) => ({
    threadId, observedAcknowledgedCommentIdx, respondThroughCommentIdx, content: replyContent, resultLocations: [],
  });

  async function commitOk(input: RequestInput, addressedComments: AddressedComment[] = []) {
    const outcome = await repository.commit(await command(input, { addressedComments }));
    if (outcome.kind !== "committed") throw new Error("expected a committed outcome");
    return outcome.receipt;
  }

  describe("loadState", () => {
    it("reads the document, the derived thread watermarks and the comments of the named threads only", async () => {
      await commitOk({ submissionId: "reply-1", threadUpdates: [update("th-1", null, 1)] });
      const state = await repository.loadState(agent, "doc-1", ["th-1", "th-2", "th-missing"]);
      expect(state).not.toBeNull();
      expect(state!.documentType).toBe("markdown");
      expect(state!.currentVersionIdx).toBeNull();
      expect([...state!.threads.keys()].sort()).toEqual(["th-1", "th-2"]);
      expect(state!.threads.get("th-1")).toEqual({
        threadId: "th-1", acknowledgedCommentIdx: 1, latestCommentIdx: 2,
        comments: [0, 1, 2].map(commentIdx => ({ commentIdx, baseVersionIdx: 0 })),
      });
      expect(state!.threads.get("th-2")).toMatchObject({ acknowledgedCommentIdx: null, latestCommentIdx: 1 });
    });

    it("is null for a missing document and for another tenant's document", async () => {
      await expect(repository.loadState(agent, "doc-missing", [])).resolves.toBeNull();
      await expect(repository.loadState({ ...agent, tenantId: "t-other" }, "doc-1", [])).resolves.toBeNull();
    });

    it("has no available contracts until an Operator is registered, then the View ∩ Operator intersection", async () => {
      await seedDocumentType(registration({ builtinOperator: null }));
      expect((await repository.loadState(agent, "doc-1", []))!.availableDocumentContractIdxs).toEqual([]);

      await seedDocumentType(registration());
      // View supports [0, 1], Operator supports [2, 1]: only 1 is writable.
      expect((await repository.loadState(agent, "doc-1", []))!.availableDocumentContractIdxs).toEqual([1]);

      await seedDocumentType(registration({
        viewBundle: { viewBundleId: "vb-2", manifest: { supportedDocumentContractIdxs: [2, 1, 0] } },
        builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { markdown: [0, 2] } } },
      }));
      expect((await repository.loadState(agent, "doc-1", []))!.availableDocumentContractIdxs).toEqual([0, 2]);
    });
  });

  describe("loadContract", () => {
    it("returns the revision's snapshot and location schemas, or null", async () => {
      await db.prepare(
        "INSERT INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES ('markdown', 0, 'sha256:contract', ?, 0)",
      ).bind(JSON.stringify(contractRow)).run();
      await expect(repository.loadContract("markdown", 0)).resolves.toEqual({
        snapshotSchema: contractRow.snapshot.schema, locationSchema: contractRow.location.schema,
      });
      await expect(repository.loadContract("markdown", 1)).resolves.toBeNull();
      await expect(repository.loadContract("other", 0)).resolves.toBeNull();
    });
  });

  describe("commit", () => {
    it("commits a first version: one version row, the pointer at 0 and a receipt equal to what the readers return", async () => {
      const outcome = await repository.commit(await command(versionRequest("sub-1", null)));
      expect(outcome.kind).toBe("committed");
      const receipt = outcome.kind === "committed" ? outcome.receipt : null;

      expect(await count("portal_versions")).toBe(1);
      expect(await currentVersionIdx()).toBe(0);
      expect(await count("portal_submissions")).toBe(1);
      expect(await count("portal_mutation_guard")).toBe(0);

      const versions = new D1TenantVersionRepository(db, { read: async () => new ReadableStream(), retain: async () => {}, release: async () => {} } as never);
      const stored = await versions.get(agent, "doc-1", 0);
      expect(receipt!.version).toEqual(stored);
      expect(stored).toMatchObject({ versionIdx: 0, parentVersionIdx: null, documentContractIdx: 0, authorAgentId: agent.principalId, submissionId: "sub-1", createdAt: NOW_ISO });
      expect(receipt).toMatchObject({ state: "committed", submissionId: "sub-1", replies: [], committedAt: NOW_ISO });

      const snapshotRow = await db.prepare("SELECT snapshot_blob_hash, snapshot_size, snapshot_content_type FROM portal_versions").first();
      expect(snapshotRow).toEqual({ snapshot_blob_hash: snapshot.blobHash, snapshot_size: snapshot.size, snapshot_content_type: snapshot.contentType });

      await expect(repository.findReceipt(agent, "doc-1", "sub-1")).resolves.toEqual({ fingerprint: "fp-sub-1", receipt });
    });

    it("commits a second version at the next index with the observed pointer as parent", async () => {
      await commitOk(versionRequest("sub-1", null));
      const receipt = await commitOk(versionRequest("sub-2", 0));
      expect(receipt.version).toMatchObject({ versionIdx: 1, parentVersionIdx: 0 });
      expect(await currentVersionIdx()).toBe(1);
    });

    it("stores addressed comments as camelCase JSON that the version repository reads back", async () => {
      const addressed = [{ threadId: "th-1", commentIdx: 0, baseVersionIdx: 0 }, { threadId: "th-1", commentIdx: 1, baseVersionIdx: 0 }];
      const receipt = await commitOk({ ...versionRequest("sub-1", null), threadUpdates: [update("th-1", null, 1)] }, addressed);
      const versions = new D1TenantVersionRepository(db, {} as never);
      expect((await versions.get(agent, "doc-1", 0))!.addressedComments).toEqual(addressed);
      expect(receipt.version!.addressedComments).toEqual(addressed);
    });

    it("commits a pure reply to two threads: two reply rows, no version, the pointer untouched", async () => {
      const receipt = await commitOk({ submissionId: "reply-1", threadUpdates: [update("th-1", null, 2), update("th-2", null, 1)] });

      expect(receipt.version).toBeNull();
      expect(await count("portal_replies")).toBe(2);
      expect(await count("portal_versions")).toBe(0);
      expect(await currentVersionIdx()).toBeNull();

      const threads = new D1TenantThreadRepository(db);
      const th1 = await threads.get(agent, "doc-1", "th-1");
      const th2 = await threads.get(agent, "doc-1", "th-2");
      expect([...th1!.replies, ...th2!.replies]).toEqual(receipt.replies);
      expect(receipt.replies[0]).toMatchObject({ replyIdx: 0, respondThroughCommentIdx: 2, submissionId: "reply-1", authorAgentId: agent.principalId, createdAt: NOW_ISO });

      const state = await repository.loadState(agent, "doc-1", ["th-1", "th-2"]);
      expect(state!.threads.get("th-1")!.acknowledgedCommentIdx).toBe(2);
      expect(state!.threads.get("th-2")!.acknowledgedCommentIdx).toBe(1);
    });

    it("gives a later reply on the same thread the next reply index", async () => {
      await commitOk({ submissionId: "reply-1", threadUpdates: [update("th-1", null, 2)] });
      await seedComment("th-1", 3);
      const receipt = await commitOk({ submissionId: "reply-2", threadUpdates: [update("th-1", 2, 3)] });
      expect(receipt.replies[0]).toMatchObject({ replyIdx: 1, respondThroughCommentIdx: 3 });
      const thread = await new D1TenantThreadRepository(db).get(agent, "doc-1", "th-1");
      expect(thread!.replies.map(reply => reply.replyIdx)).toEqual([0, 1]);
      expect(thread!.replies[1]).toEqual(receipt.replies[0]);
    });

    it("stores result locations in the shape the thread repository reads back", async () => {
      const location = { documentContractIdx: 0, locationType: "text-range", payload: { start: 1, end: 4 } };
      const receipt = await commitOk({ ...versionRequest("sub-1", null), threadUpdates: [{ ...update("th-1", null, 2), resultLocations: [location] }] });
      const thread = await new D1TenantThreadRepository(db).get(agent, "doc-1", "th-1");
      expect(thread!.replies).toEqual(receipt.replies);
      expect(thread!.replies[0]!.resultLocations).toEqual([location]);
    });

    it("leaves no trace when the version lock fails", async () => {
      await commitOk(versionRequest("sub-1", null));
      await commitOk(versionRequest("sub-2", 0));
      const stale = await command(versionRequest("sub-3", 0));
      const before = await tableCounts();

      await expect(repository.commit(stale)).resolves.toEqual({ kind: "conflict" });
      expect(await tableCounts()).toEqual(before);
      await expect(repository.findReceipt(agent, "doc-1", "sub-3")).resolves.toBeNull();
    });

    it("leaves no trace when a thread lock fails", async () => {
      await commitOk({ submissionId: "reply-1", threadUpdates: [update("th-1", null, 1)] });
      const stale = await command({ submissionId: "reply-2", threadUpdates: [update("th-2", null, 1), update("th-1", null, 2)] });
      const before = await tableCounts();

      await expect(repository.commit(stale)).resolves.toEqual({ kind: "conflict" });
      expect(await tableCounts()).toEqual(before);
    });

    it("does not create the version when a thread lock of the same submission fails", async () => {
      await commitOk({ submissionId: "reply-1", threadUpdates: [update("th-1", null, 1)] });
      const stale = await command({ ...versionRequest("sub-1", null), threadUpdates: [update("th-1", null, 2)] });
      const before = await tableCounts();

      await expect(repository.commit(stale)).resolves.toEqual({ kind: "conflict" });
      expect(await tableCounts()).toEqual(before);
      expect(await count("portal_versions")).toBe(0);
      expect(await currentVersionIdx()).toBeNull();
    });

    it("commits exactly one of two concurrent versions on the same observed pointer", async () => {
      const [a, b] = await Promise.all([command(versionRequest("sub-a", null)), command(versionRequest("sub-b", null))]);
      const outcomes = await Promise.all([repository.commit(a), repository.commit(b)]);
      expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(["committed", "conflict"]);
      expect(await count("portal_versions")).toBe(1);
      expect(await count("portal_submissions")).toBe(1);
      expect(await currentVersionIdx()).toBe(0);
    });

    it("commits exactly one of two concurrent replies on the same thread watermark", async () => {
      const [a, b] = await Promise.all([
        command({ submissionId: "reply-a", threadUpdates: [update("th-1", null, 1)] }),
        command({ submissionId: "reply-b", threadUpdates: [update("th-1", null, 2)] }),
      ]);
      const outcomes = await Promise.all([repository.commit(a), repository.commit(b)]);
      expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(["committed", "conflict"]);
      expect(await count("portal_replies")).toBe(1);
      expect(await count("portal_submissions")).toBe(1);
    });

    it("retries on the next index when a concurrent writer took the proposed one while the locks still hold", async () => {
      await commitOk(versionRequest("sub-1", null));
      let raced = false;
      const racing = new D1TenantSubmissionRepository(interceptBatch(db, async () => {
        if (raced) return;
        raced = true;
        // Takes version_idx 1 without moving the pointer, so the version lock still holds.
        await db.prepare(
          `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id,
             addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
           VALUES ('t-local', 'doc-1', 1, 0, 0, 'agent:other', 'sub-other', '[]', 'blob-x', 1, 'x', 0)`,
        ).run();
      }));

      const outcome = await racing.commit(await command(versionRequest("sub-2", 0)));
      expect(outcome.kind).toBe("committed");
      expect(outcome.kind === "committed" && outcome.receipt.version!.versionIdx).toBe(2);
      expect(await currentVersionIdx()).toBe(2);
    });

    it("gives up as unavailable after five index races", async () => {
      let batches = 0;
      const racing = new D1TenantSubmissionRepository(interceptBatch(db, async () => {
        batches += 1;
        await db.prepare(
          `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at)
           SELECT 't-local', 'doc-1', 'th-2', COALESCE(MAX(reply_idx), -1) + 1, 0, '{}', '[]', 'agent:other', 'sub-other', 0
           FROM portal_replies WHERE tenant_id = 't-local' AND document_id = 'doc-1' AND thread_id = 'th-2'`,
        ).run();
      }));
      await commitOk({ submissionId: "reply-0", threadUpdates: [update("th-2", null, 0)] });
      await seedComment("th-2", 2);

      const error = await racing.commit(await command({ submissionId: "reply-1", threadUpdates: [update("th-2", 0, 2)] })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TenantOperationError);
      expect((error as TenantOperationError).code).toBe("unavailable");
      expect(batches).toBe(5);
      await expect(repository.findReceipt(agent, "doc-1", "reply-1")).resolves.toBeNull();
    });

    it("reports a conflict, never an error, when a twin with the same submission id committed first", async () => {
      const twin = await command(versionRequest("sub-1", null));
      const racing = new D1TenantSubmissionRepository(interceptBatch(db, async () => {
        // The twin's receipt lands but, as far as this commit can see, the locks have not moved.
        await db.prepare(
          "INSERT OR IGNORE INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t-local', 'doc-1', 'sub-1', ?, 'fp-twin', ?, 0)",
        ).bind(agent.principalId, JSON.stringify({ submissionId: "sub-1", state: "committed", version: null, replies: [], committedAt: NOW_ISO })).run();
      }));

      await expect(racing.commit(twin)).resolves.toEqual({ kind: "conflict" });
      expect(await count("portal_versions")).toBe(0);
      expect((await repository.findReceipt(agent, "doc-1", "sub-1"))!.fingerprint).toBe("fp-twin");
    });

    it("concurrent identical submissions commit once and never throw", async () => {
      const [a, b] = await Promise.all([command(versionRequest("sub-1", null)), command(versionRequest("sub-1", null))]);
      const outcomes = await Promise.all([repository.commit(a), repository.commit(b)]);
      expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(["committed", "conflict"]);
      expect(await count("portal_submissions")).toBe(1);
    });

    it("is not_found when the document disappeared before the commit", async () => {
      const orphan = await command(versionRequest("sub-1", null));
      const racing = new D1TenantSubmissionRepository(interceptBatch(db, async () => {
        await db.prepare("DELETE FROM portal_comments").run();
        await db.prepare("DELETE FROM portal_threads").run();
        await db.prepare("DELETE FROM portal_documents").run();
      }));
      const error = await racing.commit(orphan).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TenantOperationError);
      expect((error as TenantOperationError).code).toBe("not_found");
      expect(await count("portal_versions")).toBe(0);
      expect(await count("portal_mutation_guard")).toBe(0);
    });
  });
});
