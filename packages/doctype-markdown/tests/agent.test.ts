import { describe, expect, it, vi } from "vitest";
import type { LegacyDocumentAgentContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import { createMarkdownDocumentAgent, markdownAgent } from "../src/index.js";
import type { MOp, MQuery } from "../src/types.js";

const tool = (name: string) => {
  const t = markdownAgent.tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

function agentContext(): LegacyDocumentAgentContext<MQuery, MOp> {
  return {
    query: vi.fn(async () => ({ data: ["One", "Two"], version: 3 })),
    apply: vi.fn(async () => ({ version: 4 })),
    resolveBlob: vi.fn(async (hash: string) => createSBlob(hash)),
    readBlob: vi.fn(async () => ({
      data: new Uint8Array(),
      contentType: "application/octet-stream",
    })),
  };
}

describe("Markdown 工具表", () => {
  it("工具名不带 query_ / apply_ 前缀", () => {
    for (const t of markdownAgent.tools) {
      expect(t.name).not.toMatch(/^(query|apply)_/);
    }
  });

  it("提示词里提到的每个工具名都真的存在", () => {
    const names = new Set(markdownAgent.tools.map(t => t.name));
    for (const n of ["getContent", "getHeadings", "getSection", "appendSection", "replaceSection", "deleteSection"]) {
      expect(names, `提示词让模型调 ${n}`).toContain(n);
    }
  });

  it("getContent 无参数时不带 payload —— {} 不能掩盖默认值", () => {
    const t = tool("getContent");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({})).toEqual({ kind: "getContent" });
  });

  it("getSection 有参数时透传成 payload", () => {
    const t = tool("getSection");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ heading: "Intro" })).toEqual({ kind: "getSection", payload: { heading: "Intro" } });
  });

  it("setContent 产出一个 op，参数原样透传", () => {
    const t = tool("setContent");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ content: "# New" })).toEqual([{ kind: "setContent", payload: { content: "# New" } }]);
  });

  it("appendSection 产出一个 op，参数原样透传", () => {
    const t = tool("appendSection");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ heading: "H", content: "body" }))
      .toEqual([{ kind: "appendSection", payload: { heading: "H", content: "body" } }]);
  });

  it("toQuery / toOps 是纯函数：同参调两次结果深相等（spec V7）", () => {
    for (const t of markdownAgent.tools) {
      const args = { heading: "Intro", content: "body" };
      const once = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      const twice = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      expect(twice).toEqual(once);
    }
  });
});

describe("createMarkdownDocumentAgent（临时适配器，Task 9 删）", () => {
  it("dispatches query tool calls to context.query", async () => {
    const context = agentContext();
    const agent = createMarkdownDocumentAgent(context);

    const result = await agent.toolCall("getSection", { heading: "Intro" });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getSection",
      payload: { heading: "Intro" },
    });
    expect(result.structuredContent).toEqual({ data: ["One", "Two"], version: 3 });
  });

  it("dispatches op tool calls to context.apply", async () => {
    const context = agentContext();
    const agent = createMarkdownDocumentAgent(context);

    const result = await agent.toolCall("setContent", { content: "# New" });

    expect(context.apply).toHaveBeenCalledWith([
      { kind: "setContent", payload: { content: "# New" } },
    ], "Agent: setContent");
    expect(result.structuredContent).toEqual({ success: true, version: 4 });
  });

  it("owns tools and instructions independently of DocumentType", () => {
    const agent = createMarkdownDocumentAgent(agentContext());
    expect(agent.tools.getContent).toBeDefined();
    expect(agent.instructions).toContain("Markdown document operator");
  });

  it("rejects unknown tools and non-object parameters", async () => {
    const agent = createMarkdownDocumentAgent(agentContext());
    await expect(agent.toolCall("unknown", {})).rejects.toThrow(/Unknown/);
    await expect(agent.toolCall("getContent", "bad")).rejects.toThrow(/JSON object/);
  });
});
