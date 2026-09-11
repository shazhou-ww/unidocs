import { describe, expect, it } from "vitest";
import { createMemoryStore, isOpen } from "../src/memory/store.js";
import { createScriptedAgent } from "../src/memory/agent.js";

function store() {
  return createMemoryStore({
    documents: [{ documentId: "doc-1", name: "样例", versions: [{ content: "# 一\n" }], threads: [] }],
  });
}

describe("createScriptedAgent", () => {
  it("没有待处理 ping 时 runPending 返回 0", () => {
    const agent = createScriptedAgent({ store: store() });
    expect(agent.pendingCount()).toBe(0);
    expect(agent.runPending()).toBe(0);
  });

  it("处理一条待回复的 ping，产生 pong 并把水位推到该 ping", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0,
      content: { text: "改一下", richContent: null, attachments: [] },
      location: null,
    });
    const agent = createScriptedAgent({ store: s });

    expect(agent.pendingCount()).toBe(1);
    expect(agent.runPending()).toBe(1);

    const detail = s.getThread("doc-1", thread.threadId);
    expect(detail.pongs).toHaveLength(1);
    expect(detail.pongs[0].respondThroughPingIdx).toBe(0);
    expect(isOpen(detail)).toBe(false);
  });

  it("一条 pong 累计确认同一处的多条待回复 ping", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "一", richContent: null, attachments: [] }, location: null,
    });
    s.appendPing("doc-1", thread.threadId, {
      baseVersionIdx: 0, content: { text: "二", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s });

    agent.runPending();

    const detail = s.getThread("doc-1", thread.threadId);
    expect(detail.pongs).toHaveLength(1);
    expect(detail.pongs[0].respondThroughPingIdx).toBe(1);
  });

  it("respond 返回 producesContent 时追加新版本并推进 current", () => {
    const s = store();
    s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "加一段", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s, respond: () => ({ text: "已加", producesContent: "# 一\n\n新段。\n" }) });

    agent.runPending();

    expect(s.requireDocument("doc-1").currentVersionIdx).toBe(1);
    expect(s.getVersion("doc-1", 1).authorAgentId).toBe("agent:scripted");
  });

  it("respond 不返回 producesContent 时是纯 pong，不产生新版本", () => {
    const s = store();
    s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "问一下", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s, respond: () => ({ text: "解释一下：……" }) });

    agent.runPending();

    expect(s.requireDocument("doc-1").currentVersionIdx).toBe(0);
    const detail = s.getThread("doc-1", s.listThreadIds("doc-1")[0]);
    expect(detail.pongs[0].resultLocations).toEqual([]);
  });

  it("追加新 ping 后该处重新变成待处理", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "一", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s });
    agent.runPending();
    expect(agent.pendingCount()).toBe(0);

    s.appendPing("doc-1", thread.threadId, {
      baseVersionIdx: 0, content: { text: "二", richContent: null, attachments: [] }, location: null,
    });

    expect(agent.pendingCount()).toBe(1);
  });
});
