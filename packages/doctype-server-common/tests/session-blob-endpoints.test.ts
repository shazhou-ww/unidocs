/**
 * `createSessionHandler`'s `read_blob` / `write_blob` routes — added to
 * close C1 of the 2026-09-03 final review: Azure's editor served every
 * other `/_internal/*` endpoint but these two, so `platform-http.ts`'s
 * `readBlob()` always got a 404 back and (mis)read it as "the blob is
 * gone", silently degrading every image an agent tool returned into a line
 * of alt-text. See editor-do-svalue.ts:606-646 for the Cloudflare
 * equivalent these are aligned to (request/response shapes, Content-Type
 * validation, empty-body validation, error-code mapping).
 *
 * `blobs` is an in-memory fake here on purpose: it exercises exactly the
 * contract `createSessionHandler` depends on (`openSBlob` / `makeSBlob`),
 * the same contract Azure's real `createSBlobContext(...)` (backed by CAS)
 * satisfies. A real CAS round-trip is covered at the wiring level in
 * azure-sdk's doc-type-service.test.ts; this file is where the actual new
 * routing logic — the part that was missing — gets pinned down directly.
 */
import { describe, expect, it } from "vitest";
import { createSBlob, decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type {
  ByteStream,
  DocumentType,
  DocumentTypeContext,
  MakeSBlob,
  SBlob,
  SBlobHandler,
  SBlobSource,
  SValue,
} from "@unidocs/protocol";
import { CasClientError } from "@unicas/tenant-blob-client";
import { createMemoryPorts } from "../src/memory-ports.js";
import { DocumentSession, type SessionDeps } from "../src/session.js";
import { createSessionHandler } from "../src/session-handler.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const MISSING_HASH = "e".repeat(64);

// --------------------------------------------------------------------------
// A trivial doc type — the blob endpoints don't care what TDoc looks like,
// they only need `session.initialized` to be true.
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// A minimal in-memory SBlob store implementing exactly the two methods
// `createSessionHandler`'s new routes call.
// --------------------------------------------------------------------------

interface StoredBlob { readonly data: Uint8Array; readonly contentType: string }

function byteStreamOf(bytes: Uint8Array): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function sliceRange(data: Uint8Array, range?: { readonly offset: number; readonly length?: number }): Uint8Array {
  if (!range) return data;
  const end = range.length === undefined ? data.length : range.offset + range.length;
  return data.slice(range.offset, end);
}

async function fullHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function collectSource(source: SBlobSource): Promise<{ data: Uint8Array; contentType: string }> {
  if ("data" in source) return { data: Uint8Array.from(source.data), contentType: source.contentType };
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.body) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return { data, contentType: source.contentType };
}

/** A fake CAS-backed `DocumentTypeContext` — same shape as `createSBlobContext(...)`'s return value. */
function makeBlobsContext(): { blobs: Pick<DocumentTypeContext, "openSBlob" | "makeSBlob">; store: Map<string, StoredBlob> } {
  const store = new Map<string, StoredBlob>();

  const makeSBlob = (async (
    input: string | SBlobSource,
    loadSource?: () => Promise<SBlobSource>,
  ): Promise<SBlob> => {
    if (typeof input === "string") {
      if (!store.has(input)) {
        if (!loadSource) throw new TypeError("hash-first makeSBlob requires a source callback");
        store.set(input, await collectSource(await loadSource()));
      }
      return createSBlob(input);
    }
    const collected = await collectSource(input);
    const hash = await fullHash(collected.data);
    store.set(hash, collected);
    return createSBlob(hash);
  }) as MakeSBlob;

  const openSBlob = async (blob: SBlob): Promise<SBlobHandler> => {
    const stored = store.get(blob.hash);
    if (!stored) throw new CasClientError(404, "Not Found", "openBlob");
    return {
      size: stored.data.length,
      contentType: stored.contentType,
      read: range => byteStreamOf(sliceRange(stored.data, range)),
      readBytes: async range => sliceRange(stored.data, range),
    };
  };

  return { blobs: { makeSBlob, openSBlob }, store };
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

async function makeInitializedSession(): Promise<DocumentSession<string, TextQuery, TextOp>> {
  const ports = createMemoryPorts();
  const deps: SessionDeps = {
    deltas: ports.deltas,
    snapshots: ports.snapshots,
    blobs: ports.blobs,
    unitOfWork: ports.unitOfWork,
    cas: ports.cas,
    identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
    now: () => Date.now(),
  };
  const session = new DocumentSession(makeTextDocType(), deps);
  await session.load();
  await session.create({ bytes: encoder.encode("hi") });
  return session;
}

function svalueRequest(url: string, value: SValue): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": SValueContentType, Accept: SValueContentType },
    body: Uint8Array.from(encodeSValue(value)).buffer as ArrayBuffer,
  });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("session-handler POST /_internal/read_blob", () => {
  it("拿到真字节 —— Content-Type、大小、hash 头都对得上", async () => {
    const session = await makeInitializedSession();
    const { blobs, store } = makeBlobsContext();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const hash = await fullHash(bytes);
    store.set(hash, { data: bytes, contentType: "image/png" });
    const blob = createSBlob(hash);

    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const response = await handle(svalueRequest("https://svc/_internal/read_blob", { blob }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-UniDocs-SBlob-Size")).toBe(String(bytes.length));
    expect(response.headers.get("X-UniDocs-SBlob-Hash")).toBe(hash);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));
  });

  // 与 CF 对齐后的真实行为(不是 brief 最初写的 404 —— 已与协调者核实):
  // editor-do-svalue.ts 的 read_blob 分支自己不 catch,CasClientError(404)
  // 冒泡到外层通用 catch,那里的三分映射是 404→400 / 409→409 / else→502。
  // session-handler.ts 的 `errorResponse` 是同一套三分映射,所以这里什么都
  // 不用另外写就自动对齐 —— 这条测试钉住的正是"自动对齐"这件事本身。
  it("blob 真的不存在时返回 400(与 CF 的 CasClientError 映射对齐,不是裸 404)", async () => {
    const session = await makeInitializedSession();
    const { blobs } = makeBlobsContext();
    const blob = createSBlob(MISSING_HASH);

    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const response = await handle(svalueRequest("https://svc/_internal/read_blob", { blob }));

    expect(response.status).toBe(400);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("404");
  });

  it("请求体不是合法的 SBlob 引用时 400", async () => {
    const session = await makeInitializedSession();
    const { blobs } = makeBlobsContext();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const response = await handle(svalueRequest("https://svc/_internal/read_blob", { blob: "not-a-blob" }));

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("Invalid blob read request");
  });

  it("没配 blobs 时维持既有的 404 Unknown endpoint(不注入就是零行为变化)", async () => {
    const session = await makeInitializedSession();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
    });

    const response = await handle(svalueRequest("https://svc/_internal/read_blob", { blob: createSBlob(MISSING_HASH) }));

    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toContain("Unknown endpoint");
  });
});

describe("session-handler POST /_internal/write_blob", () => {
  it("把字节落地,回来的 SBlob 品牌保留(SValue 信封,不是裸 JSON)", async () => {
    const session = await makeInitializedSession();
    const { blobs, store } = makeBlobsContext();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const response = await handle(new Request("https://svc/_internal/write_blob", {
      method: "POST",
      headers: { "Content-Type": "image/png", Accept: SValueContentType },
      body: payload.buffer as ArrayBuffer,
    }));

    expect(response.status).toBe(200);
    const decoded = decodeSValue(new Uint8Array(await response.arrayBuffer())) as { blob: SBlob };
    expect(isSBlob(decoded.blob)).toBe(true);
    const stored = store.get(decoded.blob.hash);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.data)).toEqual(Array.from(payload));
    expect(stored!.contentType).toBe("image/png");
  });

  it("写完立刻能通过 read_blob 读回同样的字节 —— 端到端往返", async () => {
    const session = await makeInitializedSession();
    const { blobs } = makeBlobsContext();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const payload = new Uint8Array([9, 9, 9, 9]);
    const writeResponse = await handle(new Request("https://svc/_internal/write_blob", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Accept: SValueContentType },
      body: payload.buffer as ArrayBuffer,
    }));
    const { blob } = decodeSValue(new Uint8Array(await writeResponse.arrayBuffer())) as { blob: SBlob };

    const readResponse = await handle(svalueRequest("https://svc/_internal/read_blob", { blob }));
    expect(readResponse.status).toBe(200);
    expect(Array.from(new Uint8Array(await readResponse.arrayBuffer()))).toEqual(Array.from(payload));
  });

  it("缺 Content-Type 时 400", async () => {
    const session = await makeInitializedSession();
    const { blobs } = makeBlobsContext();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const response = await handle(new Request("https://svc/_internal/write_blob", {
      method: "POST",
      body: new Uint8Array([1]).buffer as ArrayBuffer,
    }));

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("Content-Type");
  });

  it("空 body 时 400", async () => {
    const session = await makeInitializedSession();
    const { blobs } = makeBlobsContext();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      blobs,
    });

    const response = await handle(new Request("https://svc/_internal/write_blob", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(0).buffer as ArrayBuffer,
    }));

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("empty body");
  });

  it("没配 blobs 时维持既有的 404 Unknown endpoint", async () => {
    const session = await makeInitializedSession();
    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
    });

    const response = await handle(new Request("https://svc/_internal/write_blob", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([1]).buffer as ArrayBuffer,
    }));

    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toContain("Unknown endpoint");
  });
});
