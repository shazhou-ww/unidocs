import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { NodeUsageEntry, NodeUsageRepository, NodeUsageScope } from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";

/** D1/R2 adapter for the cloud-neutral tenant node usage kernel. */
export class CloudflareNodeUsageRepository implements NodeUsageRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.#db = db;
    this.#bucket = bucket;
  }

  async listNodes(scope: NodeUsageScope): Promise<readonly NodeUsageEntry[]> {
    const nodes = await this.#db.prepare(
      "SELECT hash, content_size, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ?",
    ).bind(scope.stackId, scope.tenantId).all<{ hash: string; content_size: number; lease_expires_at: number }>();
    return nodes.results.map((node) => ({
      hash: node.hash,
      contentSize: node.content_size,
      leaseExpiresAt: node.lease_expires_at,
    }));
  }

  async readCanonicalStoredBytes(scope: NodeUsageScope, hash: string): Promise<number | null> {
    const object = await this.#bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash));
    return object?.size ?? null;
  }

  async readReservedBytes(scope: NodeUsageScope): Promise<number> {
    const reservations = await this.#db.prepare(
      "SELECT COALESCE(SUM(stored_bytes), 0) AS reserved_bytes FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ?",
    ).bind(scope.stackId, scope.tenantId).first<{ reserved_bytes: number }>();
    return reservations?.reserved_bytes ?? 0;
  }
}
