import type { D1Database } from "@cloudflare/workers-types";
import { CasClientError } from "@unicas/tenant-blob-client";
import {
  VersionRecordSchema,
  type AddressedComment,
  type ListVersionsResponse,
  type PaginationQuery,
  type VersionRecord,
} from "@unidocs/protocol-tenant-portal";
import {
  TenantOperationError,
  type TenantContext,
  type TenantVersionRepository,
  type VersionSnapshot,
} from "@unidocs/portal-service";
import type { SnapshotStore } from "../snapshot-store.js";
import { decodeCursor, DEFAULT_PAGE_LIMIT, encodeCursor } from "./cursor.js";

interface VersionRow {
  readonly version_idx: number;
  readonly parent_version_idx: number | null;
  readonly document_contract_idx: number;
  readonly author_agent_id: string;
  readonly submission_id: string;
  readonly addressed_comments_json: string;
  readonly created_at: number;
}

interface SnapshotRow {
  readonly snapshot_blob_hash: string;
  readonly snapshot_size: number;
  readonly snapshot_content_type: string;
  readonly document_type: string;
}

/**
 * Persists tenant version metadata in `portal_versions`. Snapshot bytes are
 * never in D1: the row holds only a `CasBlobRef` (blob hash, size, content
 * type), and `readSnapshot` streams the bytes out of the snapshot store.
 */
export class D1TenantVersionRepository implements TenantVersionRepository {
  constructor(
    private readonly database: D1Database,
    private readonly snapshots: SnapshotStore,
  ) {}

  /**
   * Unlike every other tenant list, this one orders by `version_idx ASC` -
   * birth order - not `(created_at DESC, id DESC)`: a version-history panel
   * draws the base parent forest from the contract's declared order. The
   * cursor stays opaque via `encodeCursor`/`decodeCursor`, but the keyset it
   * carries is just the last-seen `version_idx`, reusing the shared
   * `{ at, id }` cursor shape - `id` here is redundant (version_idx alone is
   * already unique within a document) and is only populated to satisfy
   * `decodeCursor`'s non-empty-id requirement.
   */
  async list(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListVersionsResponse> {
    let after: number | null = null;
    if (query.cursor !== undefined) {
      const key = decodeCursor(query.cursor);
      if (!key) throw new TenantOperationError("invalid_request");
      after = key.at;
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const result = await this.database.prepare(
      `SELECT version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, created_at
       FROM portal_versions
       WHERE tenant_id = ?1 AND document_id = ?2
         AND (?3 IS NULL OR version_idx > ?3)
       ORDER BY version_idx ASC
       LIMIT ?4`,
    ).bind(context.tenantId, documentId, after, limit + 1).all<VersionRow>();

    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const items = page.map(projectVersion);
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ at: last.version_idx, id: String(last.version_idx) })
      : null;
    return { items, nextCursor };
  }

  async get(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionRecord | null> {
    const row = await this.database.prepare(
      `SELECT version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, created_at
       FROM portal_versions
       WHERE tenant_id = ? AND document_id = ? AND version_idx = ?`,
    ).bind(context.tenantId, documentId, versionIdx).first<VersionRow>();
    return row ? projectVersion(row) : null;
  }

  /**
   * `snapshot_content_type` is read here only to reconstruct the `CasBlobRef`
   * that `SnapshotStore.read` needs to locate the blob - it is what CAS
   * recorded at write time, not an authority for the wire content type. The
   * wire type is always `documentSnapshotContentType(documentType)`, derived
   * by the service layer from `documentType` below; nothing reads this column
   * for that purpose, and it must stay that way.
   *
   * A missing version returns `null` before the snapshot store is ever
   * called - a version that does not exist must not produce CAS traffic.
   *
   * `snapshots.read` can fail in ways that have nothing to do with the D1 row
   * being fine: the blob may have been collected out of CAS (surfaced as a
   * `CasClientError` with a 404 status), its stored size may no longer match
   * what the version row declares (`snapshot-store.ts`'s bare `Error` for
   * that mismatch), or CAS itself may simply be unreachable or failing (any
   * other `CasClientError` status, or a network-level throw that never got a
   * response at all). The first two are `content_unavailable` - the content
   * this specific reference names is gone or inconsistent, not a transient
   * fault - and the entry point (`TENANT_LIMITS`'s sibling code in
   * `access.ts`) exists precisely for that. Everything else is `unavailable`,
   * since it says nothing about this blob in particular. Left unmapped, any
   * of these would otherwise propagate as a bare `Error` with no
   * `TenantOperationCode`, which Plan 3's HTTP layer has no way to turn into
   * the right status.
   */
  async readSnapshot(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionSnapshot | null> {
    const row = await this.database.prepare(
      `SELECT v.snapshot_blob_hash, v.snapshot_size, v.snapshot_content_type, d.document_type
       FROM portal_versions v
       JOIN portal_documents d ON d.tenant_id = v.tenant_id AND d.document_id = v.document_id
       WHERE v.tenant_id = ? AND v.document_id = ? AND v.version_idx = ?`,
    ).bind(context.tenantId, documentId, versionIdx).first<SnapshotRow>();
    if (!row) return null;

    let body: ReadableStream<Uint8Array>;
    try {
      body = await this.snapshots.read({
        blobHash: row.snapshot_blob_hash,
        size: row.snapshot_size,
        contentType: row.snapshot_content_type,
      });
    } catch (error) {
      if (error instanceof CasClientError && error.status === 404) throw new TenantOperationError("content_unavailable");
      if (error instanceof Error && /bytes, but the version record declares/.test(error.message)) {
        throw new TenantOperationError("content_unavailable");
      }
      throw new TenantOperationError("unavailable");
    }
    return { documentType: row.document_type, body };
  }
}

function projectVersion(row: VersionRow): VersionRecord {
  return VersionRecordSchema.parse({
    versionIdx: row.version_idx,
    parentVersionIdx: row.parent_version_idx,
    documentContractIdx: row.document_contract_idx,
    authorAgentId: row.author_agent_id,
    submissionId: row.submission_id,
    addressedComments: JSON.parse(row.addressed_comments_json) as readonly AddressedComment[],
    createdAt: new Date(row.created_at * 1000).toISOString(),
  });
}
