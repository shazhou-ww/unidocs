import { AdminDirectory, AdminDirectoryError, type AdminActor, type AdminDirectoryTransaction } from "./admin-directory.js";
import { adminTypeEtag, matchDocTypeIdentity, normalizeDocTypeBaseUrl, parseDocTypeDescriptor, type AdminTypeRegistration, type AdminUrlValidation, type DocTypeDescriptor } from "./admin-type-contract.js";

export interface ApprovedDocTypeEndpoint {
  readonly baseUrl: string;
  readonly docType: string;
  readonly serviceId: string;
  readonly storageIdentity: string;
  readonly audience: string;
}

export class AdminTypeDirectory {
  private readonly approved: ReadonlyMap<string, ApprovedDocTypeEndpoint>;
  private readonly policyKey: string;
  constructor(private readonly directory: AdminDirectory, approved: readonly ApprovedDocTypeEndpoint[], private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    const entries = approved.map(entry => [normalizeDocTypeBaseUrl(entry.baseUrl), { ...entry }] as const).sort(([left], [right]) => left.localeCompare(right));
    if (new Set(entries.map(([url]) => url)).size !== entries.length) throw new Error("Duplicate approved type URL");
    this.approved = new Map(entries);
    this.policyKey = JSON.stringify(entries);
  }

  list(actor: AdminActor): Promise<AdminTypeRegistration[]> { return this.directory.authorized(actor, transaction => transaction.types()); }
  get(actor: AdminActor, docType: string): Promise<AdminTypeRegistration> {
    return this.directory.authorized(actor, transaction => {
      const record = transaction.type(docType);
      if (!record) throw new AdminDirectoryError("doctype_not_found", 404);
      return record;
    });
  }

  async validate(actor: AdminActor, input: { baseUrl: string; expectedDocType?: string; expectedConfigEtag?: string }, key: string = crypto.randomUUID()): Promise<AdminUrlValidation> {
    const baseUrl = normalizeDocTypeBaseUrl(input.baseUrl);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new AdminDirectoryError("invalid_idempotency_key", 400);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([actor.adminId, key])));
    const validationId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const requestFingerprint = JSON.stringify([baseUrl, input.expectedDocType, input.expectedConfigEtag, this.policyKey]);
    const match = (record: AdminUrlValidation) => {
      if (record.requestFingerprint !== requestFingerprint) throw new AdminDirectoryError("idempotency_conflict", 409);
      return record;
    };
    const initial = await this.directory.authorized(actor, transaction => {
      const previous = transaction.validation(validationId);
      if (previous) return { previous: match(previous), before: null };
      if ((input.expectedDocType === undefined) !== (input.expectedConfigEtag === undefined)) throw new AdminDirectoryError("invalid_validation_target", 400);
      const current = input.expectedDocType ? transaction.type(input.expectedDocType) : null;
      if (input.expectedDocType && !current) throw new AdminDirectoryError("doctype_not_found", 404);
      if (current && adminTypeEtag(current) !== input.expectedConfigEtag) throw new AdminDirectoryError("revision_conflict", 412);
      return { previous: null, before: current };
    });
    if (initial.previous) return initial.previous;
    const before = initial.before;
    const descriptor = await this.discover(baseUrl);
    if (before) matchDocTypeIdentity(before.descriptor, descriptor);
    const timestamp = this.now();
    const record: AdminUrlValidation = {
      validationId, requestFingerprint, actorId: actor.adminId, baseUrl, expectedDocType: before?.docType ?? null,
      expectedRevision: before?.revision ?? null, descriptor, checkedAt: new Date(timestamp).toISOString(), expiresAt: timestamp + 15 * 60_000, policyKey: this.policyKey
    };
    return this.directory.authorized(actor, transaction => {
      const previous = transaction.validation(validationId);
      if (previous) return match(previous);
      if (before && transaction.type(before.docType)?.revision !== before.revision) throw new AdminDirectoryError("revision_conflict", 412);
      if (!before && transaction.type(descriptor.docType)) throw new AdminDirectoryError("doctype_exists", 409);
      transaction.putValidation(record, timestamp);
      return record;
    });
  }

  lookupValidation(actor: AdminActor, id: string): Promise<AdminUrlValidation> {
    return this.directory.authorized(actor, transaction => {
      const record = transaction.validation(id);
      if (!record || record.actorId !== actor.adminId) throw new AdminDirectoryError("validation_not_found", 404);
      return record;
    });
  }

  async register(actor: AdminActor, input: { baseUrl: string; enabled: boolean; validationId: string }, key: string): Promise<AdminTypeRegistration> {
    const baseUrl = normalizeDocTypeBaseUrl(input.baseUrl);
    if (typeof input.enabled !== "boolean") throw new AdminDirectoryError("invalid_enabled", 400);
    return this.mutate(actor, key, JSON.stringify(["register", baseUrl, input.enabled, input.validationId]), transaction => {
      const validation = this.validated(transaction, actor, input.validationId, baseUrl, null);
      if (transaction.type(validation.descriptor.docType)) throw new AdminDirectoryError("doctype_exists", 409);
      if (transaction.types().length >= 1000) throw new AdminDirectoryError("doctype_limit", 409);
      const next: AdminTypeRegistration = {
        docType: validation.descriptor.docType, baseUrl, enabled: input.enabled, descriptor: validation.descriptor,
        checkedAt: validation.checkedAt, updatedAt: new Date(this.now()).toISOString(), revision: 1
      };
      transaction.putType(next);
      transaction.appendTypeAudit(actor.adminId, "doctype.registered", null, next, "");
      return next;
    });
  }

  async update(actor: AdminActor, docType: string, etag: string, input: { baseUrl?: string; enabled?: boolean; validationId?: string; reason: string }, key: string): Promise<AdminTypeRegistration> {
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500
      || input.enabled !== undefined && typeof input.enabled !== "boolean" || input.baseUrl === undefined && input.enabled === undefined) throw new AdminDirectoryError("invalid_update", 400);
    const baseUrl = input.baseUrl === undefined ? undefined : normalizeDocTypeBaseUrl(input.baseUrl);
    return this.mutate(actor, key, JSON.stringify(["update", docType, etag, baseUrl, input.enabled, input.validationId, input.reason]), transaction => {
      const before = transaction.type(docType);
      if (!before) throw new AdminDirectoryError("doctype_not_found", 404);
      if (adminTypeEtag(before) !== etag) throw new AdminDirectoryError("revision_conflict", 412);
      const nextUrl = baseUrl ?? before.baseUrl;
      const needsValidation = nextUrl !== before.baseUrl || input.enabled === true && !before.enabled;
      const validation = needsValidation ? this.validated(transaction, actor, input.validationId, nextUrl, before) : null;
      if (validation) matchDocTypeIdentity(before.descriptor, validation.descriptor);
      if (!Number.isSafeInteger(before.revision + 1)) throw new AdminDirectoryError("revision_limit", 409);
      const next: AdminTypeRegistration = {
        ...before, baseUrl: nextUrl, enabled: input.enabled ?? before.enabled, descriptor: validation?.descriptor ?? before.descriptor,
        checkedAt: validation?.checkedAt ?? before.checkedAt, updatedAt: new Date(this.now()).toISOString(), revision: before.revision + 1
      };
      transaction.putType(next);
      transaction.appendTypeAudit(actor.adminId, "doctype.updated", before, next, input.reason);
      return next;
    });
  }

  private validated(transaction: AdminDirectoryTransaction, actor: AdminActor, id: string | undefined, baseUrl: string, before: AdminTypeRegistration | null): AdminUrlValidation {
    const record = id ? transaction.validation(id) : null;
    if (!record || record.actorId !== actor.adminId || record.baseUrl !== baseUrl || record.policyKey !== this.policyKey
      || record.expiresAt <= this.now() || record.expectedDocType !== (before?.docType ?? null) || record.expectedRevision !== (before?.revision ?? null)) throw new AdminDirectoryError("validation_required", 422);
    return record;
  }

  private async mutate(actor: AdminActor, key: string, fingerprint: string, perform: (transaction: AdminDirectoryTransaction) => AdminTypeRegistration): Promise<AdminTypeRegistration> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new AdminDirectoryError("invalid_idempotency_key", 400);
    return this.directory.authorized(actor, transaction => {
      const previous = transaction.typeCommand(actor.adminId, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AdminDirectoryError("idempotency_conflict", 409);
        return previous.registration;
      }
      const registration = perform(transaction);
      transaction.rememberType(actor.adminId, key, { fingerprint, registration });
      return registration;
    });
  }

  private async discover(baseUrl: string): Promise<DocTypeDescriptor> {
    const approved = this.approved.get(baseUrl);
    if (!approved) throw new AdminDirectoryError("url_not_approved", 422);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(new URL("./.well-known/unidocs-doctype", baseUrl), { redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AdminDirectoryError("discovery_failed", 422);
      const reader = response.body?.getReader();
      if (!reader) throw new AdminDirectoryError("invalid_descriptor", 422);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const result = await reader.read(); if (result.done) break;
          length += result.value.byteLength;
          if (length > 16_384) { await reader.cancel(); throw new AdminDirectoryError("descriptor_too_large", 422); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const descriptor = parseDocTypeDescriptor(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (descriptor.docType !== approved.docType || descriptor.serviceId !== approved.serviceId || descriptor.storageIdentity !== approved.storageIdentity || descriptor.audience !== approved.audience) throw new AdminDirectoryError("unapproved_service_identity", 422);
      for (const path of descriptor.editorProtocol === null ? ["./health"] : ["./health", "./editor/"]) {
        const checked = await this.fetcher(new URL(path, baseUrl), { method: "HEAD", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
        if (!checked.ok) throw new AdminDirectoryError("endpoint_unavailable", 422);
        if (path === "./editor/" && !checked.headers.get("content-type")?.startsWith("text/html")) throw new AdminDirectoryError("editor_unavailable", 422);
      }
      return descriptor;
    } catch (error) {
      if (error instanceof AdminDirectoryError) throw error;
      throw new AdminDirectoryError("discovery_failed", 422);
    } finally { clearTimeout(timer); }
  }
}