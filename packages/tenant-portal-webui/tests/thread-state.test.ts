import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { deriveThreadState } from "../src/model/thread-state.js";
import { loadDiscussionSummary } from "../src/model/discussion-summary.js";

const comment = (commentIdx: number) => ({
  commentIdx, baseVersionIdx: 0, content: { text: `p${commentIdx}`, richContent: null, attachments: [] },
  location: null, authorId: "user:1", createdAt: "2026-09-01T00:00:00.000Z",
});
const reply = (replyIdx: number, through: number, resultLocations: unknown[] = []) => ({
  replyIdx, respondThroughCommentIdx: through, content: { text: `a${replyIdx}`, richContent: null, attachments: [] },
  resultLocations, authorAgentId: "agent:1", submissionId: `s${replyIdx}`, createdAt: "2026-09-01T00:00:00.000Z",
});

describe("deriveThreadState", () => {
  it("只有评论时是待回复", () => {
    const state = deriveThreadState({ threadId: "t", comments: [comment(0)], replies: [] } as never);
    expect(state).toMatchObject({ open: true, latestCommentIdx: 0, acknowledgedCommentIdx: -1 });
  });

  it("水位覆盖最新评论时是已回复", () => {
    const state = deriveThreadState({ threadId: "t", comments: [comment(0)], replies: [reply(0, 0)] } as never);
    expect(state.open).toBe(false);
  });

  it("水位之后又追加评论时重新变成待回复", () => {
    const state = deriveThreadState({ threadId: "t", comments: [comment(0), comment(1)], replies: [reply(0, 0)] } as never);
    expect(state).toMatchObject({ open: true, acknowledgedCommentIdx: 0, latestCommentIdx: 1 });
  });

  it("一条回复可以累计确认多条评论", () => {
    const state = deriveThreadState({ threadId: "t", comments: [comment(0), comment(1), comment(2)], replies: [reply(0, 2)] } as never);
    expect(state.open).toBe(false);
  });

  it("latestReply 取最后一条", () => {
    const state = deriveThreadState({ threadId: "t", comments: [comment(0)], replies: [reply(0, 0), reply(1, 0)] } as never);
    expect(state.latestReply?.replyIdx).toBe(1);
  });

  it("纯回复被标出来，不携带版本号", () => {
    const plain = deriveThreadState({ threadId: "t", comments: [comment(0)], replies: [reply(0, 0)] } as never);
    const withVersion = deriveThreadState({ threadId: "t", comments: [comment(0)], replies: [reply(0, 0, [{}])] } as never);

    expect(plain.latestReplyIsPlain).toBe(true);
    expect(withVersion.latestReplyIsPlain).toBe(false);
  });
});

describe("loadDiscussionSummary", () => {
  it("对样本文档算出待回复与已回复数", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });

    const summary = await loadDiscussionSummary(client, "doc-sample");

    expect(summary.openCount + summary.answeredCount).toBe(summary.threads.length);
    expect(summary.openCount).toBeGreaterThan(0);
    expect(summary.answeredCount).toBeGreaterThan(0);
  });

  it("空文档给出零计数", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
    const summary = await loadDiscussionSummary(client, "doc-empty");

    expect(summary).toMatchObject({ openCount: 0, answeredCount: 0, threads: [] });
  });
});
