import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { deriveThreadState } from "../src/model/thread-state.js";
import { loadDiscussionSummary } from "../src/model/discussion-summary.js";

const ping = (pingIdx: number) => ({
  pingIdx, baseVersionIdx: 0, content: { text: `p${pingIdx}`, richContent: null, attachments: [] },
  location: null, authorId: "user:1", createdAt: "2026-09-01T00:00:00.000Z",
});
const pong = (pongIdx: number, through: number, resultLocations: unknown[] = []) => ({
  pongIdx, respondThroughPingIdx: through, content: { text: `a${pongIdx}`, richContent: null, attachments: [] },
  resultLocations, authorAgentId: "agent:1", submissionId: `s${pongIdx}`, createdAt: "2026-09-01T00:00:00.000Z",
});

describe("deriveThreadState", () => {
  it("只有 ping 时是待回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [] } as never);
    expect(state).toMatchObject({ open: true, latestPingIdx: 0, acknowledgedPingIdx: -1 });
  });

  it("水位覆盖最新 ping 时是已回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0)] } as never);
    expect(state.open).toBe(false);
  });

  it("水位之后又追加 ping 时重新变成待回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0), ping(1)], pongs: [pong(0, 0)] } as never);
    expect(state).toMatchObject({ open: true, acknowledgedPingIdx: 0, latestPingIdx: 1 });
  });

  it("一条 pong 可以累计确认多条 ping", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0), ping(1), ping(2)], pongs: [pong(0, 2)] } as never);
    expect(state.open).toBe(false);
  });

  it("latestPong 取最后一条", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0), pong(1, 0)] } as never);
    expect(state.latestPong?.pongIdx).toBe(1);
  });

  it("纯 pong 被标出来，不携带版本号", () => {
    const plain = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0)] } as never);
    const withVersion = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0, [{}])] } as never);

    expect(plain.latestPongIsPlain).toBe(true);
    expect(withVersion.latestPongIsPlain).toBe(false);
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
