import type { D1Database } from "@cloudflare/workers-types";

/**
 * Inserts a tenant member row straight into D1. A session only authenticates
 * while its (tenant, principal) belongs to an active, bound member, so every
 * test that issues a session needs one of these first.
 */
export async function insertMember(db: D1Database, input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly email?: string;
  readonly memberId?: string;
  readonly active?: boolean;
  readonly bound?: boolean;
  readonly createdAt?: number;
}): Promise<string> {
  const memberId = input.memberId ?? `member-${crypto.randomUUID()}`;
  const bound = input.bound ?? true;
  const createdAt = input.createdAt ?? 1;
  await db.prepare(`INSERT INTO portal_tenant_members
    (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`)
    .bind(
      memberId, input.tenantId, input.principalId,
      input.email ?? `${memberId}@example.test`,
      bound ? "https://accounts.google.com" : null,
      bound ? `subject-${memberId}` : null,
      input.active === false ? 0 : 1,
      createdAt, createdAt,
    )
    .run();
  return memberId;
}
