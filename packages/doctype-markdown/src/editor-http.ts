import type { SBlob, SValue } from "@unidocs/protocol";
import { decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import {
  DoctypeProtocol, SValueContentType, isEditorContext, isStateSource, serviceFailure, serviceSuccess,
} from "@unidocs/protocol-doctype";
import type { Invocation, ServiceErrorCode, ServiceResult } from "@unidocs/protocol-doctype";
import { PlatformHmacError, verifyPlatformRequest } from "@unidocs/service-auth";
import type { PlatformHmacKey, PlatformNonceStore } from "@unidocs/service-auth";
import { MarkdownEditorService, MarkdownSchemaVersion, isChangeSet, isInvocation, isOperation } from "./editor-service.js";
import type { MarkdownEditorServiceOptions } from "./editor-service.js";

export const MarkdownEditorPaths = {
  probe: "/v1/editor/probe",
  init: "/v1/editor/init",
  apply: "/v1/editor/apply",
  snapshot: "/v1/editor/snapshot",
} as const;

export interface MarkdownCasAccess {
  readonly authorization: string;
  readonly mode: "ro" | "rw";
  readonly invocation: Invocation;
}

export interface MarkdownEditorHttpOptions {
  readonly origin: string;
  readonly platformId: string;
  readonly environment: string;
  readonly serviceId: string;
  readonly keys: () => readonly PlatformHmacKey[];
  readonly nonces: PlatformNonceStore;
  readonly authorizeCas: (access: MarkdownCasAccess) => Promise<boolean>;
  readonly loadSnapshot: (blob: SBlob, access: MarkdownCasAccess) => Promise<unknown>;
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
  readonly contexts?: Omit<MarkdownEditorServiceOptions, "loadSnapshot" | "now">;
}

export function createMarkdownEditorHandler(options: MarkdownEditorHttpOptions): (request: Request) => Promise<Response> {
  const service = new MarkdownEditorService({
    ...options.contexts,
    now: options.now ? () => options.now!() * 1000 : undefined,
    loadSnapshot: async () => { throw new Error("Request-scoped snapshot reader required"); },
  });
  const target = { origin: options.origin, paths: Object.values(MarkdownEditorPaths) };
  return async (request) => {
    try {
      const keys = options.keys().filter((key) => key.role === "editor"
        && key.platformId === options.platformId && key.environment === options.environment && key.serviceId === options.serviceId);
      const verified = await verifyPlatformRequest(request, {
        target, keys, nonces: options.nonces, now: options.now, maxBodyBytes: options.maxBodyBytes,
      });
      let body: unknown;
      try { body = decodeSValue(verified.body); } catch { return failure("invalid_request"); }
      const path = new URL(request.url).pathname;
      if (path === MarkdownEditorPaths.probe) {
        if (!hasShape(body, []) || verified.casAuthorization !== null) return failure("invalid_request");
        return response(serviceSuccess({
          protocol: DoctypeProtocol, serviceId: options.serviceId, role: "editor",
          docType: "markdown", schemaVersion: MarkdownSchemaVersion, operations: ["init", "apply", "snapshot"],
        }));
      }
      const fields = path === MarkdownEditorPaths.init ? ["invocation", "source"]
        : path === MarkdownEditorPaths.apply ? ["invocation", "context", "changeSet"] : ["invocation", "context"];
      if (!hasShape(body, fields) || !isInvocation(body.invocation) || body.invocation.docType !== "markdown") {
        return failure("invalid_request");
      }
      if (path === MarkdownEditorPaths.init) {
        if (!isStateSource(body.source, isOperation)) return failure("invalid_request");
        if (body.source.schemaVersion !== MarkdownSchemaVersion) return failure("unsupported_schema");
      } else if (!isEditorContext(body.context)
        || (path === MarkdownEditorPaths.apply && !isChangeSet(body.changeSet))) return failure("invalid_request");
      if (verified.casAuthorization === null) return failure("forbidden");
      const access: MarkdownCasAccess = {
        authorization: verified.casAuthorization, mode: path === MarkdownEditorPaths.apply ? "rw" : "ro",
        invocation: body.invocation,
      };
      let authorized: boolean;
      try { authorized = await options.authorizeCas(access); } catch { return failure("unavailable"); }
      if (authorized !== true) return failure("forbidden");
      const now = (options.now ?? (() => Date.now() / 1000))();
      if (!Number.isFinite(now) || verified.authentication.expiresAt + 30 <= now) return failure("unauthorized");
      if (path === MarkdownEditorPaths.init && isStateSource(body.source, isOperation)) {
        return response(await service.init(body.invocation, body.source, (blob) => options.loadSnapshot(blob, access)));
      }
      if (path === MarkdownEditorPaths.apply && isEditorContext(body.context) && isChangeSet(body.changeSet)) {
        return response(await service.apply(body.invocation, body.context, body.changeSet));
      }
      if (isEditorContext(body.context)) return response(await service.snapshot(body.invocation, body.context));
      return failure("invalid_request");
    } catch (error) {
      return failure(error instanceof PlatformHmacError ? error.code : "internal_error");
    }
  };
}

function hasShape(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function failure(code: ServiceErrorCode): Response {
  return response(serviceFailure(code, code));
}

function response<T>(result: ServiceResult<T>): Response {
  const status: Partial<Record<ServiceErrorCode, number>> = {
    unauthorized: 401, forbidden: 403, replay_detected: 409, sequence_conflict: 409,
    context_lost: 410, limit_exceeded: 413, unsupported_schema: 422, operation_rejected: 422,
    resource_unavailable: 503, unavailable: 503, internal_error: 500,
  };
  return new Response(new Uint8Array(encodeSValue(result as SValue)), {
    status: result.success ? 200 : status[result.error.code] ?? 400,
    headers: { "content-type": SValueContentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}