import { describe, expect, it } from "vitest";
import { createSBlob, isSBlob } from "@unidocs/svalue-codec";
import type { AgentMessage } from "@unidocs/protocol";
import { decodeHistory, encodeHistory } from "../../src/agent/history-codec.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const history: AgentMessage[] = [
  { role: "user", content: [
    { type: "text", text: "把这张图去掉背景" },
    { type: "image", blob: createSBlob(HASH_A), mediaType: "image/png", altText: "原图" },
  ] },
  { role: "assistant",
    content: [{ type: "text", text: "好的" }],
    toolCalls: [{ id: "call-1", name: "editPixels", arguments: { layerId: "l0" } }] },
  { role: "tool", callId: "call-1",
    content: [{ type: "file", blob: createSBlob(HASH_B), mediaType: "application/pdf", filename: "r.pdf" }],
    structuredContent: { ok: true } },
];

describe("历史编解码器", () => {
  it("往返一致", () => {
    expect(decodeHistory(encodeHistory(history))).toEqual(history);
  });

  // 这是本编解码器存在的全部理由。字节在 CAS 里,历史里存的一直是引用
  // (protocol/src/types.ts:315)。存字节会让每条历史带上几 MB 的 base64,
  // 一份长对话能把 jsonb 撑爆。
  it("SBlob 只编成 hash，编码结果里不出现字节", () => {
    const encoded = JSON.stringify(encodeHistory(history));
    expect(encoded).toContain(HASH_A);
    expect(encoded).not.toContain("data");
    expect(encoded).not.toContain("Uint8Array");
    expect(encoded.length).toBeLessThan(1000);
  });

  it("解码出来的是真正的 SBlob 品牌对象，不是手搓的 {hash}", () => {
    const decoded = decodeHistory(encodeHistory(history));
    const part = (decoded[0] as { content: { type: string; blob?: unknown }[] }).content[1]!;
    expect(part.type).toBe("image");
    expect(isSBlob(part.blob)).toBe(true);
  });

  it("空历史往返成空数组", () => {
    expect(decodeHistory(encodeHistory([]))).toEqual([]);
  });

  it("可选字段缺席时不会凭空长出来（toolCalls）", () => {
    const minimal: AgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "无工具调用" }] },
    ];
    const decoded = decodeHistory(encodeHistory(minimal));
    expect(decoded).toEqual(minimal);
    expect("toolCalls" in decoded[0]!).toBe(false);
  });

  it("可选字段缺席时不会凭空长出来（image.altText）", () => {
    const minimal: AgentMessage[] = [
      { role: "user", content: [
        { type: "image", blob: createSBlob(HASH_A), mediaType: "image/png" },
      ] },
    ];
    const encoded = encodeHistory(minimal);
    const encodedPart = (
      (encoded as { content: Record<string, unknown>[] }[])[0]!.content[0]!
    );
    expect("altText" in encodedPart).toBe(false);
    const decoded = decodeHistory(encoded);
    expect(decoded).toEqual(minimal);
    const decodedPart = (decoded[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect("altText" in decodedPart).toBe(false);
  });

  it("可选字段缺席时不会凭空长出来（file.filename）", () => {
    const minimal: AgentMessage[] = [
      { role: "tool", callId: "call-x", content: [
        { type: "file", blob: createSBlob(HASH_B), mediaType: "application/pdf" },
      ] },
    ];
    const encoded = encodeHistory(minimal);
    const encodedPart = (
      (encoded as { content: Record<string, unknown>[] }[])[0]!.content[0]!
    );
    expect("filename" in encodedPart).toBe(false);
    const decoded = decodeHistory(encoded);
    expect(decoded).toEqual(minimal);
    const decodedPart = (decoded[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect("filename" in decodedPart).toBe(false);
  });

  it("可选字段缺席时不会凭空长出来（tool.structuredContent）", () => {
    const minimal: AgentMessage[] = [
      { role: "tool", callId: "call-y", content: [{ type: "text", text: "无结构化内容" }] },
    ];
    const encoded = encodeHistory(minimal);
    const encodedMessage = (encoded as Record<string, unknown>[])[0]!;
    expect("structuredContent" in encodedMessage).toBe(false);
    const decoded = decodeHistory(encoded);
    expect(decoded).toEqual(minimal);
    expect("structuredContent" in decoded[0]!).toBe(false);
  });

  // 静默丢弃一条图片消息，会让模型在后续轮次里引用一张它其实没看到的图 ——
  // 表现是模型"胡说八道"，而根因在这里，隔着好几层。
  it.each([
    ["未知的 part 类型", { role: "user", content: [{ type: "video", url: "x" }] }],
    ["未知的 role", { role: "system", content: [] }],
    ["image 缺 hash", { role: "user", content: [{ type: "image", mediaType: "image/png" }] }],
    ["content 不是数组", { role: "user", content: "文本" }],
  ])("%s 一律抛错，不静默丢弃", (_label, bad) => {
    expect(() => decodeHistory([bad] as never)).toThrow();
  });

  it("顶层不是数组也抛错", () => {
    expect(() => decodeHistory({ role: "user" } as never)).toThrow();
  });
});
