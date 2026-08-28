import { describe, expect, it, vi } from "vitest";
import { decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type {
  AgentCompletion, AgentToolResult, DocumentAgent, JsonValue, LlmMessage, LlmProvider, SBlob, SValue,
} from "@unidocs/protocol";
import { toAnthropicMessages } from "@unidocs/doctype-server-common/agent";
import { createSBlob } from "@unidocs/svalue-codec/internal";
import { createOperatorDO } from "../src/operator-do.js";

type TestQuery = { kind: "read" };
type TestOperation = { kind: "insert"; payload: { blob: SBlob } };

function svalueResponse(value: SValue): Response {
  const bytes = encodeSValue(value);
  return new Response(bytes.buffer as ArrayBuffer, {
    headers: { "Content-Type": SValueContentType },
  });
}

function requestBody(init?: RequestInit): SValue {
  return decodeSValue(new Uint8Array(init?.body as ArrayBuffer));
}

function operatorState(): DurableObjectState {
  return { id: { toString: () => "operator-id" } } as unknown as DurableObjectState;
}

/** A provider that replays a canned script, one completion per turn. */
function scriptedProvider(
  turns: readonly AgentCompletion[],
  onTurn?: (messages: readonly LlmMessage[], turn: number) => void,
): LlmProvider {
  let turn = 0;
  return {
    complete: vi.fn(async ({ messages }) => {
      const completion = turns[turn];
      onTurn?.(messages, turn);
      turn++;
      if (!completion) throw new Error(`No scripted completion for turn ${turn}`);
      return completion;
    }),
  };
}

const textTurn = (text: string): AgentCompletion => ({ content: [{ type: "text", text }] });
const callTurn = (id: string, name: string, args: JsonValue): AgentCompletion => ({
  content: [],
  toolCalls: [{ id, name, arguments: args }],
});

function runRequest(instruction: string, overrides: Record<string, string> = {}): Request {
  return new Request("http://operator/_internal/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": "session-1",
      "X-Doc-Type": "test",
      "X-Tenant-Id": "tenant-1",
      "X-UniDocs-Auth-Context": "capability",
      "X-UniDocs-CAS-Capability": "delegated-token",
      ...overrides,
    },
    body: JSON.stringify({ instruction }),
  });
}

describe("agent Operator DO", () => {
  it("routes tool calls through the kernel to the editor, and reads head for baseVersion", async () => {
    const hash = "a".repeat(64);
    const applied: SValue[] = [];
    const paths: string[] = [];
    const editorFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-UniDocs-Auth-Context")).toBe("capability");
      expect(headers.get("X-UniDocs-CAS-Capability")).toBe("delegated-token");
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/_internal/status") {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        // Deliberately different from the version the query returned: apply
        // must use the head it read here, not a version the loop remembered.
        return Response.json({ exists: true, version: 9 });
      }
      if (path === "/_internal/query") {
        expect(requestBody(init)).toEqual({ kind: "read" });
        return svalueResponse({ success: true, data: "current", version: 7 });
      }
      if (path === "/_internal/apply") {
        applied.push(requestBody(init));
        return Response.json({ success: true, version: 10 });
      }
      throw new Error(`Unexpected Editor path ${path}`);
    });

    const agent: DocumentAgent<TestQuery, TestOperation> = {
      instructions: "test agent",
      tools: [
        {
          kind: "query",
          name: "read",
          description: "read",
          inputSchema: {},
          toQuery: () => ({ kind: "read" }),
        },
        {
          kind: "op",
          name: "insert",
          description: "insert",
          inputSchema: {},
          toOps: args => [{
            kind: "insert",
            payload: { blob: createSBlob(String(args.hash)) },
          }],
        },
      ],
    };

    const messagesSeen: LlmMessage[][] = [];
    const provider = scriptedProvider(
      [callTurn("read-call", "read", {}), callTurn("insert-call", "insert", { hash }), textTurn("done")],
      messages => messagesSeen.push([...messages]),
    );

    const Operator = createOperatorDO({
      agent,
      provider: () => provider,
      getEditorStub: (_env, editorObjectName) => {
        expect(editorObjectName).toBe("v1:8:tenant-1:9:session-1");
        return { fetch: editorFetch } as unknown as DurableObjectStub;
      },
    });
    const operator = new Operator(operatorState(), {});

    const response = await operator.fetch(runRequest("read then insert"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { response: "done", iterations: 3 },
    });

    // The query tool's toQuery reached the editor verbatim (asserted above),
    // and the op tool's toOps reached it as a canonical operation batch.
    expect(paths).toEqual(["/_internal/query", "/_internal/status", "/_internal/apply"]);
    const apply = applied[0] as {
      operations: [{ kind: string; payload: { blob: SBlob } }];
      description: string;
      baseVersion: number;
    };
    expect(apply.baseVersion).toBe(9);
    expect(apply.description).toBe("Agent: insert");
    expect(apply.operations[0].kind).toBe("insert");
    expect(isSBlob(apply.operations[0].payload.blob)).toBe(true);
    expect(apply.operations[0].payload.blob.hash).toBe(hash);

    // The tool results came back to the model as tool messages.
    expect(messagesSeen[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        callId: "read-call",
        structuredContent: { data: "current", version: 7 },
      }),
      expect.objectContaining({
        role: "tool",
        callId: "insert-call",
        structuredContent: { success: true, version: 10 },
      }),
    ]));
  });

  it("carries an image content part all the way to the provider adapter", async () => {
    const hash = "b".repeat(64);
    const blob = createSBlob(hash);
    const bytes = new Uint8Array([1, 2, 3]);
    const editorFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/_internal/query") {
        return svalueResponse({ success: true, data: { blob }, version: 2 });
      }
      if (path === "/_internal/read_blob") {
        return new Response(bytes.buffer as ArrayBuffer, { headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected Editor path ${path}`);
    });

    const agent: DocumentAgent<TestQuery, TestOperation> = {
      instructions: "multimodal agent",
      tools: [{
        kind: "query",
        name: "image",
        description: "image",
        inputSchema: {},
        toQuery: () => ({ kind: "read" }),
        toResult: (data): AgentToolResult => {
          const record = data as { readonly blob: SValue };
          if (!isSBlob(record.blob)) throw new Error("query result has no blob");
          return {
            structuredContent: { altText: "dot" },
            content: [{ type: "image", blob: record.blob, mediaType: "image/png", altText: "dot" }],
          };
        },
      }],
    };

    let adapterOutput: ReturnType<typeof toAnthropicMessages> | undefined;
    const provider = scriptedProvider(
      [callTurn("image-call", "image", {}), textTurn("seen")],
      (messages, turn) => {
        if (turn !== 1) return;
        // The kernel materialized the SBlob into bytes; no render hook exists.
        expect(messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            callId: "image-call",
            content: [{ type: "image", data: bytes, mediaType: "image/png", altText: "dot" }],
          }),
        ]));
        // …and the adapter layer turns it into an image block without throwing.
        adapterOutput = toAnthropicMessages(messages);
      },
    );

    const Operator = createOperatorDO({
      agent,
      provider: () => provider,
      getEditorStub: () => ({ fetch: editorFetch }) as unknown as DurableObjectStub,
    });
    const operator = new Operator(operatorState(), {});

    const response = await operator.fetch(runRequest("show image", {
      "X-UniDocs-Auth-Context": "legacy",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { response: "seen", iterations: 2 },
    });
    const toolResult = adapterOutput
      ?.flatMap(message => message.content)
      .find(block => block.type === "tool_result");
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("unreachable");
    expect(toolResult.tool_use_id).toBe("image-call");
    const image = toolResult.content.find(part => part.type === "image");
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: btoa(String.fromCharCode(...bytes)) },
    });
  });

  // A blob the editor says is gone may degrade into a line of text. An
  // authorization failure may not — dressing one up as "the picture is gone"
  // is exactly the bug commit 63f997b fixed.
  it.each([
    { status: 404, degrades: true },
    { status: 401, degrades: false },
    { status: 403, degrades: false },
    { status: 500, degrades: false },
  ])("classifies a $status from read_blob (degrades: $degrades)", async ({ status, degrades }) => {
    const blob = createSBlob("c".repeat(64));
    const editorFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/_internal/query") {
        return svalueResponse({ success: true, data: { blob }, version: 2 });
      }
      if (path === "/_internal/read_blob") {
        return new Response("nope", { status });
      }
      throw new Error(`Unexpected Editor path ${path}`);
    });

    const agent: DocumentAgent<TestQuery, TestOperation> = {
      instructions: "multimodal agent",
      tools: [{
        kind: "query",
        name: "image",
        description: "image",
        inputSchema: {},
        toQuery: () => ({ kind: "read" }),
        toResult: (data): AgentToolResult => {
          const record = data as { readonly blob: SValue };
          if (!isSBlob(record.blob)) throw new Error("query result has no blob");
          return {
            content: [{ type: "image", blob: record.blob, mediaType: "image/png", altText: "dot" }],
          };
        },
      }],
    };

    let secondTurn: readonly LlmMessage[] | undefined;
    const provider = scriptedProvider(
      [callTurn("image-call", "image", {}), textTurn("seen")],
      (messages, turn) => {
        if (turn === 1) secondTurn = messages;
      },
    );
    const Operator = createOperatorDO({
      agent,
      provider: () => provider,
      getEditorStub: () => ({ fetch: editorFetch }) as unknown as DurableObjectStub,
    });
    const operator = new Operator(operatorState(), {});

    const response = await operator.fetch(runRequest("show image"));

    if (!degrades) {
      // The run ends; nothing silently reaches the model in place of the image.
      expect(response.status).toBe(500);
      expect(secondTurn).toBeUndefined();
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining(`Editor read blob failed ${status}`),
      });
      return;
    }
    expect(response.status).toBe(200);
    expect(secondTurn).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        callId: "image-call",
        content: [{ type: "text", text: "[image: dot]" }],
      }),
    ]));
  });

  it("clears the conversation history on /_internal/reset", async () => {
    const editorFetch = vi.fn(async () => {
      throw new Error("the editor is not involved in this test");
    });
    const agent: DocumentAgent<TestQuery, TestOperation> = {
      instructions: "test agent",
      tools: [],
    };
    const messageCounts: number[] = [];
    const provider = scriptedProvider(
      [textTurn("first"), textTurn("second")],
      messages => messageCounts.push(messages.length),
    );
    const Operator = createOperatorDO({
      agent,
      provider: () => provider,
      getEditorStub: () => ({ fetch: editorFetch }) as unknown as DurableObjectStub,
    });
    const operator = new Operator(operatorState(), {});

    await operator.fetch(runRequest("first instruction"));

    const reset = await operator.fetch(new Request("http://operator/_internal/reset", {
      method: "POST",
      headers: { "X-Session-Id": "session-1", "X-Tenant-Id": "tenant-1" },
    }));
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toEqual({ success: true });

    await operator.fetch(runRequest("second instruction"));

    // Without the reset the second run would have started from 3 messages
    // (user, assistant, user); the history was emptied, so it starts from 1.
    expect(messageCounts).toEqual([1, 1]);
  });

  it("rejects a request whose identity does not match the one it captured", async () => {
    const agent: DocumentAgent<TestQuery, TestOperation> = {
      instructions: "test agent",
      tools: [],
    };
    const provider = scriptedProvider([textTurn("ok")]);
    const Operator = createOperatorDO({
      agent,
      provider: () => provider,
      getEditorStub: () => ({ fetch: vi.fn() }) as unknown as DurableObjectStub,
    });
    const operator = new Operator(operatorState(), {});

    expect((await operator.fetch(runRequest("first"))).status).toBe(200);

    const mismatched = await operator.fetch(runRequest("wrong document", {
      "X-Session-Id": "another-session",
    }));
    expect(mismatched.status).toBe(403);
    await expect(mismatched.json()).resolves.toEqual({ error: "Operator session mismatch" });

    const anonymous = await operator.fetch(new Request("http://operator/_internal/run", {
      method: "POST",
      body: JSON.stringify({ instruction: "no identity" }),
    }));
    expect(anonymous.status).toBe(401);
  });
});
