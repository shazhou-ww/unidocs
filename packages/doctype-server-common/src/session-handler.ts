/**
 * createSessionHandler — cloud-neutral HTTP surface over `DocumentSession`.
 *
 * This is the `/_internal/*` routing and error-mapping logic shared by every
 * transport adapter (Cloudflare's `EditorDO`, and later Azure's session
 * entry point). It owns exactly two things:
 *
 *   1. parsing the `/_internal/*` HTTP surface and calling the matching
 *      `DocumentSession` method
 *   2. mapping the typed errors of server-core onto status codes
 *      (`errorResponse`, exported so callers can reuse it for errors that
 *      happen outside the handler's own try/catch — e.g. a transport
 *      adapter's post-success bookkeeping, such as EditorDO persisting the
 *      document identity after `create` / `init_from_hash`)
 *
 * Everything about *how a document evolves* — in-memory state, snapshot +
 * replay reconstruction, the delta write order, the snapshot threshold —
 * lives in `DocumentSession` itself. Everything about *how a request reaches
 * this function* (per-instance serialization, dependency wiring, transport
 * framing) is the caller's job, not this module's.
 *
 * Internal endpoints:
 *   POST /_internal/create          — create new document (multipart/form-data)
 *   POST /_internal/query           — query document (body: TQuery) -> { data, version }
 *   POST /_internal/apply           — apply delta (body: { operations[], description, baseVersion }) -> { version }
 *   GET  /_internal/export          — download document as binary
 *   GET  /_internal/history         — get delta history
 *   POST /_internal/rollback        — rollback to version (body: { version })
 *   GET  /_internal/snapshot        — get current snapshot hash (for clone)
 *   GET  /_internal/ir              — get canonical current-TDoc bytes for browser cold start
 *   POST /_internal/init_from_hash  — initialize from existing snapshot hash (for clone)
 *   POST /_internal/read_blob       — read SBlob bytes (only when `blobs` is configured; agent readBlob)
 *   POST /_internal/write_blob      — store SBlob bytes (only when `blobs` is configured; agent writeBlob)
 */

import { SValueContentType, type DocumentTypeContext, type SValue } from "@unidocs/protocol";
import { decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { encodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { CasClientError } from "@unicas/tenant-blob-client";
import {
  DeltaRejectedError,
  DocExistsError,
  DocNotFoundError,
  RootRefsError,
  StorageCorruptError,
  VersionConflictError,
  type ApplyResult,
} from "@unidocs/protocol-doc";
import type { SessionIdentity } from "./ports.js";
import type { DocumentSession } from "./session.js";
import { AmbiguousFormatError, selectFormat, UnknownFormatError } from "./format-select.js";
import { readableStreamFromByteStream } from "./sblob-context.js";

const NOT_INITIALIZED = "Document not initialized. POST /{docType}/ to create.";

export interface CreateSessionHandlerConfig<TDoc, TQuery, TOp> {
  session: DocumentSession<TDoc, TQuery, TOp>;
  identity: SessionIdentity;
  /**
   * Reject uploads larger than this with 413 instead of attempting them.
   *
   * Unset means unlimited, which is what every caller did before this
   * existed — but an unlimited upload is not "generous", it is a crash: the
   * import path holds the whole file in memory (formData, then a second copy
   * in `file.arrayBuffer()`, then the doc type's own decompressed
   * representation), so a large enough document kills the process. That takes
   * down every other request sharing the replica, which is strictly worse
   * than refusing the one request honestly.
   */
  maxUploadBytes?: number;
  /**
   * SBlob 读写上下文，给 agent 的 `read_blob` / `write_blob` 用
   * (platform-http.ts 的 readBlob/writeBlob 打的正是这两条)。行为对齐
   * Cloudflare 的等价实现 (editor-do-svalue.ts:606-646) —— 请求/响应形状、
   * Content-Type 校验、空 body 校验、错误映射全部一致；缺失 CasClientError
   * 时的三分映射复用下面的 `errorResponse`，与 CF 的 outer catch 是同一套
   * 三分 (404→400 / 409→409 / else→502)，不是新发明。
   *
   * 省略 = 这两条端点维持 404 兜底，与它们存在之前的行为一致
   * (Cloudflare 目前不走这里，它的 EditorDO 自己实现了这两条)。
   */
  blobs?: Pick<DocumentTypeContext, "openSBlob" | "makeSBlob">;
}

/**
 * The response bodies here are asserted verbatim by the e2e suites
 * (tests/integration/cloudflare/cas-rollback.test.mjs, tests/integration/cloudflare/editor-characterization.test.mjs,
 * the treespec tree under tests/treespec). Field names and message text
 * are part of the contract — do not reword them.
 */
export function errorResponse(err: unknown, version: number): Response {
  if (err instanceof VersionConflictError) {
    return Response.json(
      { success: false, version: err.currentVersion, error: err.message },
      { status: 409 },
    );
  }
  if (err instanceof DeltaRejectedError) {
    // message is already `Delta failed: ...`
    return Response.json({ success: false, version, error: err.message }, { status: 400 });
  }
  if (err instanceof DocExistsError) {
    return Response.json({ success: false, error: err.message }, { status: 409 });
  }
  if (err instanceof DocNotFoundError) {
    return Response.json({ success: false, version, error: err.message }, { status: 404 });
  }
  if (err instanceof RootRefsError) {
    // message is already `CAS root-refs failed: ...`
    return Response.json({ success: false, version, error: err.message }, { status: 502 });
  }
  if (err instanceof StorageCorruptError) {
    // message is already `Snapshot ${hash} not found in R2`
    return Response.json({ success: false, version, error: err.message }, { status: 500 });
  }
  if (err instanceof CasClientError) {
    // Same three-way split the pre-refactor `#leaseFailure` used.
    const status = err.status === 409 ? 409 : err.status === 404 ? 400 : 502;
    return Response.json({ success: false, version, error: err.message }, { status });
  }
  if (err instanceof UnknownFormatError || err instanceof AmbiguousFormatError) {
    // A client picking (or a filename/mediaType detecting) a format the
    // document type never registered is a bad request, not a server fault —
    // and 5xx here would trip on-call / 5xx SLOs for a typo in `?format=`.
    // `err.message`, not `String(err)`: the latter prepends `Error: `, which
    // Cloudflare's equivalent (`editor-do-svalue.ts`'s manual format lookup)
    // never did — this keeps the message text identical across runtimes.
    return Response.json({ success: false, version, error: err.message }, { status: 400 });
  }
  return Response.json({ success: false, error: String(err), version }, { status: 500 });
}

export function createSessionHandler<TDoc, TQuery, TOp>(
  cfg: CreateSessionHandlerConfig<TDoc, TQuery, TOp>,
): (request: Request) => Promise<Response> {
  const { session } = cfg;
  const maxUploadBytes = cfg.maxUploadBytes;

  function tooLarge(bytes: number): Response {
    return Response.json({
      success: false,
      error: `Upload is ${bytes} bytes, over the ${maxUploadBytes}-byte limit for this document type`,
    }, { status: 413 });
  }

  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const endpoint = url.pathname;

    try {
      // POST /_internal/create — create new document
      if (method === "POST" && endpoint === "/_internal/create") {
        const contentType = request.headers.get("content-type") || "";
        // Checked BEFORE formData(): that call reads the entire body into
        // memory, so refusing afterwards has already paid the cost the limit
        // exists to avoid.
        if (maxUploadBytes !== undefined) {
          const declared = Number(request.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxUploadBytes) {
            return tooLarge(declared);
          }
        }
        let file: File | null = null;
        let sourceId: string | null = null;
        let formData: FormData | null = null;

        if (contentType.includes("multipart/form-data")) {
          formData = await request.formData();
          file = formData.get("file") as File | null;
          sourceId = formData.get("sourceId") as string | null;
        }

        let bytes: Uint8Array | undefined;
        if (file) {
          // Fallback for chunked uploads, which carry no Content-Length. The
          // body is already buffered by this point, so this only prevents the
          // second copy and the doc type's decompression — worth having, but
          // it is not a substitute for the header check above.
          if (maxUploadBytes !== undefined && file.size > maxUploadBytes) {
            return tooLarge(file.size);
          }
          bytes = new Uint8Array(await file.arrayBuffer());
        } else if (sourceId) {
          return Response.json(
            { success: false, error: "Clone should be handled at worker level" },
            { status: 400 },
          );
        }

        // 今天这里把 file.name / file.type 直接丢掉了,于是 Azure 这条路上
        // 上传什么都按 defaultFormat 解。喂给 selectFormat,让服务端能据此
        // 认出 .png。formData 里的显式 `format` 作为覆盖(与 Cloudflare 那条
        // 的 :783 对齐;前端本期不用它)。
        let formatName: string | undefined;
        if (file) {
          const requested = formData?.get("format");
          formatName = selectFormat(session.config, {
            ...(typeof requested === "string" ? { name: requested } : {}),
            mediaType: file.type,
            filename: file.name,
          }).name;
        }

        const created = await session.create({ bytes, ...(formatName ? { format: formatName } : {}) });
        return Response.json({
          success: true,
          sessionId: created.sessionId,
          version: created.version,
        });
      }

      // POST /_internal/init_from_hash — checked BEFORE the not-initialized guard
      if (method === "POST" && endpoint === "/_internal/init_from_hash") {
        const body = await readRequestValue(request) as unknown as { hash: string; sourceVersion: number };
        const created = await session.initFromHash(body.hash, body.sourceVersion);
        return Response.json({
          success: true,
          sessionId: created.sessionId,
          version: created.version,
        });
      }

      if (method === "GET" && endpoint === "/_internal/status") {
        await session.load();
        return Response.json({ exists: session.initialized, version: session.version });
      }

      // All other endpoints require an initialized document.
      await session.load();
      if (!session.initialized) {
        return Response.json({ success: false, error: NOT_INITIALIZED }, { status: 404 });
      }

      // GET /_internal/export — download document
      if (method === "GET" && endpoint === "/_internal/export") {
        // `??` 只挡 null;`?format=`(空值)会给出 "",那同样是「没指定格式」。
        // 漏掉它会让这种请求走进 exportBytes 的显式格式分支,Content-Type
        // 变成 mediaTypes[0] 而不是顶层 contentType——护栏 2 就破了。
        const requested = url.searchParams.get("format") || undefined;
        const exported = await session.exportBytes(requested);
        // 扩展名跟着所选格式走。这不是新设计,是把 Azure 补齐到 Cloudflare
        // 已有的行为(editor-do-svalue.ts:563 早就是 `document${extension}`)。
        const extension = requested
          ? selectFormat(session.config, { name: requested }).format.extensions[0] ?? ""
          : session.config.formats[session.config.defaultFormat]?.extensions[0] ?? "";
        // `Uint8Array<ArrayBufferLike>` (the general shape `save()` returns)
        // isn't structurally `BodyInit` under lib.dom's stricter
        // `Uint8Array<ArrayBuffer>` — this is a type-level mismatch only, the
        // runtime value is a plain byte buffer either way.
        return new Response(exported.bytes as BodyInit, {
          headers: {
            "Content-Type": exported.contentType,
            "Content-Disposition": `attachment; filename="document${extension}"`,
          },
        });
      }

      // POST /_internal/query
      //
      // 既有缺陷(2026-09-03 全分支评审之外新发现,与协调者核实过):这里曾经
      // 是裸 `Response.json({success, data, version})`。`result.data` 可能带
      // SBlob(例如 psd 的 getPreview 在 query 结果里放一张预览图的引用)——
      // JSON.stringify 不认识 SBlob 品牌用的那个 symbol 键,会静默把它丢在
      // 半路,客户端收到的只是一个 `{hash: "..."}` 的裸对象,`isSBlob()` 判它
      // 不是 SBlob。这正是 C1(read_blob/write_blob 缺失)想解决的同一个问题
      // 在更早一步的翻版:query 工具(getPreview 之类)的 `toResult` 走不到
      // "blob 没了"那条降级路径,而是直接抛"不是 SBlob"——agent 一样看不见
      // 图,只是失败点从 readBlob 挪到了这里。
      //
      // 改成 `valueResponse` 后与 CF 的 editor-do-svalue.ts:591 逐字对齐:
      // `valueResponse` 是内容协商的(见上面的定义),数据里不含 SBlob 引用、
      // 调用方也没要 SValue 类型时,产出的仍是逐字节相同的 `Response.json`——
      // 所以这一行改动只影响"数据带 SBlob"这一种情况,从静默丢品牌变成正确
      // 的 SValue 编码(调用方要了)或一个响亮的 406(调用方没要,不能悄悄
      // 编）。刻意只改这一处:apply/status/rollback 等端点是否也有同样的
      // 问题是另一件要单独核实的事,不在本轮范围内。
      if (method === "POST" && endpoint === "/_internal/query") {
        const q = await readRequestValue(request) as unknown as TQuery;
        const result = await session.query(q as never);
        return valueResponse(request, { success: true, data: result.data, version: result.version });
      }

      // POST /_internal/read_blob — agent 侧 platform.readBlob 打的端点。
      // 逐条对齐 editor-do-svalue.ts:606-628：body 形状校验、可选 range
      // 校验、响应用裸字节 + Content-Type/X-UniDocs-SBlob-* 头，不走
      // SValue 信封（净荷可以是几 MB 的图，多包一层等于复制一遍）。
      if (cfg.blobs && method === "POST" && endpoint === "/_internal/read_blob") {
        const value = await readRequestValue(request);
        if (!isRecord(value) || !isSBlob(value.blob)) {
          return Response.json({ success: false, error: "Invalid blob read request" }, { status: 400 });
        }
        const rangeValue = value.range;
        const range = rangeValue === undefined
          ? undefined
          : isRecord(rangeValue)
            && typeof rangeValue.offset === "number"
            && (rangeValue.length === undefined || typeof rangeValue.length === "number")
            ? { offset: rangeValue.offset, ...(rangeValue.length === undefined ? {} : { length: rangeValue.length }) }
            : null;
        if (range === null) {
          return Response.json({ success: false, error: "Invalid blob read range" }, { status: 400 });
        }
        const handler = await cfg.blobs.openSBlob(value.blob);
        return new Response(readableStreamFromByteStream(handler.read(range)), {
          headers: {
            "Content-Type": handler.contentType,
            "X-UniDocs-SBlob-Size": String(handler.size),
            "X-UniDocs-SBlob-Hash": value.blob.hash,
          },
        });
      }

      // POST /_internal/write_blob — agent 侧 effect 工具(图像模型返回的
      // PNG)的落点，platform.writeBlob 打的端点。逐条对齐
      // editor-do-svalue.ts:632-646：Content-Type 必须显式给、空 body 拒绝，
      // 响应走 SValue 信封（回来的 SBlob 是带符号品牌的分支类型，纯 JSON
      // 会把符号属性丢在半路，客户端的 isSBlob() 会判它不是 SBlob）。
      if (cfg.blobs && method === "POST" && endpoint === "/_internal/write_blob") {
        const contentType = request.headers.get("content-type");
        if (!contentType) {
          return Response.json({ success: false, error: "write_blob needs a Content-Type" }, { status: 400 });
        }
        const data = new Uint8Array(await request.arrayBuffer());
        if (data.length === 0) {
          return Response.json({ success: false, error: "write_blob got an empty body" }, { status: 400 });
        }
        const blob = await cfg.blobs.makeSBlob({ data, contentType });
        return valueResponse(request, { blob });
      }

      // POST /_internal/apply — apply delta (batch of operations, transactional)
      if (method === "POST" && endpoint === "/_internal/apply") {
        const body = await readRequestValue(request) as unknown as {
          operations: TOp[];
          description: string;
          baseVersion: number;
          opId?: string;
        };

        const applied = await session.apply(
          body.operations as never,
          body.description,
          body.baseVersion,
          body.opId,
        );
        const result: ApplyResult = { success: true, version: applied.version };
        return Response.json(result);
      }

      // GET /_internal/history
      if (method === "GET" && endpoint === "/_internal/history") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        // Truthy check, not `!== null`: `?from=` (empty string) must be
        // ignored the way it always was. `parseInt("")` is NaN, and a NaN
        // bound into the range query is not a bound at all.
        const entries = await session.history(
          from ? parseInt(from) : undefined,
          to ? parseInt(to) : undefined,
        );
        return Response.json({ success: true, data: entries, version: session.version });
      }

      // POST /_internal/rollback
      if (method === "POST" && endpoint === "/_internal/rollback") {
        const body = await readRequestValue(request) as unknown as { version: number };
        const rolled = await session.rollback(body.version);
        return Response.json({ success: true, version: rolled.version });
      }

      // GET /_internal/snapshot — get current snapshot hash (for clone)
      if (method === "GET" && endpoint === "/_internal/snapshot") {
        const snap = await session.snapshot();
        return Response.json({
          success: true,
          version: snap.version,
          hash: snap.hash,
          docType: snap.docType,
        });
      }

      // GET /_internal/ir — get canonical current-TDoc bytes for browser cold start
      if (method === "GET" && endpoint === "/_internal/ir") {
        const { version, bytes } = await session.ir();
        return new Response(bytes as BodyInit, {
          headers: { "content-type": SValueContentType, "X-Doc-Version": String(version) },
        });
      }

      return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
    } catch (err) {
      return errorResponse(err, session.version);
    }
  };
}

async function readRequestValue(request: Request): Promise<SValue> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase() === SValueContentType) {
    return decodeSValue(new Uint8Array(await request.arrayBuffer()));
  }
  const json = await request.json();
  return decodeSValue(encodeSValue(json as SValue));
}

/** Same shape-check CF's editor-do-svalue.ts uses: a plain record, not an SBlob or array. */
function isRecord(value: unknown): value is Record<string, SValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isSBlob(value);
}

/**
 * Mirrors editor-do-svalue.ts's `valueResponse`: SValue-encode when the
 * caller can take it (write_blob's client always sets Accept), otherwise
 * fall back to plain JSON — but 406 if the value actually contains an SBlob
 * ref, since a plain JSON round-trip silently drops the brand.
 */
function valueResponse(request: Request, value: SValue): Response {
  const encoded = encodeSValueWithRefs(value);
  const acceptsSValue = (request.headers.get("accept") ?? "").includes(SValueContentType)
    || (request.headers.get("content-type") ?? "").toLowerCase() === SValueContentType;
  if (acceptsSValue) {
    return new Response(Uint8Array.from(encoded.data).buffer, {
      headers: { "Content-Type": SValueContentType },
    });
  }
  if (encoded.refs.length > 0) {
    return Response.json({ error: "This response requires the SValue media type" }, { status: 406 });
  }
  return Response.json(value);
}
