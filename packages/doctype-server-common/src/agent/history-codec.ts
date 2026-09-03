/**
 * 对话历史与 JSON 之间的编解码。
 *
 * 存在的理由只有一条:`AgentMessage` 的 image / file part 带 `SBlob` ——
 * 一个**品牌对象**,`JSON.parse(JSON.stringify(x))` 拿回来的 `{hash}` 不是它,
 * 后续任何 `isSBlob` 校验都会失败。所以编码写 hash、解码用 `createSBlob()`
 * 重建。
 *
 * 只存引用不存字节:字节在 CAS 里,`AgentMessage` 的文档注释
 * (`protocol/src/types.ts:315`)写着"附件是 SBlob 引用,不是字节"。存字节会让
 * 一份长对话把 jsonb 撑爆。
 */
import { createSBlob } from "@unidocs/svalue-codec";
import type {
  AgentContentPart,
  AgentMessage,
  AgentToolCall,
  JsonValue,
} from "@unidocs/protocol";

function fail(what: string, got: unknown): never {
  throw new Error(`history-codec: ${what} — got ${JSON.stringify(got)?.slice(0, 120)}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function encodePart(part: AgentContentPart): JsonValue {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    return {
      type: "image",
      hash: part.blob.hash,
      mediaType: part.mediaType,
      ...(part.altText === undefined ? {} : { altText: part.altText }),
    };
  }
  return {
    type: "file",
    hash: part.blob.hash,
    mediaType: part.mediaType,
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  };
}

function decodePart(raw: unknown): AgentContentPart {
  if (!isRecord(raw)) fail("content part is not an object", raw);
  if (raw.type === "text") {
    if (typeof raw.text !== "string") fail("text part has no text", raw);
    return { type: "text", text: raw.text };
  }
  if (raw.type === "image" || raw.type === "file") {
    if (typeof raw.hash !== "string") fail(`${raw.type} part has no hash`, raw);
    if (typeof raw.mediaType !== "string") fail(`${raw.type} part has no mediaType`, raw);
    const blob = createSBlob(raw.hash);
    if (raw.type === "image") {
      return {
        type: "image", blob, mediaType: raw.mediaType,
        ...(raw.altText === undefined ? {} : { altText: String(raw.altText) }),
      };
    }
    return {
      type: "file", blob, mediaType: raw.mediaType,
      ...(raw.filename === undefined ? {} : { filename: String(raw.filename) }),
    };
  }
  // 静默丢弃会让模型在后续轮次里引用一张它其实没看到的图。
  fail("unknown content part type", raw);
}

function decodeToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) fail("toolCalls is not an array", raw);
  return raw.map((c) => {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.name !== "string") {
      fail("malformed tool call", c);
    }
    return { id: c.id, name: c.name, arguments: (c.arguments ?? null) as JsonValue };
  });
}

export function encodeHistory(history: readonly AgentMessage[]): JsonValue {
  return history.map((m) => {
    const content = m.content.map(encodePart);
    if (m.role === "user") return { role: "user", content };
    if (m.role === "assistant") {
      return {
        role: "assistant", content,
        ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls.map(c => ({ ...c })) }),
      };
    }
    return {
      role: "tool", callId: m.callId, content,
      ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent }),
    };
  }) as JsonValue;
}

export function decodeHistory(raw: JsonValue): AgentMessage[] {
  if (!Array.isArray(raw)) fail("history is not an array", raw);
  return raw.map((m) => {
    if (!isRecord(m)) fail("message is not an object", m);
    if (!Array.isArray(m.content)) fail("message content is not an array", m);
    const content = m.content.map(decodePart);
    if (m.role === "user") return { role: "user", content } as AgentMessage;
    if (m.role === "assistant") {
      return {
        role: "assistant", content,
        ...(m.toolCalls === undefined ? {} : { toolCalls: decodeToolCalls(m.toolCalls) }),
      } as AgentMessage;
    }
    if (m.role === "tool") {
      if (typeof m.callId !== "string") fail("tool message has no callId", m);
      return {
        role: "tool", callId: m.callId, content,
        ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent as JsonValue }),
      } as AgentMessage;
    }
    fail("unknown message role", m);
  });
}
