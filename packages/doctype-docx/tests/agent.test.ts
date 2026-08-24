import { describe, expect, it, vi } from "vitest";
import type { DocumentAgentContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/doctype-server-common/internal";
import { createDocxDocumentAgent } from "../src/index.js";
import type { DocxOperation, DocxQuery } from "../src/types.js";

function agentContext(overrides: Partial<DocumentAgentContext<DocxQuery, DocxOperation>> = {}) {
  return {
    query: vi.fn(async () => ({ data: "text", version: 4 })),
    apply: vi.fn(async () => ({ version: 5 })),
    resolveBlob: vi.fn(async (hash: string) => createSBlob(hash)),
    readBlob: vi.fn(async () => ({
      data: new Uint8Array(),
      contentType: "application/octet-stream",
    })),
    ...overrides,
  } satisfies DocumentAgentContext<DocxQuery, DocxOperation>;
}

describe("DOCX document agent", () => {
  it("exposes static tool metadata and instructions", () => {
    const agent = createDocxDocumentAgent(agentContext());
    expect(agent.tools.getText).toBeDefined();
    expect(agent.tools.insertImage).toBeDefined();
    expect(agent.instructions.length).toBeGreaterThan(100);
  });

  it("turns a JSON image hash into an SBlob operation", async () => {
    const context = agentContext();
    const agent = createDocxDocumentAgent(context);
    const hash = "a".repeat(64);

    const result = await agent.toolCall("apply_insertImage", {
      hash,
      widthPx: 16,
      altText: "dot",
    });

    expect(context.resolveBlob).toHaveBeenCalledWith(hash);
    expect(context.apply).toHaveBeenCalledWith([
      {
        kind: "insertImage",
        payload: {
          blob: expect.objectContaining({ hash }),
          widthPx: 16,
          altText: "dot",
        },
      },
    ], "Agent: apply_insertImage");
    expect(result.structuredContent).toEqual({ success: true, version: 5 });
  });

  it("returns query data as JSON structured content", async () => {
    const context = agentContext();
    const agent = createDocxDocumentAgent(context);

    const result = await agent.toolCall("query_getParagraph", { index: 2 });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getParagraph",
      payload: { index: 2 },
    });
    expect(result.structuredContent).toEqual({ data: "text", version: 4 });
  });

  it("returns image metadata as JSON and image bytes as SBlob content", async () => {
    const blob = createSBlob("b".repeat(64));
    const context = agentContext({
      query: vi.fn(async () => ({
        data: {
          index: 0,
          partName: "/word/media/image1.png",
          format: "png",
          altText: "dot",
          blob,
        },
        version: 6,
      })),
    });
    const agent = createDocxDocumentAgent(context);

    const result = await agent.toolCall("query_getImage", { index: 0 });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getImageContent",
      payload: { index: 0 },
    });
    expect(result.structuredContent).toEqual({
      data: {
        index: 0,
        partName: "/word/media/image1.png",
        format: "png",
        altText: "dot",
      },
      version: 6,
    });
    expect(result.content).toEqual([{
      type: "image",
      blob,
      mediaType: "image/png",
      altText: "dot",
    }]);
  });

  it("rejects unknown tools and non-object parameters", async () => {
    const agent = createDocxDocumentAgent(agentContext());
    await expect(agent.toolCall("apply_unknown", {})).rejects.toThrow(/Unknown/);
    await expect(agent.toolCall("query_getText", "bad")).rejects.toThrow(/JSON object/);
  });
});