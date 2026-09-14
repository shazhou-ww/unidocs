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
  /**
   * Mirrors the constructor shape of the admin bundle repositories
   * (`D1TypeCardBundleRepository`, `D1ViewBundleRepository`), which consult
   * `bundleOrigin` to build a bundle's absolute URL at upload time. A
   * registration's `typeCardBundle.bundleUrl` is already that absolute URL,
   * so projecting the catalog never needs to consult it here; it is accepted
   * for constructor-signature parity with those repositories and for any
   * future caller that wires this repository the same way.
   */
  constructor(private readonly database: D1Database, private readonly bundleOrigin: string) {}

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
 * (Type Card bundle, View bundle, built-in Operator) is missing, or the
 * View and the Operator share no supported contract revision. Every result
 * that does survive is run through `PublicDocumentTypeSchema.parse()`, so a
 * malformed projection fails here rather than reaching a caller.
 *
 * The registration itself is only `JSON.parse`d, not re-validated against
 * `DocumentTypeRegistrationSchema`: it was already validated by the admin
 * write path before being stored, and this projection reads only a few of
 * its fields, so re-validating the whole record on every catalog read would
 * reject nothing a corrupted row wouldn't already fail at the final
 * `PublicDocumentTypeSchema.parse()` below (or throw trying to read it).
 */
function projectPublicDocumentType(row: DocumentTypeRow): PublicDocumentType | null {
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
