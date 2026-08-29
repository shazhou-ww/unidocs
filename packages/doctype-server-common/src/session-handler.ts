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
 */

import { SValueContentType, type SValue } from "@unidocs/protocol";
import { decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
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

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
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

        const created = await session.create({ bytes });
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
        const exported = await session.exportBytes();
        // `Uint8Array<ArrayBufferLike>` (the general shape `save()` returns)
        // isn't structurally `BodyInit` under lib.dom's stricter
        // `Uint8Array<ArrayBuffer>` — this is a type-level mismatch only, the
        // runtime value is a plain byte buffer either way.
        return new Response(exported.bytes as BodyInit, {
          headers: {
            "Content-Type": exported.contentType,
            "Content-Disposition": "attachment; filename=\"document\"",
          },
        });
      }

      // POST /_internal/query
      if (method === "POST" && endpoint === "/_internal/query") {
        const q = await readRequestValue(request) as unknown as TQuery;
        const result = await session.query(q as never);
        return Response.json({ success: true, data: result.data, version: result.version });
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
