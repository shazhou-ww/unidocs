import { expect, test } from "vitest";
import type { AgentSubmissionRequest, SubmissionReceipt } from "@unidocs/protocol-platform";
import type { CommentRecord, DocumentLocation, DocumentRecord, ReplyRecord, ThreadDetail } from "@unidocs/protocol-tenant-portal";
import { handleOperatorEvent, type SnapshotWriter } from "../src/operator-agent.js";
import type { PlatformClient } from "../src/platform-client.js";

const TENANT = "t-local";
const DOC = "doc-1";
const TYPE = "dt-markdown";
const AT = "2026-09-14T12:00:00.000Z";
const RANGE = "unidocs.markdown.text-range/v1";

interface State {
  document: DocumentRecord;
  snapshots: Map<number, string>;
  threads: Map<string, ThreadDetail>;
}

type Outcome = "committed" | "rejected";

/** In-memory Platform: answers from preset state, records submissions, and returns the scripted outcomes in order. */
function fakePlatform(state: State, outcomes: Outcome[] = [], onSubmit?: (body: AgentSubmissionRequest, index: number) => void) {
  const submissions: AgentSubmissionRequest[] = [];
  const platform: PlatformClient = {
    async getDocument(tenantId, documentId) {
      expect([tenantId, documentId]).toEqual([TENANT, DOC]);
      return state.document;
    },
    async getThread(tenantId, documentId, threadId) {
      expect([tenantId, documentId]).toEqual([TENANT, DOC]);
      const thread = state.threads.get(threadId);
      if (!thread) throw new Error(`no thread ${threadId}`);
      return thread;
    },
    async getSnapshotContent(tenantId, documentId, versionIdx) {
      expect([tenantId, documentId]).toEqual([TENANT, DOC]);
      const content = state.snapshots.get(versionIdx);
      if (content === undefined) throw new Error(`no version ${versionIdx}`);
      return content;
    },
    async submit(tenantId, documentId, body) {
      expect([tenantId, documentId]).toEqual([TENANT, DOC]);
      submissions.push(body);
      const outcome = outcomes[submissions.length - 1] ?? "committed";
      onSubmit?.(body, submissions.length - 1);
      const receipt: SubmissionReceipt = outcome === "committed"
        ? { submissionId: body.submissionId, state: "committed", version: null, replies: [], committedAt: AT }
        : { submissionId: body.submissionId, state: "rejected", reason: "version_conflict",
          conflict: { currentVersionIdx: state.document.currentVersionIdx, availableDocumentContractIdxs: [0], threads: [] }, rejectedAt: AT };
      return receipt;
    },
  };
  return { platform, submissions };
}

function fakeSnapshots() {
  const writes: { tenantId: string; documentType: string; content: string }[] = [];
  const snapshots: SnapshotWriter = {
    async write(tenantId, documentType, content) {
      writes.push({ tenantId, documentType, content });
      return { blobHash: `hash-${writes.length}`, size: content.length, contentType: `application/vnd.unidocs.${documentType}.snapshot+cbor;version=1` };
    },
  };
  return { snapshots, writes };
}

function recorder() {
  const entries: Record<string, unknown>[] = [];
  return { entries, log: (entry: object) => { entries.push(entry as Record<string, unknown>); } };
}

function document(currentVersionIdx: number | null, name = "季度报告"): DocumentRecord {
  return { documentId: DOC, name, documentType: TYPE, currentVersionIdx, createdAt: AT };
}

function comment(commentIdx: number, text: string, location: DocumentLocation | null = null): CommentRecord {
  return { commentIdx, baseVersionIdx: 0, content: { text, richContent: null, attachments: [] }, location, authorId: "user-1", createdAt: AT };
}

function reply(replyIdx: number, respondThroughCommentIdx: number): ReplyRecord {
  return { replyIdx, respondThroughCommentIdx, content: { text: "ok", richContent: null, attachments: [] }, resultLocations: [],
    authorAgentId: "agent:markdown-primary", submissionId: `s-${replyIdx}`, createdAt: AT };
}

function range(start: number, end: number, quote: string): DocumentLocation {
  return { documentContractIdx: 0, locationType: RANGE, payload: { start, end, quote } };
}

function event(reason: "document.created" | "comment.appended" | "current_version.moved", currentVersionIdx: number | null, newComments: { threadId: string; commentIdx: number }[] = []) {
  return {
    protocol: "unidocs-operator-webhook/v1" as const, eventId: "e1", reason, tenantId: TENANT, documentId: DOC, documentType: TYPE, currentVersionIdx,
    newComments: newComments.map(item => ({ ...item, acknowledgedCommentIdx: null })), occurredAt: AT,
  };
}

test("1. document.created with no version writes the heading snapshot and submits the first version", async () => {
  const state: State = { document: document(null), snapshots: new Map(), threads: new Map() };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("document.created", null), { platform, snapshots });
  expect(writes).toEqual([{ tenantId: TENANT, documentType: TYPE, content: "# 季度报告\n\n" }]);
  expect(submissions).toEqual([{
    submissionId: "evt-e1-0", observedCurrentVersionIdx: null, newDocumentContractIdx: 0,
    newSnapshotBlob: { blobHash: "hash-1", size: "# 季度报告\n\n".length, contentType: `application/vnd.unidocs.${TYPE}.snapshot+cbor;version=1` },
    threadUpdates: [],
  }]);
});

test("2. document.created for a document that already has a version does nothing", async () => {
  const state: State = { document: document(0), snapshots: new Map([[0, "# x\n\n"]]), threads: new Map() };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("document.created", 0), { platform, snapshots });
  expect(submissions).toEqual([]);
  expect(writes).toEqual([]);
});

test("3. a replace comment on a matching text range submits the rewritten snapshot with a reply", async () => {
  const content = "# 标题\n\n旧文字在这里";
  const quote = "旧文字";
  const start = content.indexOf(quote);
  const state: State = {
    document: document(0), snapshots: new Map([[0, content]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "改为：新的文字", range(start, start + quote.length, quote))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots });
  expect(writes.map(write => write.content)).toEqual(["# 标题\n\n新的文字在这里"]);
  expect(submissions).toEqual([{
    submissionId: "evt-e1-th-1-0", observedCurrentVersionIdx: 0, newDocumentContractIdx: 0,
    newSnapshotBlob: { blobHash: "hash-1", size: "# 标题\n\n新的文字在这里".length, contentType: `application/vnd.unidocs.${TYPE}.snapshot+cbor;version=1` },
    threadUpdates: [{
      threadId: "th-1", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0,
      content: { text: "已按评论修改：「旧文字」→「新的文字」", richContent: null, attachments: [] },
      resultLocations: [{ documentContractIdx: 0, locationType: RANGE, payload: { start, end: start + "新的文字".length, quote: "新的文字" } }],
    }],
  }]);
});

test("4. a question comment gets a pure reply with no snapshot and no result locations", async () => {
  const state: State = {
    document: document(0), snapshots: new Map([[0, "# 标题\n\n正文"]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "这里是什么意思？", range(5, 7, "正文"))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots });
  expect(writes).toEqual([]);
  expect(submissions).toEqual([{
    submissionId: "evt-e1-th-1-0",
    threadUpdates: [{
      threadId: "th-1", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0,
      content: { text: "收到：这里是什么意思？", richContent: null, attachments: [] }, resultLocations: [],
    }],
  }]);
  expect(submissions[0]).not.toHaveProperty("newSnapshotBlob");
});

test("5. a thread whose latest comment is already acknowledged is skipped", async () => {
  const state: State = {
    document: document(0), snapshots: new Map([[0, "x"]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "改为：y"), comment(1, "谢谢")], replies: [reply(0, 1)] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 1 }, { threadId: "th-1", commentIdx: 1 }]), { platform, snapshots });
  expect(submissions).toEqual([]);
});

test("6. a rejected submission is recomputed from re-read state and retried with the next attempt", async () => {
  const quote = "旧文字";
  const state: State = {
    document: document(0), snapshots: new Map([[0, "旧文字"], [1, "前言\n旧文字"]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "这里？"), comment(1, "改为：新", range(0, 3, quote))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state, ["rejected", "committed"], (_body, index) => {
    if (index !== 0) return;
    // While the first attempt was in flight, the version moved and another reply acknowledged comment 0.
    state.document = document(1);
    state.threads.set("th-1", { ...state.threads.get("th-1")!, replies: [reply(0, 0)] });
  });
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 1 }]), { platform, snapshots });
  expect(submissions.map(body => body.submissionId)).toEqual(["evt-e1-th-1-0", "evt-e1-th-1-1"]);
  expect(submissions.map(body => body.observedCurrentVersionIdx)).toEqual([0, 1]);
  expect(submissions.map(body => body.threadUpdates[0].observedAcknowledgedCommentIdx)).toEqual([null, 0]);
  expect(writes.map(write => write.content)).toEqual(["新", "前言\n新"]);
  expect(submissions[1].threadUpdates[0].resultLocations[0].payload).toEqual({ start: 3, end: 4, quote: "新" });
});

test("7. a quote that moved away from its recorded range is found by searching the content", async () => {
  const content = "第一段\n\n第二段目标句";
  const state: State = {
    document: document(0), snapshots: new Map([[0, content]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "replace with: 新句", range(0, 3, "目标句"))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots });
  const at = content.indexOf("目标句");
  expect(writes.map(write => write.content)).toEqual(["第一段\n\n第二段新句"]);
  expect(submissions[0].threadUpdates[0].resultLocations).toEqual([{ documentContractIdx: 0, locationType: RANGE, payload: { start: at, end: at + 2, quote: "新句" } }]);
});

test("7b. a quote that no longer exists anywhere gets a pure reply saying so", async () => {
  const state: State = {
    document: document(0), snapshots: new Map([[0, "完全不同的正文"]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "改为：新句", range(0, 3, "目标句"))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots });
  expect(writes).toEqual([]);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).not.toHaveProperty("newSnapshotBlob");
  expect(submissions[0].threadUpdates[0].resultLocations).toEqual([]);
  expect(submissions[0].threadUpdates[0].content.text).toContain("目标句");
});

test("7c. a replace comment whose text is already the quoted text gets a pure reply and writes no snapshot", async () => {
  const content = "# 标题\n\n新的文字在这里";
  const quote = "新的文字";
  const start = content.indexOf(quote);
  const state: State = {
    document: document(0), snapshots: new Map([[0, content]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "改为：新的文字", range(start, start + quote.length, quote))], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots, writes } = fakeSnapshots();
  await handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots });
  expect(writes).toEqual([]);
  expect(submissions).toEqual([{
    submissionId: "evt-e1-th-1-0",
    threadUpdates: [{
      threadId: "th-1", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0,
      content: { text: "内容已是「新的文字」，未作修改", richContent: null, attachments: [] }, resultLocations: [],
    }],
  }]);
  expect(submissions[0]).not.toHaveProperty("newSnapshotBlob");
});

test("8. three rejections stop after exactly three submissions, log the abandonment, and do not throw", async () => {
  const state: State = {
    document: document(0), snapshots: new Map([[0, "x"]]),
    threads: new Map([["th-1", { threadId: "th-1", comments: [comment(0, "嗯")], replies: [] }]]),
  };
  const { platform, submissions } = fakePlatform(state, ["rejected", "rejected", "rejected", "committed"]);
  const { snapshots } = fakeSnapshots();
  const { entries, log } = recorder();
  await expect(handleOperatorEvent(event("comment.appended", 0, [{ threadId: "th-1", commentIdx: 0 }]), { platform, snapshots, log })).resolves.toBeUndefined();
  expect(submissions.map(body => body.submissionId)).toEqual(["evt-e1-th-1-0", "evt-e1-th-1-1", "evt-e1-th-1-2"]);
  expect(entries).toEqual([expect.objectContaining({ event: "markdown_operator_submission_abandoned", eventId: "e1", threadId: "th-1" })]);
});

test("document.created stops retrying once someone else created the first version", async () => {
  const state: State = { document: document(null), snapshots: new Map(), threads: new Map() };
  const { platform, submissions } = fakePlatform(state, ["rejected", "rejected"], (_body, index) => {
    // The second attempt loses to another writer that created version 0.
    if (index === 1) state.document = document(0);
  });
  const { snapshots } = fakeSnapshots();
  await handleOperatorEvent(event("document.created", null), { platform, snapshots });
  expect(submissions.map(body => body.submissionId)).toEqual(["evt-e1-0", "evt-e1-1"]);
});

test("current_version.moved does nothing, and a failure is logged rather than thrown", async () => {
  const state: State = { document: document(0), snapshots: new Map(), threads: new Map() };
  const { platform, submissions } = fakePlatform(state);
  const { snapshots } = fakeSnapshots();
  await handleOperatorEvent(event("current_version.moved", 0), { platform, snapshots });
  expect(submissions).toEqual([]);

  const { entries, log } = recorder();
  await expect(handleOperatorEvent(event("comment.appended", 0, [{ threadId: "missing", commentIdx: 0 }]), { platform, snapshots, log })).resolves.toBeUndefined();
  expect(entries).toEqual([{ event: "markdown_operator_event_failed", eventId: "e1", name: "Error", message: "no thread missing" }]);
});
