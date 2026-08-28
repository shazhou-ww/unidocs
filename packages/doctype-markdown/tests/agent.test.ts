import { describe, expect, it, vi } from "vitest";
import type { LegacyDocumentAgentContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import { createMarkdownDocumentAgent } from "../src/index.js";
import type { MOp, MQuery } from "../src/types.js";

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

describe("Markdown document agent", () => {
  it("dispatches JSON query parameters", async () => {
    const context = agentContext();
    const agent = createMarkdownDocumentAgent(context);

    const result = await agent.toolCall("query_getSection", { heading: "Intro" });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getSection",
      payload: { heading: "Intro" },
    });
    expect(result.structuredContent).toEqual({ data: ["One", "Two"], version: 3 });
  });

  it("dispatches JSON apply parameters", async () => {
    const context = agentContext();
    const agent = createMarkdownDocumentAgent(context);

    const result = await agent.toolCall("apply_setContent", { content: "# New" });

    expect(context.apply).toHaveBeenCalledWith([
      { kind: "setContent", payload: { content: "# New" } },
    ], "Agent: apply_setContent");
    expect(result.structuredContent).toEqual({ success: true, version: 4 });
  });

  it("owns tools and instructions independently of DocumentType", () => {
    const agent = createMarkdownDocumentAgent(agentContext());
    expect(agent.tools.getContent).toBeDefined();
    expect(agent.instructions).toContain("Markdown document operator");
  });
});