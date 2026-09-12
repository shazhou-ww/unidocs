import {
  BundleUploadQuerySchema,
  EtagSchema,
  ListBundlesQuerySchema,
  TypeCardBundleRecordSchema,
  UpdateCandidateMetadataRequestSchema,
  type ListBundlesQuery,
  type ListTypeCardBundlesResponse,
  type TypeCardBundleManifestV1,
  type TypeCardBundleMutationResult,
  type TypeCardBundleRecord,
  type UpdateCandidateMetadataRequest,
} from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";
import { resourceEtag, schemaHash } from "../identity.js";
import { inspectBundleManifest } from "../bundles/manifest.js";
import { storeTypeCardBundleObjects, type BundleObjectStore } from "../bundles/type-card-store.js";

export type TypeCardBundleErrorCode = "invalid_request" | "not_found" | "idempotency_conflict" | "precondition_failed" | "forbidden" | "bundle_already_exists";

export class TypeCardBundleOperationError extends Error {
  constructor(readonly code: TypeCardBundleErrorCode, readonly details?: Readonly<Record<string, unknown>>) {
    super({
      invalid_request: "The request is invalid",
      not_found: "Type Card bundle or document type not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      precondition_failed: "The If-Match precondition failed",
      forbidden: "Administrator access is denied",
      bundle_already_exists: "The Type Card bundle content already exists",
    }[code]);
    this.name = "TypeCardBundleOperationError";
  }
}

export interface TypeCardBundleUploadCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly contentHash: string;
  readonly typeCardBundleId: string;
  readonly documentType: string;
  readonly occurredAt: string;
}

export interface TypeCardBundlePublishCommand extends TypeCardBundleUploadCommand {
  readonly record: TypeCardBundleRecord;
  readonly auditEventId: string;
  readonly requestId: string;
}

export interface TypeCardBundleMetadataCommand {
  readonly context: AdminContext;
  readonly typeCardBundleId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly request: UpdateCandidateMetadataRequest;
  readonly occurredAt: string;
  readonly auditEventId: string;
  readonly requestId: string;
  buildRecord(current: TypeCardBundleRecord): Promise<TypeCardBundleRecord>;
}

export type TypeCardBundleReservation =
  | { readonly kind: "reserved" }
  | { readonly kind: "replay"; readonly result: TypeCardBundleMutationResult };

export interface TypeCardBundleRepository {
  reserveUpload(command: TypeCardBundleUploadCommand): Promise<TypeCardBundleReservation>;
  publishUpload(command: TypeCardBundlePublishCommand): Promise<TypeCardBundleMutationResult>;
  updateMetadata(command: TypeCardBundleMetadataCommand): Promise<TypeCardBundleMutationResult>;
  get(context: AdminContext, typeCardBundleId: string): Promise<TypeCardBundleRecord | null>;
  list(context: AdminContext, query: ListBundlesQuery): Promise<ListTypeCardBundlesResponse>;
}

function validKey(key: string) {
  return /^[\x20-\x7e]{1,128}$/.test(key);
}

export function typeCardBundleIdentity(contentHash: string) {
  const digest = /^sha256:([0-9a-f]{64})$/.exec(contentHash)?.[1];
  if (!digest) throw new TypeCardBundleOperationError("invalid_request");
  return `tb_${digest}`;
}

export function createTypeCardBundleService(repository: TypeCardBundleRepository, objectStore: BundleObjectStore, options: {
  readonly bundleOrigin: string;
  readonly now?: () => Date;
  readonly id?: () => string;
}): {
  upload(context: AdminContext, query: unknown, source: ReadableStream<Uint8Array>, key: string, requestId: string): Promise<TypeCardBundleMutationResult>;
  updateMetadata(context: AdminContext, typeCardBundleId: string, body: unknown, key: string, expectedEtag: string, requestId: string): Promise<TypeCardBundleMutationResult>;
  get(context: AdminContext, typeCardBundleId: string): Promise<TypeCardBundleRecord>;
  list(context: AdminContext, query: unknown): Promise<ListTypeCardBundlesResponse>;
} {
  const origin = new URL(options.bundleOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("bundleOrigin must be an HTTPS origin");
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async upload(context, query, source, key, requestId) {
      const parsed = BundleUploadQuerySchema.safeParse(query);
      if (!parsed.success || typeof query !== "object" || query === null || Array.isArray(query)
        || Object.keys(query).some(field => !["name", "description"].includes(field)) || !parsed.data.name.trim()
        || parsed.data.name.length > 256 || parsed.data.description.length > 2048 || !validKey(key)) throw new TypeCardBundleOperationError("invalid_request");
      const inspection = await inspectBundleManifest(source, { kind: "type-card", documentContractIdxs: [] });
      const manifest = inspection.manifest as TypeCardBundleManifestV1;
      const typeCardBundleId = typeCardBundleIdentity(inspection.contentHash);
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      const fingerprint = await schemaHash({ operation: "uploadTypeCardBundle", contentHash: inspection.contentHash, query: parsed.data });
      const upload = { context, key, fingerprint, contentHash: inspection.contentHash, typeCardBundleId, documentType: manifest.documentType, occurredAt };
      const reservation = await repository.reserveUpload(upload);
      if (reservation.kind === "replay") return reservation.result;
      const stored = await storeTypeCardBundleObjects(inspection, objectStore);
      if (stored.typeCardBundleId !== typeCardBundleId) throw new TypeCardBundleOperationError("invalid_request");
      const representation = {
        typeCardBundleId,
        bundleUrl: new URL(stored.rootKey, origin).href,
        name: parsed.data.name,
        description: parsed.data.description,
        manifest,
        size: inspection.archiveBytes,
        uploadedAt: occurredAt,
      };
      const record = TypeCardBundleRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.publishUpload({ ...upload, record, auditEventId: id(), requestId });
    },
    async updateMetadata(context, typeCardBundleId, body, key, expectedEtag, requestId) {
      const parsed = UpdateCandidateMetadataRequestSchema.safeParse(body);
      if (!/^tb_[0-9a-f]{64}$/.test(typeCardBundleId) || !parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => !["name", "description"].includes(field)) || !parsed.data.name.trim()
        || parsed.data.name.length > 256 || parsed.data.description.length > 2048 || !validKey(key) || !EtagSchema.safeParse(expectedEtag).success) {
        throw new TypeCardBundleOperationError("invalid_request");
      }
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      return repository.updateMetadata({
        context, typeCardBundleId, key, expectedEtag, request: parsed.data, occurredAt, auditEventId: id(), requestId,
        fingerprint: await schemaHash({ operation: "updateTypeCardBundleMetadata", typeCardBundleId, expectedEtag, body: parsed.data }),
        async buildRecord(current) {
          const representation = { ...current, name: parsed.data.name, description: parsed.data.description };
          delete (representation as { etag?: string }).etag;
          return TypeCardBundleRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
        },
      });
    },
    async get(context, typeCardBundleId) {
      if (!/^tb_[0-9a-f]{64}$/.test(typeCardBundleId)) throw new TypeCardBundleOperationError("invalid_request");
      const record = await repository.get(context, typeCardBundleId);
      if (!record) throw new TypeCardBundleOperationError("not_found");
      return record;
    },
    async list(context, query) {
      const parsed = ListBundlesQuerySchema.safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new TypeCardBundleOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}