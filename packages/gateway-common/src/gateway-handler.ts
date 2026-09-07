/**
 * Cloud-neutral UniDocs API Gateway routing.
 *
 * HTTP proxy that routes requests to document type workers based on a
 * caller-supplied registry lookup, and allowlist-proxies public CAS routes
 * to the CAS worker/service.
 *
 * Identity:
 *   Public tenantId comes from the URL path.
 *   The identity resolver authenticates the user and authorizes that tenant.
 *
 * Internal auth uses short-lived capabilities for Doc and CAS services.
 */

import type { HttpFetcher } from "@unicas/tenant-client";
import { casRoutes as canonicalCasRoutes } from "@unicas/tenant-protocol";
import { matchGatewayRoute } from "@unidocs/protocol-gateway";
import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import {
  docRoutes,
  httpCallEvent,
  httpCallFailure,
  noopObserver,
  parseCommitReceipt,
  pickObservedHeaders,
  readObservedBody,
} from "@unidocs/protocol-doc";
import type { DocOperation, HttpCallInput, ObserveFn } from "@unidocs/protocol-doc";
import {
  GatewayDirectoryConflictError,
  type GatewayDocumentDirectory,
  type GatewayDocumentRecord,
} from "./document-directory.js";
import type { GatewayIdentityResolver } from "./identity.js";
import { casCapabilityPolicy, docCapabilityPolicy } from "./capability-policy.js";
import type { GatewayCapabilityAuthority } from "./capability-authority.js";

export interface GatewayHandlerConfig {
  capabilityAuthority: GatewayCapabilityAuthority;
  identityResolver: GatewayIdentityResolver;
  resolveDocService(docType: string): Promise<DocServiceRegistration | null>;
  casFetcher: HttpFetcher;
  directory: GatewayDocumentDirectory;
  /** Gateway-owned CAS exposure policy, applied after route matching. */
  isGatewayExposedCasRoute(route: GatewayCasRoute): boolean;
  casStackId: string;
  /**
   * Reject document uploads larger than this with 413, before touching the
   * body. Unset means unlimited — which is not "generous" but a crash: the
   * clone-source probe below parses the whole multipart body (twice over,
   * since it clones), so a large enough upload kills the Gateway process and
   * takes every other in-flight request with it.
   */
  maxUploadBytes?: number;
  generateId?(): string;
  now?(): number;
  /**
   * 每次 HTTP 调用一条事件:入站(我们提供的接口)与出站(CAS / doc worker)都记。
   * 默认 noop —— 现有调用方与单测行为不变;适配器注入 `consoleObserver`。
   */
  observe?: ObserveFn;
}

export interface DocServiceRegistration {
  readonly serviceId: string;
  readonly url: string;
  readonly audience: string;
}

const EDITOR_METHODS = new Set([
  "apply", "query", "export", "history", "rollback",
  "snapshot", "ir", "commit-status", "commit-recover",
]);

const OPERATOR_METHODS = new Set(["run", "reset"]);
const MUTATING_METHODS = new Set(["apply", "rollback", "run", "reset"]);

/**
 * A clone request carries a single `sourceId` field and nothing else, so it
 * cannot plausibly exceed this. Anything larger is a file upload, and probing
 * it for `sourceId` would mean buffering the entire body to learn something
 * its size already answers.
 */
const MAX_CLONE_REQUEST_BYTES = 64 * 1024;

const CAS_FORWARDED_HEADERS = [
  "Content-Type",
  "Content-Length",
  "X-CAS-Lease-Duration",
];

export function createGatewayHandler(
  cfg: GatewayHandlerConfig,
): (request: Request) => Promise<Response> {
  validateInternalAuthConfig(cfg);
  const generateId = cfg.generateId ?? (() => crypto.randomUUID());
  const now = cfg.now ?? (() => Date.now());

  const observe = cfg.observe ?? noopObserver;

  const handleInner = async function (request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 3 || parts[0] !== "tenants") {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* or /tenants/{tenantId}/cas/* endpoints",
      }, { status: 404 });
    }

    const tenantId = parts[1];
    const namespace = parts[2];
    const identity = await cfg.identityResolver.resolve(request, tenantId);
    if (!identity) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    if (identity.tenantId !== tenantId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    if (namespace === "cas") {
      const matched = matchGatewayRoute(request.method, url.pathname);
      const casRoute = matched?.kind === "cas" ? matched.route : null;
      if (casRoute === null || !cfg.isGatewayExposedCasRoute(casRoute)) {
        return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
      }
      const policy = casCapabilityPolicy(casRoute);
      if (policy.requiresTenantAdmin && !identity.canManageTenant) {
        return Response.json({ error: "Tenant administration required" }, { status: 403 });
      }
      const headers = new Headers();
      for (const name of CAS_FORWARDED_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      // Same reason as the doc path below: without this the runtime's fetch
      // defaults to "gzip, deflate, br", the CAS service compresses, and the
      // client transparently DECOMPRESSES the body while leaving
      // `content-encoding: br` on the Response we hand back untouched. The
      // caller then tries to decode already-plain bytes and the stream dies
      // with `TypeError: terminated`.
      headers.set("Accept-Encoding", "identity");
      headers.set("Authorization", await cfg.capabilityAuthority.issueCasOperation(casRoute));
      const targetUrl = new URL(request.url);
      targetUrl.pathname = casTargetPath(casRoute, cfg.casStackId);
      // 出站:网关 -> CAS。第三方调用里最关键的一条,CAS 一慢或一错,用户看到的
      // 就是文档打不开。
      const casInput: HttpCallInput = {
        dir: "out",
        target: "cas",
        op: casRoute.operation,
        method: request.method,
        durationMs: 0,
        tenantId,
        url: targetUrl.toString(),
        requestHeaders: pickObservedHeaders(headers),
      };
      const casStarted = Date.now();
      try {
        const casResponse = await cfg.casFetcher.fetch(new Request(targetUrl, {
          method: request.method,
          headers,
          body: request.body,
          duplex: "half",
        } as RequestInit));
        const finished = { ...casInput, durationMs: Date.now() - casStarted };
        const detail = casResponse.status >= 400
          ? await readObservedBody(casResponse.clone())
          : undefined;
        observe(httpCallEvent(finished, casResponse.status, detail));
        return casResponse;
      } catch (err) {
        observe(httpCallFailure({ ...casInput, durationMs: Date.now() - casStarted }, err));
        throw err;
      }
    }

    if (namespace !== "docs") {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* or /tenants/{tenantId}/cas/* endpoints",
      }, { status: 404 });
    }

    const docType = parts[3];
    const docId = parts[4];
    const method = parts[5];

    if (!docType) {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* endpoints",
      }, { status: 404 });
    }

    const docService = await cfg.resolveDocService(docType);
    if (!docService) {
      return Response.json({
        error: `Unknown document type: ${docType}`,
      }, { status: 404 });
    }

    if (!docId) {
      if (request.method === "POST") {
        const declaredLength = Number(request.headers.get("content-length"));
        const hasLength = Number.isFinite(declaredLength) && declaredLength > 0;
        if (cfg.maxUploadBytes !== undefined && hasLength && declaredLength > cfg.maxUploadBytes) {
          return Response.json({
            error: `Upload is ${declaredLength} bytes, over the ${cfg.maxUploadBytes}-byte limit`,
          }, { status: 413 });
        }
        const cloneSource = hasLength && declaredLength > MAX_CLONE_REQUEST_BYTES
          ? null
          : await readCloneSource(request);
        if (cloneSource instanceof Response) return cloneSource;
        if (cloneSource) {
          return cloneDocument({
            request,
            cfg,
            docService,
            tenantId,
            docType,
            sourceDocId: cloneSource,
            generateId,
            now,
          });
        }
        return createDocument({
          request,
          cfg,
          docService,
          tenantId,
          docType,
          generateId,
          now,
        });
      }
      if (request.method === "GET") {
        return listDocuments(cfg.directory, tenantId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const record = await cfg.directory.get(tenantId, docId);
    if (!record || record.docType !== docType) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    if (record.serviceId !== docService.serviceId) {
      return Response.json({
        error: "Document service is unavailable",
      }, { status: 503 });
    }

    if (!method && request.method === "GET") {
      const resolved = record.state === "creating"
        ? await reconcileCreatingDocument(cfg, docService, record, now())
        : null;
      return documentStatus(resolved ?? record);
    }

    if (record.state !== "ready") {
      return Response.json({
        error: `Document is ${record.state}`,
        docId: record.docId,
        state: record.state,
      }, { status: 409 });
    }

    if (method && (EDITOR_METHODS.has(method) || OPERATOR_METHODS.has(method))) {
      const operation = docOperation(method);
      const response = await forwardToWorker(
        request,
        cfg,
        docService.url,
        tenantId,
        docType,
        docService,
        record.sessionId,
        operation,
      );
      if (response.ok && (method === "apply" || method === "rollback" || method === "commit-recover")) {
        return synchronizeCommittedVersion(response, cfg.directory, tenantId, docId, now(), method === "commit-recover");
      }
      if (response.ok && MUTATING_METHODS.has(method)) {
        await cfg.directory.touch(tenantId, docId, now());
      }
      return response;
    }

    return Response.json({
      error: `Unknown endpoint: ${method}`,
    }, { status: 404 });
  };

  // 入站计时。这是唯一的外部入口,所以"我们对外提供的每个接口"都从这里过一遍。
  //
  // 时长用 Date.now() 而不是 cfg.now:后者是目录时间戳的来源,测试里常被替换成
  // 固定时钟,拿它算耗时会恒为 0。
  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const matched = matchGatewayRoute(request.method, url.pathname);
    const input: HttpCallInput = {
      dir: "in",
      target: "gateway",
      ...(matched
        ? { op: matched.kind === "cas" ? `cas:${matched.route.operation}` : matched.operation }
        : {}),
      method: request.method,
      durationMs: 0,
      ...(parts[0] === "tenants" && parts[1] ? { tenantId: parts[1] } : {}),
      ...(parts[2] === "docs" && parts[3] ? { docType: parts[3] } : {}),
      url: url.toString(),
      requestHeaders: pickObservedHeaders(request.headers),
    };
    try {
      const response = await handleInner(request);
      const finished = { ...input, durationMs: Date.now() - started };
      // 入站**不读响应体**:那是我们自己合成的错误体,而它的成因已经由对应的
      // 出站事件(带上游响应体)或 status 0 事件(带异常栈)记下了。再记一遍
      // 只是把同一件事写两次。
      observe(httpCallEvent(finished, response.status));
      return response;
    } catch (err) {
      observe(httpCallFailure({ ...input, durationMs: Date.now() - started }, err));
      throw err;
    }
  };
}

async function forwardToWorker(
  request: Request,
  cfg: GatewayHandlerConfig,
  workerUrl: string,
  tenantId: string,
  docType: string,
  docService: DocServiceRegistration,
  sessionId: string,
  operation: DocOperation,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const targetPath = docRoutes[operation]({ tenantId, sessionId });
  const targetUrl = `${workerUrl}${targetPath}${originalUrl.search}`;

  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const { deadlineSeconds } = docCapabilityPolicy(operation, tenantId, sessionId);
  const operationSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(deadlineSeconds * 1000),
  ]);
  const credentials = await cfg.capabilityAuthority.issueDocOperation({
    operation,
    docType,
    docAudience: docService.audience,
    tenantId,
    sessionId,
  });
  headers.set("Authorization", credentials.authorization);
  if (credentials.delegatedCasCapability) {
    headers.set("X-UniDocs-CAS-Capability", credentials.delegatedCasCapability);
  }
  headers.set("Accept-Encoding", "identity");

  // 出站:网关 -> doc worker。
  const observe = cfg.observe ?? noopObserver;
  const callInput: HttpCallInput = {
    dir: "out",
    target: `doc:${docType}`,
    op: operation,
    method: operation === "create" ? "PUT" : request.method,
    durationMs: 0,
    tenantId,
    docType,
    url: targetUrl,
    requestHeaders: pickObservedHeaders(headers),
  };
  const started = Date.now();
  try {
    const response = await fetch(targetUrl, {
      method: operation === "create" ? "PUT" : request.method,
      headers,
      body: request.body,
      duplex: "half",
      signal: operationSignal,
    } as RequestInit);
    const finished = { ...callInput, durationMs: Date.now() - started };
    const detail = response.status >= 400
      ? await readObservedBody(response.clone())
      : undefined;
    observe(httpCallEvent(finished, response.status, detail));
    return response;
  } catch (err) {
    // 连不上 / 超时:这里是真正的"没拿到响应",记 status 0。返回给调用方的 502
    // 是我们合成的,如果只按响应码记,这条会被误记成一次正常的 502 响应。
    observe(httpCallFailure({ ...callInput, durationMs: Date.now() - started }, err));
    return Response.json({
      error: upstreamFailureMessage(err, deadlineSeconds),
    }, { status: 502 });
  }
}

/**
 * 转发失败时合成给调用方的那句话。
 *
 * 连不上和超时是两件事,必须说成两件事。线上有过一次 237 MiB 的 create 超时,
 * 浏览器收到 `Document worker unreachable: TimeoutError`,而日志显示 doc
 * service 一直好好的 —— 它在整个窗口里收字节,我们放弃之后它还继续把 CAS
 * root-refs 提交完(200)才停。"unreachable" 那个词直接把排查引向了网络连通性。
 *
 * 所以超时这一支要说清两件事:计时的是**我们**(带上 deadline,读的人才知道去
 * 哪儿调),以及上游**可能还在跑**(于是可能留下半截状态,值得去查一眼)。
 *
 * 状态码仍是 502。504 更准确,但那是独立的一次改动 —— `observe.test.ts` 把
 * "合成失败"钉在 502 上,而那条测试要表达的是另一件事(连不上不能被记成一次
 * 正常的 502 响应),不该被这里顺手改掉。
 */
export function upstreamFailureMessage(err: unknown, deadlineSeconds: number): string {
  // `AbortSignal.timeout()` 触发的是 TimeoutError;调用方自己断开是 AbortError,
  // 那种情况计时的不是我们,不该说成超时。
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `Document worker timed out after ${deadlineSeconds}s (gateway operation deadline). `
      + "The upstream request may still be running and may have left partial state.";
  }
  return `Document worker unreachable: ${err}`;
}

async function listDocuments(
  directory: GatewayDocumentDirectory,
  tenantId: string,
  docType: string,
): Promise<Response> {
  const records = await directory.list(tenantId, docType);

  return Response.json({
    success: true,
    data: records.map((rec) => ({
      doc_id: rec.docId,
      doc_type: rec.docType,
      owner_id: rec.tenantId,
      version: rec.version,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    })),
    count: records.length,
  });
}

interface CreateDocumentContext {
  request: Request;
  cfg: GatewayHandlerConfig;
  docService: DocServiceRegistration;
  tenantId: string;
  docType: string;
  generateId(): string;
  now(): number;
  requestedDocId?: string;
  createMethod?: string;
}

interface CloneDocumentContext extends Omit<CreateDocumentContext, "requestedDocId" | "createMethod"> {
  sourceDocId: string;
}

async function cloneDocument(context: CloneDocumentContext): Promise<Response> {
  const {
    request,
    cfg,
    docService,
    tenantId,
    docType,
    sourceDocId,
    generateId,
    now,
  } = context;
  const source = await cfg.directory.get(tenantId, sourceDocId);
  if (!source || source.docType !== docType || source.tenantId !== tenantId) {
    return Response.json({ error: "Source document not found" }, { status: 404 });
  }
  if (source.serviceId !== docService.serviceId) {
    return Response.json({ error: "Document service is unavailable" }, { status: 503 });
  }
  if (source.state !== "ready") {
    return Response.json({
      error: `Source document is ${source.state}`,
      state: source.state,
    }, { status: 409 });
  }

  const snapshot = await forwardToWorker(
    new Request(request.url, { method: "GET" }),
    cfg,
    docService.url,
    tenantId,
    docType,
    docService,
    source.sessionId,
    "snapshot",
  );
  if (!snapshot.ok) return snapshot;

  const sourceSnapshot = await snapshot.json().catch(() => null) as {
    success?: unknown;
    hash?: unknown;
    version?: unknown;
  } | null;
  if (sourceSnapshot?.success !== true
    || typeof sourceSnapshot.hash !== "string"
    || !Number.isSafeInteger(sourceSnapshot.version)
    || (sourceSnapshot.version as number) < 1) {
    return Response.json({ error: "Document service returned an invalid snapshot" }, { status: 502 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["Idempotency-Key", "X-Doc-Id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const initRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      hash: sourceSnapshot.hash,
      sourceVersion: sourceSnapshot.version,
    }),
  });
  return createDocument({
    request: initRequest,
    cfg,
    docService,
    tenantId,
    docType,
    generateId,
    now,
    createMethod: "init-from-hash",
  });
}

async function readCloneSource(request: Request): Promise<string | Response | null> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  let source: FormDataEntryValue | unknown = null;

  if (contentType.startsWith("application/json")) {
    const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !("sourceId" in body)) return null;
    source = body.sourceId;
  } else if (contentType.startsWith("multipart/form-data")) {
    const form = await request.clone().formData().catch(() => null);
    if (!form || !form.has("sourceId")) return null;
    if (form.has("file")) {
      return Response.json({ error: "file and sourceId are mutually exclusive" }, { status: 400 });
    }
    source = form.get("sourceId");
  } else {
    return null;
  }

  if (typeof source !== "string" || source.trim().length === 0) {
    return Response.json({ error: "sourceId must be a non-empty string" }, { status: 400 });
  }
  return source.trim();
}

async function createDocument(context: CreateDocumentContext): Promise<Response> {
  const {
    request,
    cfg,
    docService,
    tenantId,
    docType,
    generateId,
    now,
    requestedDocId,
    createMethod,
  } = context;
  const headerDocId = request.headers.get("X-Doc-Id")?.trim();
  const docId = (requestedDocId ?? headerDocId) || generateId();
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim()
    || (requestedDocId || headerDocId ? `doc:${docId}` : `request:${docId}`);

  let reservation;
  try {
    reservation = await cfg.directory.reserve({
      docId,
      tenantId,
      docType,
      serviceId: docService.serviceId,
      sessionId: generateId(),
      idempotencyKey,
      requestedDocId: requestedDocId ?? headerDocId ?? null,
      now: now(),
    });
  } catch (err) {
    if (err instanceof GatewayDirectoryConflictError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const record = reservation.record;
  if (!reservation.created) {
    if (record.state === "ready") {
      return Response.json({
        success: true,
        docId: record.docId,
        version: record.version,
        state: record.state,
      });
    }
    if (record.state === "creating") {
      const reconciled = await reconcileCreatingDocument(
        cfg,
        docService,
        record,
        now(),
      );
      if (reconciled) {
        return Response.json({
          success: true,
          docId: reconciled.docId,
          version: reconciled.version,
          state: reconciled.state,
        });
      }
      return Response.json({
        success: true,
        docId: record.docId,
        state: record.state,
      }, { status: 202 });
    }
    return Response.json({
      success: false,
      docId: record.docId,
      state: record.state,
      error: record.error,
    }, { status: 409 });
  }

  const upstream = await forwardToWorker(
    request,
    cfg,
    docService.url,
    tenantId,
    docType,
    docService,
    record.sessionId,
    createMethod === "init-from-hash" ? "initFromHash" : "create",
  );
  const body = await upstream.clone().json().catch(() => null) as {
    success?: unknown;
    version?: unknown;
    error?: unknown;
  } | null;

  if (upstream.ok && body?.success === true && Number.isSafeInteger(body.version)) {
    const ready = await cfg.directory.markReady(
      tenantId,
      record.docId,
      body.version as number,
      now(),
    );
    return Response.json({
      success: true,
      docId: ready.docId,
      version: ready.version,
      state: ready.state,
    }, {
      status: upstream.status,
    });
  }

  if (upstream.status < 500) {
    await cfg.directory.markFailed(
      tenantId,
      record.docId,
      String(body?.error ?? upstream.statusText),
      now(),
    );
  }
  return upstream;
}

function documentStatus(record: GatewayDocumentRecord): Response {
  return Response.json({
    success: true,
    data: {
      doc_id: record.docId,
      doc_type: record.docType,
      state: record.state,
      version: record.version,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}

async function reconcileCreatingDocument(
  cfg: GatewayHandlerConfig,
  docService: DocServiceRegistration,
  record: GatewayDocumentRecord,
  timestamp: number,
): Promise<GatewayDocumentRecord | null> {
  let response: Response;
  try {
    response = await forwardToWorker(
      new Request("https://gateway.internal/status", { method: "GET" }),
      cfg,
      docService.url,
      record.tenantId,
      record.docType,
      docService,
      record.sessionId,
      "status",
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const status = await response.json().catch(() => null) as {
    exists?: unknown;
    version?: unknown;
  } | null;
  if (status?.exists !== true || !Number.isSafeInteger(status.version) || (status.version as number) < 1) return null;
  return cfg.directory.markReady(
    record.tenantId,
    record.docId,
    status.version as number,
    timestamp,
  );
}

async function synchronizeCommittedVersion(
  response: Response, directory: GatewayDocumentDirectory, tenantId: string, docId: string, observedAt: number, requireReceipt: boolean,
): Promise<Response> {
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) throw new Error("Missing commit response");
    const bytes = new Uint8Array(16_384);
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > bytes.length) throw new Error("Commit response exceeds metadata limit");
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const result = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    let version: number;
    if (result?.receipt !== undefined) {
      const receipt = parseCommitReceipt(result.receipt);
      if (receipt.state !== "committed") return response;
      version = receipt.version;
    } else {
      if (requireReceipt || result?.success !== true || !Number.isSafeInteger(result.version) || result.version < 1) {
        throw new Error("Invalid committed version response");
      }
      version = result.version;
    }
    await directory.advanceVersion(tenantId, docId, version, observedAt);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("X-UniDocs-Directory-Sync", "pending");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

function docOperation(method: string): DocOperation {
  if (method === "commit-status") return "commitStatus";
  if (method === "commit-recover") return "commitRecover";
  if (method === "apply"
    || method === "query"
    || method === "export"
    || method === "history"
    || method === "rollback"
    || method === "snapshot"
    || method === "ir"
    || method === "run"
    || method === "reset") {
    return method;
  }
  throw new TypeError(`Unsupported Doc operation: ${method}`);
}

function validateInternalAuthConfig(cfg: GatewayHandlerConfig): void {
  if (!cfg.capabilityAuthority) throw new TypeError("Gateway requires a capability authority");
  if (!cfg.casStackId) throw new TypeError("Gateway requires a CAS stack id");
}

function casTargetPath(route: GatewayCasRoute, stackId: string): string {
  switch (route.operation) {
    case "readContent":
      return canonicalCasRoutes.readContent({ stackId, tenantId: route.tenantId, hash: route.hash });
    case "readMetadata":
      return canonicalCasRoutes.readMetadata({ stackId, tenantId: route.tenantId, hash: route.hash });
    case "lease":
      return canonicalCasRoutes.lease({ stackId, tenantId: route.tenantId, hash: route.hash });
    case "usage":
      return canonicalCasRoutes.usage({ stackId, tenantId: route.tenantId });
    case "gc":
      return canonicalCasRoutes.gc({ stackId, tenantId: route.tenantId });
  }
}
