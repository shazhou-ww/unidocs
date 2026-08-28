import { describe, expect, it, vi } from "vitest";
import type { LegacyDocumentAgentContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import {
  ByteLru, materializeMessages, toAnthropicMessages, toolResultToMessage,
} from "@unidocs/doctype-server-common/agent";
import { createDocxDocumentAgent, docxAgent } from "../src/index.js";
import type { DocxOperation, DocxQuery } from "../src/types.js";

const tool = (name: string) => {
  const t = docxAgent.tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

function agentContext(overrides: Partial<LegacyDocumentAgentContext<DocxQuery, DocxOperation>> = {}) {
  return {
    query: vi.fn(async () => ({ data: "text", version: 4 })),
    apply: vi.fn(async () => ({ version: 5 })),
    resolveBlob: vi.fn(async (hash: string) => createSBlob(hash)),
    readBlob: vi.fn(async () => ({
      data: new Uint8Array(),
      contentType: "application/octet-stream",
    })),
    ...overrides,
  } satisfies LegacyDocumentAgentContext<DocxQuery, DocxOperation>;
}

describe("DOCX 工具表", () => {
  it("工具名不带 query_ / apply_ 前缀", () => {
    for (const t of docxAgent.tools) {
      expect(t.name).not.toMatch(/^(query|apply)_/);
    }
  });

  it("提示词里提到的每个工具名都真的存在", () => {
    const names = new Set(docxAgent.tools.map(t => t.name));
    for (const n of [
      "getText", "getParagraphs", "getParagraph", "getParagraphFormat", "getRunFormat",
      "getParagraphList", "getTables", "getTable", "getHeaders", "getFooters",
      "getImages", "getImage", "getImageByPartName",
      "appendParagraph", "setRunText", "addTable", "setCellText", "addTableRow",
      "addBulletList", "addNumberedList", "setHeader", "setFooter",
      "insertImage", "deleteImage", "replaceImage", "setImageSize", "setImageAltText",
    ]) {
      expect(names, `提示词让模型调 ${n}`).toContain(n);
    }
  });

  it("getText 无参数时不带 payload —— {} 不能掩盖默认值", () => {
    const t = tool("getText");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({})).toEqual({ kind: "getText" });
  });

  it("getParagraph 有参数时透传成 payload", () => {
    const t = tool("getParagraph");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ index: 2 })).toEqual({ kind: "getParagraph", payload: { index: 2 } });
  });

  it("getImage 的 toQuery 映射到 getImageContent（携带 blob 的那个查询），不是 getImage", () => {
    const t = tool("getImage");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ index: 0 })).toEqual({ kind: "getImageContent", payload: { index: 0 } });
  });

  it("appendParagraph 产出一个 op，参数原样透传", () => {
    const t = tool("appendParagraph");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ text: "hi" })).toEqual([{ kind: "appendParagraph", payload: { text: "hi" } }]);
  });

  it("insertImage 的 toOps 同步把 hash 变成 SBlob（不再是 await resolveBlob）", () => {
    const t = tool("insertImage");
    if (t.kind !== "op") throw new Error("kind");
    const hash = "a".repeat(64);
    const ops = t.toOps({ hash, widthPx: 16, altText: "dot" });
    expect(ops).toEqual([{
      kind: "insertImage",
      payload: { blob: createSBlob(hash), widthPx: 16, altText: "dot" },
    }]);
  });

  it("replaceImage 的 toOps 同步把 hash 变成 SBlob", () => {
    const t = tool("replaceImage");
    if (t.kind !== "op") throw new Error("kind");
    const hash = "b".repeat(64);
    const ops = t.toOps({ index: 3, hash });
    expect(ops).toEqual([{
      kind: "replaceImage",
      payload: { index: 3, blob: createSBlob(hash) },
    }]);
  });

  it("toQuery / toOps 是纯函数：同参调两次结果深相等（spec V7）", () => {
    for (const t of docxAgent.tools) {
      const args = t.name === "insertImage" || t.name === "replaceImage"
        ? { index: 0, hash: "c".repeat(64) }
        : { index: 0, paragraphIndex: 0, runIndex: 0, tableIndex: 0, row: 0, col: 0, text: "x", partName: "/word/media/image1.png", items: ["x"] };
      const once = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      const twice = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      expect(twice).toEqual(once);
    }
  });

  it("getImage 返回 image content part，元数据不含 blob", () => {
    const t = tool("getImage");
    if (t.kind !== "query" || !t.toResult) throw new Error("getImage 必须有 toResult");
    const blob = createSBlob("d".repeat(64));
    const result = t.toResult({
      index: 0, partName: "/word/media/image1.png", format: "png", altText: "dot", blob,
    } as never, 6);
    expect(result.content).toEqual([{ type: "image", blob, mediaType: "image/png", altText: "dot" }]);
    expect(result.structuredContent).toEqual({
      data: { index: 0, partName: "/word/media/image1.png", format: "png", altText: "dot" },
      version: 6,
    });
  });

  it("getImage 的结果里没有 blob 时抛错，不吞", () => {
    const t = tool("getImage");
    if (t.kind !== "query" || !t.toResult) throw new Error("kind");
    expect(() => t.toResult!({ index: 0, format: "png" } as never, 1)).toThrow(/SBlob/);
  });

  it("getImage 遇到不支持的格式时抛错", () => {
    const t = tool("getImage");
    if (t.kind !== "query" || !t.toResult) throw new Error("kind");
    const blob = createSBlob("e".repeat(64));
    expect(() => t.toResult!({ index: 0, format: "bmp", blob } as never, 1)).toThrow(/Unsupported/);
  });
});

describe("getImage 的 toResult 能被内核翻成 Anthropic 图片块而不抛异常（P6 / spec V11）", () => {
  it("query 结果 → AgentToolResult → AgentMessage → LlmMessage → Anthropic 图片块", async () => {
    const t = tool("getImage");
    if (t.kind !== "query" || !t.toResult) throw new Error("getImage 必须有 toResult");
    const pngBytes = new Uint8Array([1, 2, 3, 4]);
    const blob = createSBlob("f".repeat(64));

    // 1. 工具产出 AgentToolResult（这是本任务新写的 toResult）。
    const toolResult = t.toResult(
      { index: 0, partName: "/word/media/image1.png", format: "png", altText: "a photo", blob } as never,
      1,
    );

    // 2. 内核把它落成历史里的 AgentMessage（tool-result.ts，无损结构转换）。
    const message = toolResultToMessage("call-1", toolResult);
    expect(message.role).toBe("tool");
    expect(message.content).toEqual([{ type: "image", blob, mediaType: "image/png", altText: "a photo" }]);

    // 3. 即将发给 provider 前，内核把 SBlob 物化成字节（messages.ts）。
    const readBlob = vi.fn(async () => ({ data: pngBytes, contentType: "image/png" }));
    const materialized = await materializeMessages([message], readBlob, new ByteLru(1024 * 1024));
    expect(readBlob).toHaveBeenCalledWith(blob);

    // 4. Anthropic 适配层翻译成图片块 —— 这条路此前从未真正跑通过（P6）：
    //    旧 createDocxDocumentAgent 从没配过 toResult，getImage 的结果只会
    //    撞上 renderDefaultAgentToolResult 的 "Multimodal tool result
    //    requires a provider-specific renderer" 抛异常分支。
    let anthropicMessages: ReturnType<typeof toAnthropicMessages> | undefined;
    expect(() => {
      anthropicMessages = toAnthropicMessages(materialized);
    }).not.toThrow();

    const toolResultBlock = anthropicMessages![0]!.content[0];
    expect(toolResultBlock.type).toBe("tool_result");
    if (toolResultBlock.type !== "tool_result") throw new Error("unreachable");
    const imageBlock = toolResultBlock.content.find(b => b.type === "image");
    expect(imageBlock).toBeDefined();
    if (!imageBlock || imageBlock.type !== "image") throw new Error("unreachable");
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe(btoa(String.fromCharCode(...pngBytes)));
  });
});

describe("createDocxDocumentAgent（临时适配器，Task 9 删）", () => {
  it("exposes static tool metadata and instructions", () => {
    const agent = createDocxDocumentAgent(agentContext());
    expect(agent.tools.getText).toBeDefined();
    expect(agent.tools.insertImage).toBeDefined();
    expect(agent.instructions.length).toBeGreaterThan(100);
  });

  it("turns a JSON image hash into an SBlob operation synchronously (no resolveBlob round trip)", async () => {
    const context = agentContext();
    const agent = createDocxDocumentAgent(context);
    const hash = "a".repeat(64);

    const result = await agent.toolCall("insertImage", {
      hash,
      widthPx: 16,
      altText: "dot",
    });

    expect(context.resolveBlob).not.toHaveBeenCalled();
    expect(context.apply).toHaveBeenCalledWith([
      {
        kind: "insertImage",
        payload: {
          blob: createSBlob(hash),
          widthPx: 16,
          altText: "dot",
        },
      },
    ], "Agent: insertImage");
    expect(result.structuredContent).toEqual({ success: true, version: 5 });
  });

  it("returns query data as JSON structured content", async () => {
    const context = agentContext();
    const agent = createDocxDocumentAgent(context);

    const result = await agent.toolCall("getParagraph", { index: 2 });

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

    const result = await agent.toolCall("getImage", { index: 0 });

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
    await expect(agent.toolCall("unknown", {})).rejects.toThrow(/Unknown/);
    await expect(agent.toolCall("getText", "bad")).rejects.toThrow(/JSON object/);
  });
});
