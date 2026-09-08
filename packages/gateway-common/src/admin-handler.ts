import { AdminDirectory, AdminDirectoryError, type AdminActor, type Administrator } from "./admin-directory.js";
import { AdminTypeDirectory } from "./admin-type-directory.js";
import { adminTypeEtag, type AdminTypeRegistration, type AdminUrlValidation } from "./admin-type-contract.js";

export interface AdminBrowserSession {
  readonly actor: AdminActor;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly authenticatedAt: number;
}

export interface AdminHandlerOptions {
  readonly origin: string;
  readonly directory: AdminDirectory;
  readonly currentSession: (request: Request) => Promise<AdminBrowserSession | null>;
  readonly types?: AdminTypeDirectory;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

const basePath = "/admin/api/v1";
const maxBodyBytes = 4096;
const recentAuthenticationMs = 15 * 60_000;

export function administratorEtag(record: Administrator): string {
  return `"admin-${record.adminId}-${record.revision}"`;
}

function publicAdministrator(record: Administrator) {
  return { adminId: record.adminId, email: record.email, bound: record.subject !== null, addedBy: record.addedBy, addedAt: record.addedAt, etag: administratorEtag(record) };
}

export function createAdminHandler(options: AdminHandlerOptions): (request: Request) => Promise<Response | null> {
  const origin = new URL(options.origin).origin;
  const now = options.now ?? Date.now;
  const requestId = options.requestId ?? (() => crypto.randomUUID());
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
    const id = requestId();
    const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": id, ...headers },
    });
    try {
      if (url.origin !== origin) throw new AdminDirectoryError("invalid_origin", 403);
      const session = await options.currentSession(request);
      const timestamp = now();
      if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= timestamp
        || !Number.isFinite(session.authenticatedAt) || session.authenticatedAt > timestamp) throw new AdminDirectoryError("login_required", 401);
      const self = await options.directory.current(session.actor);
      const path = url.pathname.slice(basePath.length);
      const typeTarget = /^\/document-types\/([a-z][a-z0-9-]{0,63})$/.exec(path);
      const validationTarget = /^\/url-validations\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
      const typeRoute = path === "/document-types" || path === "/url-validations" || typeTarget || validationTarget;
      if (typeRoute && !options.types) throw new AdminDirectoryError("type_directory_unavailable", 501);
      if (request.method === "GET") {
        if (path === "/audit-events") return respond({ items: await options.directory.listAudit(session.actor), presentationLimit: 100 });
        const change = /^\/changes\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
        if (change) {
          const result = await options.directory.authorized(session.actor, transaction => transaction.typeCommand(session.actor.adminId, change[1]!));
          if (!result) throw new AdminDirectoryError("change_not_found", 404);
          return respond({ data: publicType(result.registration) });
        }
        if (path === "/document-types") {
          const { limit, after } = listWindow(url);
          const enabled = url.searchParams.get("enabled");
          if (enabled !== null && enabled !== "true" && enabled !== "false") throw new AdminDirectoryError("invalid_enabled", 400);
          const query = (url.searchParams.get("q") ?? "").toLowerCase();
          if (query.length > 200) throw new AdminDirectoryError("invalid_query", 400);
          const records = (await options.types!.list(session.actor)).filter(record => record.docType > after
            && (enabled === null || record.enabled === (enabled === "true"))
            && `${record.docType} ${record.descriptor.displayName} ${record.baseUrl}`.toLowerCase().includes(query));
          const items = records.slice(0, limit);
          return respond({ items: items.map(publicType), nextCursor: records.length > limit ? btoa(JSON.stringify(items.at(-1)!.docType)) : null, consumption: "not-connected" });
        }
        if (typeTarget) {
          const record = await options.types!.get(session.actor, typeTarget[1]!);
          return respond({ data: publicType(record) }, 200, { ETag: adminTypeEtag(record) });
        }
        if (validationTarget) return respond({ data: publicValidation(await options.types!.lookupValidation(session.actor, validationTarget[1]!), timestamp) });
        if (path === "/session") return respond({ data: { ...publicAdministrator(self), csrfToken: session.csrfToken, expiresAt: session.expiresAt, reauthRequiredAt: session.authenticatedAt + recentAuthenticationMs } });
        if (path === "/administrators") {
          const limitValue = url.searchParams.get("limit") ?? "50";
          if (!/^[1-9][0-9]*$/.test(limitValue) || Number(limitValue) > 100) throw new AdminDirectoryError("invalid_limit", 400);
          const limit = Number(limitValue);
          const cursor = url.searchParams.get("cursor");
          let after = "";
          if (cursor) {
            try {
              const decoded: unknown = JSON.parse(atob(cursor));
              if (typeof decoded !== "string" || decoded.length > 254) throw new Error("invalid cursor");
              after = decoded;
            } catch { throw new AdminDirectoryError("invalid_cursor", 400); }
          }
          const records = (await options.directory.list(session.actor)).filter(record => record.email > after);
          const items = records.slice(0, limit);
          return respond({ items: items.map(record => ({ ...publicAdministrator(record), isSelf: record.adminId === self.adminId })), nextCursor: records.length > limit ? btoa(JSON.stringify(items.at(-1)!.email)) : null });
        }
        throw new AdminDirectoryError("not_found", 404);
      }
      if (request.method !== "POST" && request.method !== "DELETE" && request.method !== "PATCH") return respond({ error: { code: "method_not_allowed", requestId: id } }, 405, { Allow: "GET, POST, PATCH, DELETE" });
      if (request.headers.get("Origin") !== origin || !session.csrfToken || request.headers.get("X-CSRF-Token") !== session.csrfToken) throw new AdminDirectoryError("csrf_rejected", 403);
      if (timestamp - session.authenticatedAt >= recentAuthenticationMs) throw new AdminDirectoryError("reauthentication_required", 403);
      const key = request.headers.get("Idempotency-Key");
      if (!key) throw new AdminDirectoryError("idempotency_key_required", 400);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AdminDirectoryError("invalid_idempotency_key", 400);
      if (request.method === "POST" && path === "/url-validations") {
        const body = objectBody(await readAdminBody(request), ["baseUrl", "expectedDocType", "expectedConfigEtag"]);
        if (typeof body.baseUrl !== "string" || body.expectedDocType !== undefined && typeof body.expectedDocType !== "string"
          || body.expectedConfigEtag !== undefined && typeof body.expectedConfigEtag !== "string") throw new AdminDirectoryError("invalid_body", 400);
        const record = await options.types!.validate(session.actor, body as { baseUrl: string; expectedDocType?: string; expectedConfigEtag?: string }, key);
        return respond({ data: publicValidation(record, now()) }, 200, { Location: `${basePath}/url-validations/${record.validationId}` });
      }
      if (request.method === "POST" && path === "/document-types") {
        const body = objectBody(await readAdminBody(request), ["baseUrl", "enabled", "validationId"]);
        if (typeof body.baseUrl !== "string" || typeof body.enabled !== "boolean" || typeof body.validationId !== "string") throw new AdminDirectoryError("invalid_body", 400);
        const record = await options.types!.register(session.actor, body as { baseUrl: string; enabled: boolean; validationId: string }, key);
        return respond({ data: publicType(record) }, 201, { ETag: adminTypeEtag(record), Location: `${basePath}/document-types/${record.docType}` });
      }
      if (request.method === "PATCH" && typeTarget) {
        const etag = request.headers.get("If-Match");
        if (!etag) throw new AdminDirectoryError("precondition_required", 428);
        const body = objectBody(await readAdminBody(request), ["baseUrl", "enabled", "validationId", "reason"]);
        if (body.baseUrl !== undefined && typeof body.baseUrl !== "string" || body.enabled !== undefined && typeof body.enabled !== "boolean"
          || body.validationId !== undefined && typeof body.validationId !== "string" || typeof body.reason !== "string") throw new AdminDirectoryError("invalid_body", 400);
        const record = await options.types!.update(session.actor, typeTarget[1]!, etag, body as { baseUrl?: string; enabled?: boolean; validationId?: string; reason: string }, key);
        return respond({ data: publicType(record) }, 200, { ETag: adminTypeEtag(record) });
      }
      if (request.method === "POST" && path === "/administrators") {
        const body = await readAdminBody(request);
        if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== 1 || !("email" in body) || typeof body.email !== "string") {
          throw new AdminDirectoryError("invalid_body", 400);
        }
        const added = await options.directory.add(session.actor, body.email, key);
        return respond({ data: publicAdministrator(added) }, 201, { ETag: administratorEtag(added), Location: `${basePath}/administrators/${added.adminId}` });
      }
      const target = /^\/administrators\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
      if (request.method === "DELETE" && target) {
        const etag = request.headers.get("If-Match");
        if (!etag) throw new AdminDirectoryError("precondition_required", 428);
        const revisionMatch = new RegExp(`^"admin-${target[1]}-([1-9][0-9]*)"$`).exec(etag);
        if (!revisionMatch) throw new AdminDirectoryError("revision_conflict", 412);
        await options.directory.remove(session.actor, target[1]!, Number(revisionMatch[1]), key);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": id } });
      }
      throw new AdminDirectoryError("not_found", 404);
    } catch (error) {
      if (error instanceof AdminDirectoryError) return respond({ error: { code: error.code, requestId: id } }, error.status);
      return respond({ error: { code: "admin_unavailable", requestId: id } }, 503);
    }
  };
}

async function readAdminBody(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AdminDirectoryError("json_required", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AdminDirectoryError("invalid_body", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBodyBytes) { await reader.cancel(); throw new AdminDirectoryError("body_too_large", 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AdminDirectoryError("invalid_body", 400); }
}

function publicType(record: AdminTypeRegistration) {
  return {
    docType: record.docType, baseUrl: record.baseUrl, enabled: record.enabled, discovered: {
      displayName: record.descriptor.displayName, description: record.descriptor.description, formats: record.descriptor.formats,
      capabilities: record.descriptor.capabilities,
    }, checkedAt: record.checkedAt, updatedAt: record.updatedAt, etag: adminTypeEtag(record)
  };
}

function publicValidation(record: AdminUrlValidation, now: number) {
  return {
    validationId: record.validationId, baseUrl: record.baseUrl, state: record.expiresAt <= now ? "expired" : "passed",
    discovered: { docType: record.descriptor.docType, displayName: record.descriptor.displayName, formats: record.descriptor.formats, capabilities: record.descriptor.capabilities },
    checkedAt: record.checkedAt, expiresAt: record.expiresAt
  };
}

function objectBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new AdminDirectoryError("invalid_body", 400);
  return value as Record<string, unknown>;
}

function listWindow(url: URL): { limit: number; after: string } {
  const value = url.searchParams.get("limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100) throw new AdminDirectoryError("invalid_limit", 400);
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return { limit: Number(value), after: "" };
  try {
    if (cursor.length > 512) throw new Error("invalid cursor");
    const after: unknown = JSON.parse(atob(cursor));
    if (typeof after !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(after)) throw new Error("invalid cursor");
    return { limit: Number(value), after };
  } catch { throw new AdminDirectoryError("invalid_cursor", 400); }
}