/**
 * `createSessionHandler` 的 `GET /_internal/history` —— 内容协商。
 *
 * 由来:web-psd 的 `fetchHistory()` 带 `Accept: application/svalue` 请求历史,
 * 然后把响应体直接喂给 `decodeSValue`。它必须这么做——自 `editPixels` 起,一条
 * delta 的 `operations` 里可以躺着 CAS blob 引用(`generative_fill` 就是这么
 * 记结果层像素的),而 SBlob **按设计没有 JSON 投影**。
 *
 * Cloudflare 侧的 `editor-do-svalue.ts:725` 走的是内容协商的 `valueResponse`;
 * Azure/共享侧这一条却漏了,一直是无条件 `Response.json(...)`。表现极具迷惑
 * 性:HTTP 200、body 看着完全正常,浏览器却把 `{"success":true,…` 的头一个
 * 字节 `0x7B` 当成 CBOR 读——major 3、additional 27,即"接下来 8 字节是长度",
 * 于是报 `Invalid SValue at $: declared length exceeds the safe integer range`。
 * 一个内容协商的漏网之鱼,伪装成了编解码器的数值溢出。
 */
import { describe, expect, it } from "vitest";
import { decodeSValue } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { DocumentType } from "@unidocs/protocol";
import { createMemoryPorts } from "../src/memory-ports.js";
import { DocumentSession, type SessionDeps } from "../src/session.js";
import { createSessionHandler } from "../src/session-handler.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type TextQuery = { kind: "text" };
type TextOp = { kind: "append"; text: string };

function makeTextDocType(): DocumentType<string, TextQuery, TextOp> {
  return {
    async init() {
      return "";
    },
    async query(_q, doc) {
      return doc;
    },
    async apply(operations, doc) {
      let next = doc;
      for (const op of operations) next += op.text;
      return next;
    },
    formats: {
      text: {
        mediaTypes: ["text/plain"],
        extensions: [".txt"],
        async load(bytes) {
          return decoder.decode(bytes);
        },
        async save(doc) {
          return encoder.encode(doc);
        },
      },
    },
    defaultFormat: "text",
    contentType: "text/plain",
    tools: {},
    instructions: "",
  };
}

const identity = { docType: "text", sessionId: "session-1", tenantId: "tenant-1" };

/** 一个已初始化、且带一条 delta 的 session —— 历史里至少要有东西可读。 */
async function makeHandlerWithHistory(): Promise<(request: Request) => Promise<Response>> {
  const ports = createMemoryPorts();
  const deps: SessionDeps = {
    deltas: ports.deltas,
    snapshots: ports.snapshots,
    blobs: ports.blobs,
    unitOfWork: ports.unitOfWork,
    cas: ports.cas,
    identity,
    now: () => Date.now(),
  };
  const session = new DocumentSession(makeTextDocType(), deps);
  await session.load();
  await session.create({ bytes: encoder.encode("hi") });
  await session.apply([{ kind: "append", text: "!" }], "append !", session.version);
  return createSessionHandler({ session, identity });
}

describe("session-handler GET /_internal/history", () => {
  it("Accept: application/svalue 时回 SValue —— 这正是 web-psd 请求的形态", async () => {
    const handle = await makeHandlerWithHistory();

    const response = await handle(new Request("https://svc/_internal/history", {
      headers: { Accept: SValueContentType },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(SValueContentType);

    // 客户端就是这么读的(web-psd/src/ui/api.ts:47)。修复前这一行会抛
    // "declared length exceeds the safe integer range" —— 它在把 JSON 当 CBOR 解。
    const envelope = decodeSValue(new Uint8Array(await response.arrayBuffer())) as unknown as {
      success: boolean;
      data: Array<{ version: number; description: string }>;
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.at(-1)?.description).toBe("append !");
  });

  it("不带 Accept 时仍回 JSON —— 老调用方一个都不能碰坏", async () => {
    const handle = await makeHandlerWithHistory();

    const response = await handle(new Request("https://svc/_internal/history"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
