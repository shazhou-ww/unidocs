import type { D1Database } from "@cloudflare/workers-types";
import type { DocumentTypeRegistration } from "@unidocs/protocol-admin-portal";
import {
  DocumentContractRecordSchema,
  PublicDocumentTypeSchema,
  type DocumentContractRecord,
  type ListPublicDocumentTypesResponse,
  type PaginationQuery,
  type PublicDocumentType,
} from "@unidocs/protocol-tenant-portal";
import { TenantOperationError, type TenantCatalogRepository, type TenantContext } from "@unidocs/portal-service";
import { decodeCursor, encodeCursor } from "./cursor.js";

interface DocumentTypeRow {
  readonly document_type: string;
  readonly registration_json: string;
}

interface DocumentContractRow {
  readonly record_json: string;
}

/**
 * Projects the public document type catalog from admin registration data.
 *
 * This repository owns no tables of its own. `portal_document_types.registration_json`
 * already embeds the current Type Card bundle, View bundle and built-in
 * Operator as whole records rather than ids, so one row is enough to build a
 * `PublicDocumentType`: no join is needed.
 */
export class D1TenantCatalogRepository implements TenantCatalogRepository {
  constructor(private readonly database: D1Database) {}

  async listDocumentTypes(_context: TenantContext, query: PaginationQuery): Promise<ListPublicDocumentTypesResponse> {
    let before: string | null = null;
    if (query.cursor !== undefined) {
      const key = decodeCursor(query.cursor);
      if (!key) throw new TenantOperationError("invalid_request");
      before = key.id;
    }
    const limit = query.limit ?? 25;

    const result = await this.database.prepare(`SELECT document_type, registration_json FROM portal_document_types
      WHERE enabled = 1 AND (?1 IS NULL OR document_type < ?1)
      ORDER BY document_type DESC LIMIT ?2`)
      .bind(before, limit + 1)
      .all<DocumentTypeRow>();

    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const items: PublicDocumentType[] = [];
    for (const row of page) {
      const projected = projectPublicDocumentType(row);
      if (projected) items.push(projected);
    }
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ at: 0, id: last.document_type })
      : null;
    return { items, nextCursor };
  }

  async getDocumentContract(_context: TenantContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null> {
    const row = await this.database.prepare(
      "SELECT record_json FROM portal_document_contracts WHERE document_type = ? AND document_contract_idx = ?",
    ).bind(documentType, documentContractIdx).first<DocumentContractRow>();
    return row ? DocumentContractRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }
}

/**
 * Builds one `PublicDocumentType` from a row's registration, or `null` when
 * the type must not be published: any of the three current selections
 * (Type Card bundle, View bundle, built-in Operator) is missing, the View and
 * the Operator share no supported contract revision, or the registration is
 * structurally broken in a way that makes it impossible to build a valid
 * projection at all (a field access throws, or the assembled record fails
 * `PublicDocumentTypeSchema.parse()`). All three dispositions are the same
 * from a caller's point of view: this one document type is not ready to be
 * listed. A single corrupt admin row must not turn into an uncoded 500 that
 * denies the whole catalog page to every tenant, so failures are caught here
 * and turned into an omission rather than left to propagate.
 *
 * The registration itself is only `JSON.parse`d, not re-validated against
 * `DocumentTypeRegistrationSchema`: it was already validated by the admin
 * write path before being stored, and this projection reads only a few of
 * its fields. Whatever that skipped validation would have caught, the
 * try/catch below and the final schema parse still catch before anything
 * reaches a caller.
 */
function projectPublicDocumentType(row: DocumentTypeRow): PublicDocumentType | null {
  try {
    return buildPublicDocumentType(row);
  } catch (error) {
    // No repository under packages/cloudflare-portal/src logs anything today,
    // and worker.ts's portal_operation_failed log only fires on an uncaught
    // throw reaching the HTTP layer - which this catch specifically prevents.
    // Without a line here, a corrupt admin row vanishes from the catalog with
    // zero trace: an administrator sees a published type that no tenant can
    // see, and nothing records why. Structured the same way worker.ts already
    // logs (JSON with an `event` field), so it can be grepped the same way.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "tenant_catalog_row_skipped", documentType: row.document_type, message }));
    return null;
  }
}

function buildPublicDocumentType(row: DocumentTypeRow): PublicDocumentType | null {
  const registration = JSON.parse(row.registration_json) as DocumentTypeRegistration;
  const { typeCardBundle, viewBundle, builtinOperator } = registration;
  if (!typeCardBundle || !viewBundle || !builtinOperator) return null;

  const operatorIdxs = builtinOperator.descriptor.supportedDocumentContracts[registration.documentType] ?? [];
  const availableDocumentContractIdxs = viewBundle.manifest.supportedDocumentContractIdxs
    .filter(idx => operatorIdxs.includes(idx))
    .sort((a, b) => a - b);
  if (availableDocumentContractIdxs.length === 0) return null;

  const { manifest, bundleUrl } = typeCardBundle;
  const icon = manifest.icon.kind === "svg"
    ? { kind: "svg" as const, url: new URL(manifest.icon.path, bundleUrl).toString() }
    : {
        kind: "png" as const,
        imageUrls: {
          16: new URL(manifest.icon.images[16], bundleUrl).toString(),
          32: new URL(manifest.icon.images[32], bundleUrl).toString(),
          64: new URL(manifest.icon.images[64], bundleUrl).toString(),
          128: new URL(manifest.icon.images[128], bundleUrl).toString(),
          256: new URL(manifest.icon.images[256], bundleUrl).toString(),
        },
      };

  return PublicDocumentTypeSchema.parse({
    documentType: registration.documentType,
    typeCardBundleId: typeCardBundle.typeCardBundleId,
    typeCard: {
      locales: manifest.locales,
      icon,
      sampleThumbnailUrl: new URL(manifest.sampleThumbnail, bundleUrl).toString(),
    },
    viewBundleId: viewBundle.viewBundleId,
    availableDocumentContractIdxs,
  });
}
