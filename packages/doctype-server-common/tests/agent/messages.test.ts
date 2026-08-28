import { describe, expect, it, vi } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { AgentMessage } from "@unidocs/protocol";
import { BlobUnavailableError, ByteLru, materializeMessages } from "../../src/agent/index.js";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const png = (n: number) => new Uint8Array([n, n, n]);

function imageMsg(hash: string, altText: string): AgentMessage {
  return {
    role: "tool",
    callId: "c1",
    content: [{ type: "image", blob: createSBlob(hash), mediaType: "image/png", altText }],
  };
}

describe("附件物化", () => {
  it("把 SBlob 换成字节，三个 role 一视同仁", async () => {
    const readBlob = vi.fn(async () => ({ data: png(1), contentType: "image/png" }));
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "image", blob: createSBlob(H1), mediaType: "image/png" }] },
      { role: "assistant", content: [{ type: "image", blob: createSBlob(H2), mediaType: "image/png" }] },
      imageMsg(H1, "preview"),
    ];
    const out = await materializeMessages(msgs, readBlob, new ByteLru(1024));
    for (const m of out) {
      const p = m.content[0];
      expect(p.type === "image" && p.data).toEqual(png(1));
    }
  });

  it("同一个 hash 只读一次 —— 缓存按 hash 去重（spec V24）", async () => {
    const readBlob = vi.fn(async () => ({ data: png(1), contentType: "image/png" }));
    const cache = new ByteLru(1024);
    const msgs = [imageMsg(H1, "p"), imageMsg(H1, "p"), imageMsg(H2, "q")];
    await materializeMessages(msgs, readBlob, cache);
    await materializeMessages(msgs, readBlob, cache);
    expect(readBlob).toHaveBeenCalledTimes(2); // 两个不同 hash，不是六次
  });

  it("blob 确实不存在时降级成 altText 文字，run 继续（spec 6.6.0）", async () => {
    const readBlob = vi.fn(async () => { throw new BlobUnavailableError("gone"); });
    const out = await materializeMessages([imageMsg(H1, "preview 8x8 v3")], readBlob, new ByteLru(1024));
    expect(out[0].content[0]).toEqual({ type: "text", text: "[image: preview 8x8 v3]" });
  });

  it("授权失败必须抛出，不能伪装成图没了（spec 6.6.0）", async () => {
    const readBlob = vi.fn(async () => { throw new Error("CAS 401 unauthorized"); });
    await expect(materializeMessages([imageMsg(H1, "p")], readBlob, new ByteLru(1024)))
      .rejects.toThrow("401");
  });

  it("没有 altText 时降级用 mediaType", async () => {
    const readBlob = vi.fn(async () => { throw new BlobUnavailableError("gone"); });
    const msg: AgentMessage = {
      role: "user",
      content: [{ type: "image", blob: createSBlob(H1), mediaType: "image/png" }],
    };
    const out = await materializeMessages([msg], readBlob, new ByteLru(1024));
    expect(out[0].content[0]).toEqual({ type: "text", text: "[image: image/png]" });
  });
});

describe("ByteLru", () => {
  it("超过字节上限后淘汰最久未用的", () => {
    const lru = new ByteLru(6);
    lru.set(H1, png(1));           // 3 字节
    lru.set(H2, png(2));           // 6 字节，正好到顶
    expect(lru.get(H1)).toEqual(png(1)); // 命中，H1 变成最近使用
    lru.set("c".repeat(64), png(3));     // 超了，淘汰 H2
    expect(lru.get(H2)).toBeUndefined();
    expect(lru.get(H1)).toEqual(png(1));
  });
});
