import { describe, expect, it, vi } from "vitest";
import type { DocumentAgentContext } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import { createPsdDocumentAgent } from "../src/index.js";
import type { PsdOp, PsdQuery } from "../src/index.js";

const PREVIEW = {
  $image: { base64: "aGVsbG8=", mediaType: "image/png" },
  width: 4,
  height: 2,
  region: [0, 0, 2, 4],
};

function agentContext(
  data: unknown = [{ id: "L1", type: "raster" }],
): DocumentAgentContext<PsdQuery, PsdOp> {
  return {
    query: vi.fn(async () => ({ data: data as never, version: 7 })),
    apply: vi.fn(async () => ({ version: 8 })),
    resolveBlob: vi.fn(async (hash: string) => createSBlob(hash)),
    readBlob: vi.fn(async () => ({
      data: new Uint8Array(),
      contentType: "application/octet-stream",
    })),
  };
}

describe("PSD document agent", () => {
  it("exposes the doctype's own tools and instructions", () => {
    const agent = createPsdDocumentAgent(agentContext());
    expect(agent.tools.getLayers.name).toBe("query_getLayers");
    expect(agent.tools.add_layer.name).toBe("apply_add_layer");
    expect(agent.instructions).toContain("PSD image editor operator");
  });

  it("dispatches an argument-less query without a payload", async () => {
    const context = agentContext();
    const agent = createPsdDocumentAgent(context);

    const result = await agent.toolCall("query_getLayers", {});

    expect(context.query).toHaveBeenCalledWith({ kind: "getLayers" });
    expect(result.structuredContent).toEqual({
      data: [{ id: "L1", type: "raster" }],
      version: 7,
    });
  });

  it("dispatches query arguments as the query payload", async () => {
    const context = agentContext();
    const agent = createPsdDocumentAgent(context);

    await agent.toolCall("query_getDoc", { layerId: "L1" });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getDoc",
      payload: { layerId: "L1" },
    });
  });

  it("passes a getPreview $image through as structured content", async () => {
    // The Anthropic provider (cloudflare-psd/src/anthropic.ts) looks for
    // `$image` under `data` in the stringified tool result and re-emits it as
    // a Claude image block, so the agent must not strip or rewrap it.
    const context = agentContext(PREVIEW);
    const agent = createPsdDocumentAgent(context);

    const result = await agent.toolCall("query_getPreview", { maxSize: 512 });

    expect(context.query).toHaveBeenCalledWith({
      kind: "getPreview",
      payload: { maxSize: 512 },
    });
    expect(result.structuredContent).toEqual({ data: PREVIEW, version: 7 });
    // No multimodal content part: the default renderer would throw on one.
    expect(result.content).toBeUndefined();
  });

  it("dispatches apply tools as a single named operation", async () => {
    const context = agentContext();
    const agent = createPsdDocumentAgent(context);

    const result = await agent.toolCall("apply_set_props", {
      layerId: "L1",
      props: { opacity: 0.5 },
    });

    expect(context.apply).toHaveBeenCalledWith(
      [{ kind: "set_props", payload: { layerId: "L1", props: { opacity: 0.5 } } }],
      "Agent: apply_set_props",
    );
    expect(result.structuredContent).toEqual({ success: true, version: 8 });
  });

  it("rejects an unknown tool name", async () => {
    const agent = createPsdDocumentAgent(agentContext());
    await expect(agent.toolCall("query_nope", {})).rejects.toThrow(/Unknown PSD agent tool/);
  });

  it("rejects parameters that are not a JSON object", async () => {
    const context = agentContext();
    const agent = createPsdDocumentAgent(context);

    await expect(agent.toolCall("query_getDoc", [1, 2] as never))
      .rejects.toThrow(/must be a JSON object/);
    await expect(agent.toolCall("apply_remove_layer", null))
      .rejects.toThrow(/must be a JSON object/);
    expect(context.query).not.toHaveBeenCalled();
    expect(context.apply).not.toHaveBeenCalled();
  });
});
