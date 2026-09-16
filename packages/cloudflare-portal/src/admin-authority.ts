import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AdminContext } from "@unidocs/portal-service";

/**
 * The acting administrator is still an active, bound member and, for a
 * browser, still holds an unrevoked, unexpired session. Checked before a
 * mutation and again inside its batch, so an administrator removed mid-request
 * cannot finish one.
 */
const AUTHORITY = `SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
  AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
    WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`;

function bindings(context: AdminContext, now: number) {
  return [context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, now] as const;
}

export function adminAuthorityQuery(db: D1Database, context: AdminContext, now: number): D1PreparedStatement {
  return db.prepare(AUTHORITY).bind(...bindings(context, now));
}

export function adminAuthorityGuard(db: D1Database, context: AdminContext, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS (${AUTHORITY}) THEN 1 ELSE 0 END`).bind(...bindings(context, now));
}
