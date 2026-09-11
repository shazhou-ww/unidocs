import {
  BundleUploadQuerySchema,
  EtagSchema,
  ListBundlesQuerySchema,
  UpdateCandidateMetadataRequestSchema,
  ViewBundleRecordSchema,
  type ListBundlesQuery,
  type ListViewBundlesResponse,
  type UpdateCandidateMetadataRequest,
  type ViewBundleManifestV1,
  type ViewBundleMutationResult,
  type ViewBundleRecord,
} from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";
import { inspectBundleManifest } from "../bundles/manifest.js";
import { type BundleObjectStore } from "../bundles/type-card-store.js";
import { storeViewBundleObjects } from "../bundles/view-store.js";
import { resourceEtag, schemaHash } from "../identity.js";

export type ViewBundleErrorCode = "invalid_request" | "not_found" | "idempotency_conflict" | "precondition_failed" | "forbidden" | "bundle_already_exists";

export class ViewBundleOperationError extends Error {
  constructor(readonly code: ViewBundleErrorCode, readonly details?: Readonly<Record<string, unknown>>) {
    super({
      invalid_request: "The request is invalid",
      not_found: "View bundle or document type not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      precondition_failed: "The If-Match precondition failed",
      forbidden: "Administrator access is denied",
      bundle_already_exists: "The View bundle content already exists",
    }[code]);
    this.name = "ViewBundleOperationError";
  }
}

export interface ViewBundleUploadCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly contentHash: string;
  readonly viewBundleId: string;
  readonly documentType: string;
  readonly occurredAt: string;
}

export interface ViewBundlePublishCommand extends ViewBundleUploadCommand {
  readonly record: ViewBundleRecord;
  readonly auditEventId: string;
  readonly requestId: string;
}

export interface ViewBundleMetadataCommand {
  readonly context: AdminContext;
  readonly viewBundleId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly request: UpdateCandidateMetadataRequest;
  readonly occurredAt: string;
  readonly auditEventId: string;
  readonly requestId: string;
  buildRecord(current: ViewBundleRecord): Promise<ViewBundleRecord>;
}

export type ViewBundleReservation = { readonly kind: "reserved" } | { readonly kind: "replay"; readonly result: ViewBundleMutationResult };

export interface ViewBundleRepository {
  listDocumentContractIdxs(context: AdminContext, documentType: string): Promise<readonly number[] | null>;
  reserveUpload(command: ViewBundleUploadCommand): Promise<ViewBundleReservation>;
  publishUpload(command: ViewBundlePublishCommand): Promise<ViewBundleMutationResult>;
  updateMetadata(command: ViewBundleMetadataCommand): Promise<ViewBundleMutationResult>;
  get(context: AdminContext, viewBundleId: string): Promise<ViewBundleRecord | null>;
  list(context: AdminContext, query: ListBundlesQuery): Promise<ListViewBundlesResponse>;
}

function validKey(key: string) {
  return /^[\x21-\x7e]{1,128}$/.test(key);
}

export function viewBundleIdentity(contentHash: string) {
  const digest = /^sha256:([0-9a-f]{64})$/.exec(contentHash)?.[1];
  if (!digest) throw new ViewBundleOperationError("invalid_request");
  return `vb_${digest}`;
}

export function createViewBundleService(repository: ViewBundleRepository, objectStore: BundleObjectStore, options: {
  readonly bundleOrigin: string;
  readonly now?: () => Date;
  readonly id?: () => string;
}) {
  const origin = new URL(options.bundleOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("bundleOrigin must be an HTTPS origin");
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async upload(context: AdminContext, query: unknown, source: ReadableStream<Uint8Array>, key: string, requestId: string): Promise<ViewBundleMutationResult> {
      const parsed = BundleUploadQuerySchema.safeParse(query);
      if (!parsed.success || typeof query !== "object" || query === null || Array.isArray(query)
        || Object.keys(query).some(field => !["name", "description"].includes(field)) || !parsed.data.name.trim()
        || parsed.data.name.length > 256 || parsed.data.description.length > 2048 || !validKey(key)) throw new ViewBundleOperationError("invalid_request");
      const inspection = await inspectBundleManifest(source, {
        kind: "view",
        async documentContractIdxs(documentType) {
          const revisions = await repository.listDocumentContractIdxs(context, documentType);
          if (revisions === null) throw new ViewBundleOperationError("not_found");
          return revisions;
        },
      });
      const manifest = inspection.manifest as ViewBundleManifestV1;
      const viewBundleId = viewBundleIdentity(inspection.contentHash);
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      const fingerprint = await schemaHash({ operation: "uploadViewBundle", contentHash: inspection.contentHash, query: parsed.data });
      const upload = { context, key, fingerprint, contentHash: inspection.contentHash, viewBundleId, documentType: manifest.documentType, occurredAt };
      const reservation = await repository.reserveUpload(upload);
      if (reservation.kind === "replay") return reservation.result;
      const stored = await storeViewBundleObjects(inspection, objectStore);
      if (stored.viewBundleId !== viewBundleId) throw new ViewBundleOperationError("invalid_request");
      const representation = {
        viewBundleId,
        bundleUrl: new URL(stored.rootKey, origin).href,
        name: parsed.data.name,
        description: parsed.data.description,
        manifest,
        size: inspection.archiveBytes,
        uploadedAt: occurredAt,
      };
      const record = ViewBundleRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.publishUpload({ ...upload, record, auditEventId: id(), requestId });
    },
    async updateMetadata(context: AdminContext, viewBundleId: string, body: unknown, key: string, expectedEtag: string, requestId: string): Promise<ViewBundleMutationResult> {
      const parsed = UpdateCandidateMetadataRequestSchema.safeParse(body);
      if (!/^vb_[0-9a-f]{64}$/.test(viewBundleId) || !parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => !["name", "description"].includes(field)) || !parsed.data.name.trim()
        || parsed.data.name.length > 256 || parsed.data.description.length > 2048 || !validKey(key) || !EtagSchema.safeParse(expectedEtag).success) throw new ViewBundleOperationError("invalid_request");
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      return repository.updateMetadata({
        context, viewBundleId, key, expectedEtag, request: parsed.data, occurredAt, auditEventId: id(), requestId,
        fingerprint: await schemaHash({ operation: "updateViewBundleMetadata", viewBundleId, expectedEtag, body: parsed.data }),
        async buildRecord(current) {
          const representation = { ...current, name: parsed.data.name, description: parsed.data.description };
          delete (representation as { etag?: string }).etag;
          return ViewBundleRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
        },
      });
    },
    async get(context: AdminContext, viewBundleId: string): Promise<ViewBundleRecord> {
      if (!/^vb_[0-9a-f]{64}$/.test(viewBundleId)) throw new ViewBundleOperationError("invalid_request");
      const record = await repository.get(context, viewBundleId);
      if (!record) throw new ViewBundleOperationError("not_found");
      return record;
    },
    async list(context: AdminContext, query: unknown): Promise<ListViewBundlesResponse> {
      const parsed = ListBundlesQuerySchema.safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new ViewBundleOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}