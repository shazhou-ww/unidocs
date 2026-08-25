import { describe, expect, it, vi } from "vitest";
import { decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { DocumentAgentFactory, JsonValue, SBlob, SValue } from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import {
  createOperatorDO,
  renderDefaultAgentToolResult,
} from "../src/operator-do.js";

type TestQuery = { kind: "read" };
type TestOperation = { kind: "insert"; payload: { blob: SBlob } };

function svalueResponse(value: SValue): Response {
  const bytes = encodeSValue(value);
  return new Response(bytes.buffer, {
    headers: { "Content-Type": SValueContentType },
  });
}

function requestBody(init?: RequestInit): SValue {
  return decodeSValue(new Uint8Array(init?.body as ArrayBuffer));
}

function operatorState(): DurableObjectState {
  return { id: { toString: () => "operator-id" } } as unknown as DurableObjectState;
}

describe("agent Operator DO", () => {
  it("dispatches JSON tool calls through the agent and sends canonical operations", async () => {
    const hash = "a".repeat(64);
    const applied: SValue[] = [];
    const editorFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/_internal/query") {
        expect(requestBody(init)).toEqual({ kind: "read" });
        return svalueResponse({ success: true, data: "current", version: 7 });
      }
      if (path === "/_internal/resolve_blob") {
        expect(requestBody(init)).toEqual({ hash });
        return svalueResponse({ blob: createSBlob(hash) });
      }
      if (path === "/_internal/apply") {
        const request = requestBody(init);
        applied.push(request);
        return Response.json({ success: true, version: 8 });
      }
      throw new Error(`Unexpected Editor path ${path}`);
    });
    const agentFactory: DocumentAgentFactory<TestQuery, TestOperation> = context => ({
      tools: {
        read: { name: "read", description: "read", inputSchema: {} },
        insert: { name: "insert", description: "insert", inputSchema: {} },
      },
      instructions: "test agent",
      async toolCall(name, parameters) {
        if (name === "read") {
          const result = await context.query({ kind: "read" });
          return { structuredContent: { data: result.data as JsonValue, version: result.version } };
        }
        const args = parameters as { readonly hash: JsonValue };
        const blob = await context.resolveBlob(String(args.hash));
        const result = await context.apply([
          { kind: "insert", payload: { blob } },
        ], "insert blob");
        return { structuredContent: { success: true, version: result.version } };
      },
    });
    let iteration = 0;
    const messagesSeen: unknown[][] = [];
    const llmProvider = vi.fn(async (messages: unknown[]) => {
      messagesSeen.push(structuredClone(messages));
      iteration++;
      if (iteration === 1) {
        return toolResponse("read-call", "read", {});
      }
      if (iteration === 2) {
        return toolResponse("insert-call", "insert", { hash });
      }
      return { choices: [{ message: { role: "assistant", content: "done" } }] };
    });
    const Operator = createOperatorDO({
      agentFactory,
      llmProvider,
      getEditorStub: (_env, sessionId) => {
        expect(sessionId).toBe("session-1");
        return { fetch: editorFetch } as unknown as DurableObjectStub;
      },
    });
    const operator = new Operator(operatorState(), {});

    const response = await operator.fetch(new Request("http://operator/_internal/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "session-1",
        "X-Doc-Type": "test",
        "X-Tenant-Id": "tenant-1",
      },
      body: JSON.stringify({ instruction: "read then insert" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { response: "done", iterations: 3 },
    });
    const apply = applied[0] as any;
    expect(apply.baseVersion).toBe(7);
    expect(isSBlob(apply.operations[0].payload.blob)).toBe(true);
    expect(apply.operations[0].payload.blob.hash).toBe(hash);
    expect(messagesSeen[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "insert-call",
        content: JSON.stringify({ success: true, version: 8 }),
      }),
    ]));

    const mismatched = await operator.fetch(new Request("http://operator/_internal/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "another-session",
        "X-Tenant-Id": "tenant-1",
      },
      body: JSON.stringify({ instruction: "wrong document" }),
    }));
    expect(mismatched.status).toBe(403);
  });

  it("lets a provider renderer materialize multimodal SBlob results", async () => {
    const hash = "b".repeat(64);
    const blob = createSBlob(hash);
    const bytes = new Uint8Array([1, 2, 3]);
    const editorFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/_internal/read_blob") {
        return new Response(bytes, { headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected Editor path ${path}`);
    });
    const agentFactory: DocumentAgentFactory<TestQuery, TestOperation> = () => ({
      tools: { image: { name: "image", description: "image", inputSchema: {} } },
      instructions: "multimodal agent",
      async toolCall() {
        return {
          structuredContent: { altText: "dot" },
          content: [{ type: "image", blob, mediaType: "image/png", altText: "dot" }],
        };
      },
    });
    let iteration = 0;
    const llmProvider = vi.fn(async (messages: unknown[]) => {
      iteration++;
      if (iteration === 1) return toolResponse("image-call", "image", {});
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: [{ type: "input_image", bytes: [1, 2, 3], mediaType: "image/png" }],
        }),
      ]));
      return { choices: [{ message: { role: "assistant", content: "seen" } }] };
    });
    const renderToolResult = vi.fn(async (result, context) => {
      const image = result.content?.find(part => part.type === "image");
      if (!image || image.type !== "image") throw new Error("missing image");
      const stored = await context.readBlob(image.blob);
      expect(stored.contentType).toBe(image.mediaType);
      return [{
        type: "input_image",
        bytes: Array.from(stored.data),
        mediaType: stored.contentType,
      }];
    });
    const Operator = createOperatorDO({
      agentFactory,
      llmProvider,
      renderToolResult,
      getEditorStub: () => ({ fetch: editorFetch }) as unknown as DurableObjectStub,
    });
    const operator = new Operator(operatorState(), {});

    const response = await operator.fetch(new Request("http://operator/_internal/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "session-2",
        "X-Tenant-Id": "tenant-1",
      },
      body: JSON.stringify({ instruction: "show image" }),
    }));

    expect(response.status).toBe(200);
    expect(renderToolResult).toHaveBeenCalledOnce();
    expect(editorFetch).toHaveBeenCalledOnce();
  });

  it("requires a provider renderer for non-text content", () => {
    expect(() => renderDefaultAgentToolResult({
      content: [{
        type: "image",
        blob: createSBlob("c".repeat(64)),
        mediaType: "image/png",
      }],
    })).toThrow(/provider-specific renderer/);
    expect(renderDefaultAgentToolResult({ structuredContent: { ok: true } }))
      .toBe('{"ok":true}');
    expect(() => renderDefaultAgentToolResult({
      structuredContent: { bad: undefined } as never,
    })).toThrow(/Invalid JSON agent value/);
  });
});

function toolResponse(id: string, name: string, parameters: JsonValue) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          function: {
            name,
            arguments: JSON.stringify(parameters),
          },
        }],
      },
    }],
  };
}