import type { Pool } from "pg";

export interface LegacySessionIdentity {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly docType: string;
}

export function parseLegacySessionIdentities(value: unknown): LegacySessionIdentity[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Legacy session identity map must be a JSON array");
  }

  const identities: LegacySessionIdentity[] = [];
  const sessionIds = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError("Each legacy session identity must be an object");
    }
    const record = candidate as Record<string, unknown>;
    const sessionId = requiredString(record.sessionId, "sessionId");
    const tenantId = requiredString(record.tenantId, "tenantId");
    const docType = requiredString(record.docType, "docType");
    if (sessionIds.has(sessionId)) {
      throw new TypeError(`Duplicate legacy sessionId: ${sessionId}`);
    }
    sessionIds.add(sessionId);
    identities.push({ sessionId, tenantId, docType });
  }
  return identities;
}

export async function importLegacySessionIdentities(
  pool: Pool,
  identities: readonly LegacySessionIdentity[],
): Promise<number> {
  const bySessionId = new Map(identities.map(identity => [identity.sessionId, identity]));
  if (bySessionId.size !== identities.length) {
    throw new TypeError("Legacy session identity map contains duplicate sessionId values");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const persisted = await client.query<{ doc_type: string; session_id: string }>(
      `SELECT doc_type, session_id FROM deltas
       UNION
       SELECT doc_type, session_id FROM doc_snapshots`,
    );
    const missing = persisted.rows.filter(row => {
      const identity = bySessionId.get(row.session_id);
      return !identity || identity.docType !== row.doc_type;
    });
    if (missing.length > 0) {
      const sample = missing
        .slice(0, 5)
        .map(row => `${row.doc_type}/${row.session_id}`)
        .join(", ");
      throw new Error(
        `Legacy session identity map does not cover persisted sessions: ${sample}`,
      );
    }

    for (const identity of identities) {
      await client.query(
        `INSERT INTO doc_sessions (session_id, tenant_id, doc_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING`,
        [identity.sessionId, identity.tenantId, identity.docType],
      );
    }

    if (identities.length > 0) {
      const imported = await client.query<{
        session_id: string;
        tenant_id: string;
        doc_type: string;
      }>(
        `SELECT session_id, tenant_id, doc_type FROM doc_sessions
         WHERE session_id = ANY($1::text[])`,
        [identities.map(identity => identity.sessionId)],
      );
      const stored = new Map(imported.rows.map(row => [row.session_id, row]));
      for (const identity of identities) {
        const row = stored.get(identity.sessionId);
        if (!row
          || row.tenant_id !== identity.tenantId
          || row.doc_type !== identity.docType) {
          throw new Error(`Conflicting stored identity for legacy session ${identity.sessionId}`);
        }
      }
    }

    await client.query("COMMIT");
    return identities.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Legacy session ${name} must be a non-empty string`);
  }
  return value.trim();
}