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

import { SValueContentType } from "@unidocs/protocol";
import { CasClientError } from "@unidocs/cas-client";
import {
  DeltaRejectedError,
  DocExistsError,
  DocNotFoundError,
  RootRefsError,
  StorageCorruptError,
  VersionConflictError,
  type ApplyResult,
} from "@unidocs/http-protocol";
import type { DocIdentity } from "./ports.js";
import type { DocumentSession } from "./session.js";

const NOT_INITIALIZED = "Document not initialized. POST /{docType}/ to create.";

export interface CreateSessionHandlerConfig<TDoc, TQuery, TOp> {
  session: DocumentSession<TDoc, TQuery, TOp>;
  identity: DocIdentity;
  /** 请求方声称的 userId;与 identity.userId 不符时返回 403。 */
  requesterId: string | null;
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

/**
 * The requester must be the document's owner, because `deps.cas` is built
 * once from the stored owner id and every CAS read/lease this request makes
 * will be charged to that user.
 *
 * On Cloudflare this is unreachable: the DO is addressed by
 * `idFromName("{userId}:{docId}")` and both workers set `X-User-Id` from the
 * same path segment, so the requester IS the owner by construction. The
 * check exists so the invariant is enforced by code rather than by routing
 * — Azure has no name-bound instance to make it true for free.
 */
function requireUser(requesterId: string | null, identity: DocIdentity): Response | null {
  if (!requesterId) {
    return Response.json({ error: "Missing X-User-Id header" }, { status: 401 });
  }
  if (requesterId !== identity.userId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export function createSessionHandler<TDoc, TQuery, TOp>(
  cfg: CreateSessionHandlerConfig<TDoc, TQuery, TOp>,
): (request: Request) => Promise<Response> {
  const { session, identity, requesterId } = cfg;

  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const endpoint = url.pathname;

    try {
      // POST /_internal/create — create new document
      if (method === "POST" && endpoint === "/_internal/create") {
        const contentType = request.headers.get("content-type") || "";
        let file: File | null = null;
        let sourceId: string | null = null;

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          file = formData.get("file") as File | null;
          sourceId = formData.get("sourceId") as string | null;
        }

        let bytes: Uint8Array | undefined;
        if (file) {
          bytes = new Uint8Array(await file.arrayBuffer());
        } else if (sourceId) {
          return Response.json(
            { success: false, error: "Clone should be handled at worker level" },
            { status: 400 },
          );
        }

        const created = await session.create({ bytes });
        return Response.json({ success: true, docId: created.docId, version: created.version });
      }

      // POST /_internal/init_from_hash — checked BEFORE the not-initialized guard
      if (method === "POST" && endpoint === "/_internal/init_from_hash") {
        const body = await request.json() as { hash: string; sourceVersion: number };
        const created = await session.initFromHash(body.hash, body.sourceVersion);
        return Response.json({ success: true, docId: created.docId, version: created.version });
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
            "Content-Disposition": `attachment; filename="${identity.docId || "document"}"`,
          },
        });
      }

      // POST /_internal/query
      if (method === "POST" && endpoint === "/_internal/query") {
        const unauthorized = requireUser(requesterId, identity);
        if (unauthorized) return unauthorized;

        const q = await request.json() as TQuery;
        const result = await session.query(q as never);
        return Response.json({ success: true, data: result.data, version: result.version });
      }

      // POST /_internal/apply — apply delta (batch of operations, transactional)
      if (method === "POST" && endpoint === "/_internal/apply") {
        const unauthorized = requireUser(requesterId, identity);
        if (unauthorized) return unauthorized;

        const body = await request.json() as {
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
        const unauthorized = requireUser(requesterId, identity);
        if (unauthorized) return unauthorized;

        const body = await request.json() as { version: number };
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
          docId: snap.docId,
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
