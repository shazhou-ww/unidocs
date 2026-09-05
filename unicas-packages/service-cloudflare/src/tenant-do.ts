/**
 * Tenant CAS Durable Object — per-`(stackId, tenantId)` mutation coordinator.
 *
 * Short begin/finalize, Root Ref, and GC mutations use an explicit in-instance
 * gate. Canonical request bodies stream to R2 outside that gate, so unrelated
 * uploads and reads do not queue behind a slow body. An upload reservation is
 * the durable GC fence across that unlocked interval. Root Ref commands flow
 * ONE way to the `(stackId, refDomain)` domain DO, so lock ordering cannot
 * cycle.
 */

import { CanonicalNodeContentType, hashToHex, parseCanonicalNodeStream } from "@unicas/codec";
import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import { CasUploadIdHeader, CasUploadLengthHeader } from "@unicas/tenant-protocol";
import {
  type CanonicalNodeUploadPlan,
  collectExpiredUnreferencedNodes,
  DEFAULT_GC_MAX_NODES,
  NodeOpError,
  NodeOpErrorCodes,
  readNodeContent,
  readNodeMetadata,
  readNodeUsage,
  type ParsedUploadedNodeMetadata,
} from "@unicas/service";
import { canonicalComposite } from "./do-names.js";
import {
  admitCanonicalNodeUploadFinalization,
  beginCanonicalNodeLease,
  deleteCanonicalNodeUploadSession,
  finalizeCanonicalNodeLease,
  leaseReadyNode,
  parseLeaseDuration,
  prepareCanonicalNodeUpload,
  uploadCanonicalNode,
} from "./nodes.js";
import { CloudflareNodeGcRepository } from "./node-gc.js";
import { CloudflareNodeReadRepository } from "./node-read.js";
import { CloudflareNodeUsageRepository } from "./node-usage.js";
import { canonicalizeRootRefsUpdate, listTenantRootRefs, parseRootRefsBody } from "./root-refs.js";
import { RootRefsErrorCodes, RootRefsValidationError } from "./root-refs.js";
import { ServerTiming } from "./timing.js";
import { R2UploadPresigner } from "./r2-upload-presigner.js";
import { stackCanonicalNodeKey } from "./do-names.js";

export interface TenantCasDoEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  /** Root Ref domain DO namespace (one-way calls only). */
  CAS_DOMAIN_DO: DurableObjectNamespace;
  CAS_R2_ACCOUNT_ID?: string;
  CAS_R2_BUCKET_NAME?: string;
  CAS_R2_ACCESS_KEY_ID?: string;
  CAS_R2_SECRET_ACCESS_KEY?: string;
  CAS_UPLOAD_URL_EXPIRY_SECONDS?: string;
}

type UploadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

interface ActiveUpload {
  readonly completion: Promise<UploadOutcome>;
  readonly settle: (outcome: UploadOutcome) => void;
}

export class CasDurableObject {
  readonly #env: TenantCasDoEnv;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #activeUploads = new Map<string, ActiveUpload>();
  /** Positive node-ready cache (hash -> expiry) shared by every repository
   *  built in this DO, so child-ready checks and renewals skip the R2 HEAD. */
  readonly #readyCache = new Map<string, number>();

  constructor(_state: DurableObjectState, env: TenantCasDoEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const started = performance.now();
    const timing = new ServerTiming();
    const url = new URL(request.url);
    const stackId = requireHeader(request, "X-CAS-Stack-Id");
    const tenantId = requireHeader(request, "X-CAS-Tenant-Id");
    const store = {
      db: this.#env.CAS_DB,
      bucket: this.#env.CAS_R2,
      stackId,
      tenantId,
      timing,
      readyCache: this.#readyCache,
    };

    try {
      let response: Response;
      if (url.pathname === "/updateRootRefs" && request.method === "POST") {
        response = await this.#withMutation(() => this.#forwardRootRefs(request, stackId, tenantId));
      } else if (url.pathname === "/rootRefs" && request.method === "GET") {
        const limit = parseRootRefsLimit(url.searchParams.get("limit"));
        const cursor = parseRootRefsCursor(url.searchParams.get("cursor"));
        response = jsonResponse(await listTenantRootRefs({
          db: store.db,
          stackId,
          tenantId,
          refDomain: requireHeader(request, "X-CAS-Ref-Domain"),
          limit,
          cursor,
        }));
      } else if (url.pathname === "/lease" && request.method === "POST") {
        response = jsonResponse(await this.#handleLease(request, store));
      } else if (url.pathname === "/read" && request.method === "GET") {
        response = await this.#handleRead(request, store);
      } else if (url.pathname === "/metadata" && request.method === "GET") {
        response = await this.#handleMetadata(request, store);
      } else if (url.pathname === "/usage" && request.method === "GET") {
        response = jsonResponse(await readNodeUsage({
          repository: new CloudflareNodeUsageRepository(store.db, store.bucket),
          scope: { stackId: store.stackId, tenantId: store.tenantId },
        }));
      } else if (url.pathname === "/gc" && request.method === "POST") {
        response = jsonResponse(await this.#handleGc(request, store));
      } else {
        response = Response.json(
          { error: "SERVICE_UNAVAILABLE", message: "tenant CAS operation not implemented yet" },
          { status: 501 },
        );
      }
      timing.record("cas_do_route", performance.now() - started);
      return timing.decorate(response);
    } catch (error) {
      timing.record("cas_do_route", performance.now() - started);
      if (error instanceof NodeOpError) {
        return timing.decorate(Response.json(
          { error: error.code, message: error.message },
          { status: error.status, headers: error.headers },
        ));
      }
      console.error("Unexpected tenant CAS operation failure", error);
      return timing.decorate(Response.json(
        { error: NodeOpErrorCodes.STORAGE, message: "tenant CAS operation failed" },
        { status: 503 },
      ));
    }
  }

  // ─── Node storage operations ──────────────────────────────

  async #handleLease(request: Request, store: Parameters<typeof leaseReadyNode>[0]): Promise<unknown> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const leaseDurationMs = parseLeaseDuration(request.headers.get("X-CAS-Lease-Duration"));
    const contentType = request.headers.get("Content-Type");
    const uploadLengthHeader = request.headers.get(CasUploadLengthHeader);
    const uploadId = request.headers.get(CasUploadIdHeader);
    const modeCount = Number(contentType !== null) + Number(uploadLengthHeader !== null) + Number(uploadId !== null);
    if (modeCount > 1) {
      throw new NodeOpError(400, NodeOpErrorCodes.UPLOAD_INVALID, "Canonical lease upload modes are mutually exclusive");
    }
    if (uploadLengthHeader !== null) {
      const storedBytes = Number(uploadLengthHeader);
      return this.#prepareDirectUpload(store, hash, storedBytes, leaseDurationMs);
    }
    if (uploadId !== null) {
      return this.#finalizeDirectUpload(store, hash, uploadId, leaseDurationMs);
    }
    if (contentType !== null) {
      if (contentType !== CanonicalNodeContentType || request.body === null) {
        throw new NodeOpError(415, NodeOpErrorCodes.INVALID_REQUEST, `Content-Type must be ${CanonicalNodeContentType}`);
      }
      const lengthHeader = request.headers.get("Content-Length");
      const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "Invalid Content-Length");
      }
      if (declaredLength === undefined) {
        throw new NodeOpError(411, NodeOpErrorCodes.INVALID_REQUEST, "Content-Length is required");
      }
      const uploadKey = `${store.stackId}\0${store.tenantId}\0${hash}`;
      let admission:
        | { readonly kind: "ready"; readonly result: unknown }
        | { readonly kind: "join"; readonly active: ActiveUpload }
        | {
          readonly kind: "upload";
          readonly plan: CanonicalNodeUploadPlan;
          readonly active: ActiveUpload;
        };
      try {
        admission = await this.#withMutation(async () => {
          const active = this.#activeUploads.get(uploadKey);
          if (active !== undefined) return { kind: "join", active };
          const begin = await beginCanonicalNodeLease(store, {
            hash,
            leaseDurationMs,
            declaredLength,
          });
          if (begin.kind === "ready") return begin;
          const newActive = deferredUpload();
          this.#activeUploads.set(uploadKey, newActive);
          return { kind: "upload", plan: begin.plan, active: newActive };
        });
      } catch (error) {
        cancelBody(request.body, "Canonical upload rejected");
        throw error;
      }

      if (admission.kind === "ready") {
        cancelBody(request.body, "Node is already ready");
        return admission.result;
      }
      if (admission.kind === "join") {
        cancelBody(request.body, "Identical node upload is already in progress");
        const outcome = await admission.active.completion;
        if (!outcome.ok) throw outcome.error;
        return this.#withMutation(() => leaseReadyNode(store, { hash, leaseDurationMs }));
      }

      try {
        const parsed = await this.#streamCanonicalUpload(
          store, admission.plan, request.body, declaredLength,
        );
        const result = await this.#withMutation(() =>
          finalizeCanonicalNodeLease(store, admission.plan, parsed));
        admission.active.settle({ ok: true });
        return result;
      } catch (error) {
        admission.active.settle({ ok: false, error });
        throw error;
      } finally {
        if (this.#activeUploads.get(uploadKey) === admission.active) {
          this.#activeUploads.delete(uploadKey);
        }
      }
    }
    await request.body?.cancel("Bodyless lease");
    return this.#withMutation(() => leaseReadyNode(store, {
      hash,
      leaseDurationMs,
    }));
  }

  async #prepareDirectUpload(
    store: Parameters<typeof leaseReadyNode>[0],
    hash: string,
    storedBytes: number,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const prepared = await this.#withMutation(() => prepareCanonicalNodeUpload(store, {
      hash,
      storedBytes,
      leaseDurationMs,
      createIdentifiers: () => {
        const id = crypto.randomUUID();
        return { uploadId: id, temporaryObjectKey: `_uploads/v1/${id}` };
      },
    }));
    if (prepared.kind === "ready") return prepared.result;
    if (prepared.replacedTemporaryObjectKey !== undefined) {
      await store.bucket.delete(prepared.replacedTemporaryObjectKey);
    }
    const upload = await this.#uploadPresigner().signPut(
      prepared.session.temporaryObjectKey,
      prepared.session.storedBytes,
    );
    return {
      hash,
      ready: false,
      status: "upload_required",
      uploadId: prepared.session.uploadId,
      expiresAt: prepared.session.expiresAt,
      upload,
    };
  }

  async #finalizeDirectUpload(
    store: Parameters<typeof leaseReadyNode>[0],
    hash: string,
    uploadId: string,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const uploadKey = `${store.stackId}\0${store.tenantId}\0${hash}`;
    const admission = await this.#withMutation(async () => {
      const active = this.#activeUploads.get(uploadKey);
      if (active !== undefined) return { kind: "join" as const, active };
      const admitted = await admitCanonicalNodeUploadFinalization(store, {
        hash,
        uploadId,
        leaseDurationMs,
      });
      if (admitted.kind === "ready") return admitted;
      const newActive = deferredUpload();
      this.#activeUploads.set(uploadKey, newActive);
      return { kind: "upload" as const, session: admitted.session, active: newActive };
    });
    if (admission.kind === "ready") return admission.result;
    if (admission.kind === "join") {
      const outcome = await admission.active.completion;
      if (!outcome.ok) throw outcome.error;
      return this.#withMutation(() => leaseReadyNode(store, { hash, leaseDurationMs }));
    }

    try {
      const parsed = await this.#publishTemporaryUpload(store, admission.session);
      const result = await this.#withMutation(() => finalizeCanonicalNodeLease(store, {
        hash,
        storedBytes: admission.session.storedBytes,
        leaseDurationMs: admission.session.leaseDurationMs,
      }, parsed));
      await store.bucket.delete(admission.session.temporaryObjectKey);
      admission.active.settle({ ok: true });
      return result;
    } catch (error) {
      await Promise.allSettled([
        store.bucket.delete(admission.session.temporaryObjectKey),
        this.#withMutation(() => deleteCanonicalNodeUploadSession(store, hash, admission.session.uploadId)),
      ]);
      admission.active.settle({ ok: false, error });
      throw error;
    } finally {
      if (this.#activeUploads.get(uploadKey) === admission.active) {
        this.#activeUploads.delete(uploadKey);
      }
    }
  }

  async #publishTemporaryUpload(
    store: Parameters<typeof leaseReadyNode>[0],
    session: { readonly hash: string; readonly temporaryObjectKey: string; readonly storedBytes: number },
  ): Promise<ParsedUploadedNodeMetadata> {
    const temporary = await store.bucket.get(session.temporaryObjectKey);
    if (temporary === null || temporary.body === undefined || temporary.size !== session.storedBytes) {
      throw new NodeOpError(412, NodeOpErrorCodes.UPLOAD_INCOMPLETE, "Canonical upload is incomplete");
    }
    const [uploadStream, parseStream] = (temporary.body as unknown as ReadableStream<Uint8Array>).tee();
    const parsing = parseUploadedBody(parseStream, session.storedBytes, store.limits);
    const finalKey = stackCanonicalNodeKey(store.stackId, store.tenantId, session.hash);
    const uploading = store.bucket.put(
      finalKey,
      uploadStream as unknown as Parameters<R2Bucket["put"]>[1],
      { sha256: session.hash, onlyIf: { etagDoesNotMatch: "*" } },
    );
    try {
      const [parsed, stored] = await Promise.all([parsing, uploading]);
      if (stored === null) {
        const existing = await store.bucket.head(finalKey);
        const checksum = existing?.checksums.sha256;
        const actualHash = checksum === undefined ? undefined : hashToHex(new Uint8Array(checksum));
        if (existing?.size !== session.storedBytes || actualHash !== session.hash) {
          throw new NodeOpError(409, NodeOpErrorCodes.CONFLICT, "Canonical object conflicts with an existing object");
        }
      }
      return parsed;
    } catch (error) {
      await Promise.allSettled([parsing, uploading]);
      if (error instanceof NodeOpError) throw error;
      throw new NodeOpError(422, NodeOpErrorCodes.DIGEST_MISMATCH, "Canonical node checksum does not match its hash");
    }
  }

  #uploadPresigner(): R2UploadPresigner {
    const accountId = this.#env.CAS_R2_ACCOUNT_ID;
    const bucketName = this.#env.CAS_R2_BUCKET_NAME;
    const accessKeyId = this.#env.CAS_R2_ACCESS_KEY_ID;
    const secretAccessKey = this.#env.CAS_R2_SECRET_ACCESS_KEY;
    if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
      throw new NodeOpError(503, NodeOpErrorCodes.STORAGE, "Direct canonical upload is not configured");
    }
    const configuredExpiry = Number(this.#env.CAS_UPLOAD_URL_EXPIRY_SECONDS ?? "300");
    return new R2UploadPresigner({
      accountId,
      bucketName,
      accessKeyId,
      secretAccessKey,
      expiresInSeconds: configuredExpiry,
    });
  }

  /** Store the canonical body in R2 while tee-parsing its metadata from the
   *  exact bytes being stored. Returns the parsed header so the finalize step
   *  can commit D1 metadata without a post-upload R2 read-back. */
  async #streamCanonicalUpload(
    store: Parameters<typeof leaseReadyNode>[0],
    plan: CanonicalNodeUploadPlan,
    body: ReadableStream<Uint8Array>,
    declaredLength: number,
  ): Promise<ParsedUploadedNodeMetadata> {
    const abort = new AbortController();
    const prepared = typeof FixedLengthStream === "undefined"
      ? { stream: body, pumping: Promise.resolve() }
      : fixedLengthBody(body, declaredLength, abort);
    const [uploadStream, parseStream] = prepared.stream.tee();
    const uploading = uploadCanonicalNode(store, plan, uploadStream);
    const parsing = parseUploadedBody(parseStream, declaredLength, store.limits);
    try {
      const [parsed] = await Promise.all([parsing, uploading, prepared.pumping]);
      return parsed;
    } catch (error) {
      abort.abort(error);
      await Promise.allSettled([parsing, uploading, prepared.pumping]);
      throw error;
    }
  }

  async #handleRead(request: Request, store: Parameters<typeof leaseReadyNode>[0]): Promise<Response> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const content = await readNodeContent({
      repository: new CloudflareNodeReadRepository(store.db, store.bucket, store.timing),
      scope: { stackId: store.stackId, tenantId: store.tenantId },
      hash,
      rangeHeader: request.headers.get("Range"),
    });
    if (content === null) {
      return Response.json({ error: NodeOpErrorCodes.NOT_FOUND, message: `Node ${hash} not found or not ready` }, { status: 404 });
    }
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Length": String(content.range === undefined
        ? content.contentSize
        : content.range.end - content.range.start + 1),
      "Content-Type": content.contentType,
    });
    if (content.range !== undefined) {
      headers.set("Content-Range", `bytes ${content.range.start}-${content.range.end}/${content.contentSize}`);
    }
    return new Response(content.body, {
      status: content.range === undefined ? 200 : 206,
      headers,
    });
  }

  async #handleMetadata(request: Request, store: Parameters<typeof leaseReadyNode>[0]): Promise<Response> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const result = await readNodeMetadata({
      repository: new CloudflareNodeReadRepository(store.db, store.bucket, store.timing),
      scope: { stackId: store.stackId, tenantId: store.tenantId },
      hash,
    });
    if (result === null) {
      return Response.json({ error: NodeOpErrorCodes.NOT_FOUND, message: `Node ${hash} not found` }, { status: 404 });
    }
    return jsonResponse(result);
  }

  async #handleGc(request: Request, store: Parameters<typeof leaseReadyNode>[0]): Promise<unknown> {
    const body = await request.json().catch(() => null) as { maxNodes?: number } | null;
    const maxNodes = body?.maxNodes ?? DEFAULT_GC_MAX_NODES;
    if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
      throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "maxNodes must be a positive integer");
    }
    return this.#withMutation(() => collectExpiredUnreferencedNodes({
      repository: new CloudflareNodeGcRepository(store.db, store.bucket),
      scope: { stackId: store.stackId, tenantId: store.tenantId },
      maxNodes,
    }));
  }

  async #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Canonicalize the caller update and forward one command to the domain DO. */
  async #forwardRootRefs(
    request: Request,
    stackId: string,
    tenantId: string,
  ): Promise<Response> {
    let refDomain: string;
    let canonical;
    try {
      refDomain = requireHeader(request, "X-CAS-Ref-Domain");
      const text = await request.text();
      const parsed = parseRootRefsBody(text);
      canonical = await canonicalizeRootRefsUpdate({ ...parsed, refDomain });
    } catch (error) {
      if (error instanceof RootRefsValidationError) {
        return Response.json({ error: error.code, message: error.message }, { status: error.status });
      }
      return Response.json(
        { error: RootRefsErrorCodes.INVALID_REQUEST, message: "root refs update is invalid" },
        { status: 400 },
      );
    }
    const domainId = this.#env.CAS_DOMAIN_DO.idFromName(canonicalComposite(stackId, refDomain));
    const stub = this.#env.CAS_DOMAIN_DO.get(domainId);
    const response = await stub.fetch("https://domain.internal/update", {
      method: "POST",
      headers: {
        "X-CAS-Stack-Id": stackId,
        "X-CAS-Tenant-Id": tenantId,
        "X-CAS-Ref-Domain": refDomain,
      },
      body: JSON.stringify({
        requestId: canonical.requestId,
        changes: Object.fromEntries(canonical.entries),
      }),
    });
    // Pass the domain DO's response through. The workers-types/DOM global
    // Response types disagree structurally; the runtime value is the same.
    return response as unknown as Response;
  }
}

function parseRootRefsLimit(value: string | null): number {
  if (value === null) return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "root refs limit must be between 1 and 200");
  }
  return limit;
}

function parseRootRefsCursor(value: string | null): string {
  if (value === null) return "";
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "root refs cursor is invalid");
  }
  return value;
}

function deferredUpload(): ActiveUpload {
  let settle!: (outcome: UploadOutcome) => void;
  const completion = new Promise<UploadOutcome>((resolve) => {
    settle = resolve;
  });
  return { completion, settle };
}

function fixedLengthBody(
  body: ReadableStream<Uint8Array>,
  declaredLength: number,
  abort: AbortController,
): { stream: ReadableStream<Uint8Array>; pumping: Promise<void> } {
  const fixed = new FixedLengthStream(declaredLength);
  const pumping = body.pipeTo(fixed.writable, { signal: abort.signal });
  return { stream: fixed.readable, pumping };
}

/** Parse the canonical header/refs from a tee branch of the bytes being
 *  uploaded. Only the bounded prefix is consumed; the replayable remainder is
 *  cancelled so the R2 upload branch drains freely. Errors map like the old
 *  post-upload read-back inspection did. */
async function parseUploadedBody(
  stream: ReadableStream<Uint8Array>,
  declaredLength: number,
  limits: Parameters<typeof parseCanonicalNodeStream>[2],
): Promise<ParsedUploadedNodeMetadata> {
  try {
    const parsed = await parseCanonicalNodeStream(stream, declaredLength, limits);
    await parsed.body.cancel("Canonical prefix parsed; R2 upload consumes the rest")
      .catch(() => undefined);
    return {
      contentSize: parsed.contentSize,
      contentType: parsed.contentType,
      refs: parsed.refs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NodeOpError(
      message.includes("too large") ? 413 : 400,
      NodeOpErrorCodes.INVALID_REQUEST,
      message,
    );
  }
}

function cancelBody(body: ReadableStream<Uint8Array>, reason: string): void {
  void body.cancel(reason).catch(() => undefined);
}

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value || value.length === 0) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, `missing ${name}`);
  }
  return value;
}
