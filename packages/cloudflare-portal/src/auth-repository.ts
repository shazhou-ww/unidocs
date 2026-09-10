import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AdminAccessError, adminConfirmationTime, validateAdminIdentity, requireBootstrapIdentity, requireRecentAuthentication, type AdminIdentity, type BoundAdministrator } from "@unidocs/portal-service";
import { createAdminSession, type AdminSession } from "./auth.js";
import type { PortalLoginTransaction } from "./google-login.js";

interface MemberRow {
  member_id: string;
  email: string;
  issuer: string | null;
  subject: string | null;
  active: number;
  revision: number;
  created_at: number;
}

export class D1PortalAuthRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private guard(): D1PreparedStatement[] {
    return [this.database.prepare("INSERT INTO portal_mutation_guard VALUES (changes())"), this.database.prepare("DELETE FROM portal_mutation_guard")];
  }

  async put(transaction: PortalLoginTransaction): Promise<void> {
    await this.database.prepare(`INSERT INTO portal_login_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(transaction.stateHash, transaction.browserHash, transaction.verifier, transaction.nonce, transaction.returnTo, transaction.createdAt, transaction.expiresAt).run();
  }

  async take(stateHash: string, browserHash: string, now: number): Promise<PortalLoginTransaction | null> {
    return this.database.prepare(`DELETE FROM portal_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING state_hash AS stateHash, browser_hash AS browserHash, verifier, nonce, return_to AS returnTo, created_at AS createdAt, expires_at AS expiresAt`)
      .bind(stateHash, browserHash, now).first<PortalLoginTransaction>();
  }

  async findMemberById(memberId: string): Promise<BoundAdministrator | null> {
    return this.memberFromRow(await this.database.prepare("SELECT * FROM portal_administrators WHERE member_id = ? AND active = 1 AND subject IS NOT NULL").bind(memberId).first<MemberRow>());
  }

  async findMemberByIdentity(identity: AdminIdentity): Promise<BoundAdministrator | null> {
    return this.memberFromRow(await this.database.prepare("SELECT * FROM portal_administrators WHERE issuer = ? AND subject = ? AND active = 1").bind(identity.issuer, identity.subject).first<MemberRow>());
  }

  private memberFromRow(row: MemberRow | null): BoundAdministrator | null {
    if (!row?.issuer || !row.subject || row.active !== 1) return null;
    return { memberId: row.member_id, issuer: row.issuer, subject: row.subject, active: true };
  }

  async findSession(sessionHash: string): Promise<AdminSession | null> {
    const row = await this.database.prepare(`SELECT session.session_hash, session.csrf_hash, session.identity_json, session.created_at, session.expires_at,
        family.member_id, member.issuer, member.subject
      FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
      JOIN portal_administrators AS member ON family.member_id = member.member_id
      WHERE session.session_hash = ? AND family.revoked_at IS NULL AND member.active = 1 AND session.expires_at > ?`)
      .bind(sessionHash, this.now()).first<{
        session_hash: string; csrf_hash: string; identity_json: string; created_at: number; expires_at: number;
        member_id: string; issuer: string; subject: string;
      }>();
    if (!row) return null;
    const identity = validateAdminIdentity(JSON.parse(row.identity_json), this.now());
    if (identity.issuer !== row.issuer || identity.subject !== row.subject) return null;
    return { sessionHash: row.session_hash, csrfHash: row.csrf_hash, identity, memberId: row.member_id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  async completeLogin(identity: AdminIdentity, bootstrapEmail: string | null, requestId: string) {
    const now = this.now();
    const verified = validateAdminIdentity(identity, now);
    requireRecentAuthentication(verified, now);
    const confirmationTime = adminConfirmationTime(verified);
    if (confirmationTime === null) throw new AdminAccessError("forbidden");
    const bound = await this.database.prepare("SELECT * FROM portal_administrators WHERE issuer = ? AND subject = ? AND active = 1").bind(verified.issuer, verified.subject).first<MemberRow>();
    const invited = bound ? null : await this.database.prepare("SELECT * FROM portal_administrators WHERE email = ? AND active = 1 AND subject IS NULL").bind(verified.email).first<MemberRow>();
    if (invited && confirmationTime < invited.created_at) throw new AdminAccessError("forbidden");
    const memberId = bound?.member_id ?? invited?.member_id ?? crypto.randomUUID();
    const member: BoundAdministrator = { memberId, issuer: verified.issuer, subject: verified.subject, active: true };
    const issued = await createAdminSession(member, verified, now);
    const statements: D1PreparedStatement[] = [];
    let action: string | null = null;
    if (!bound && !invited) {
      requireBootstrapIdentity(verified, bootstrapEmail, now);
      if (await this.database.prepare("SELECT singleton FROM portal_bootstrap WHERE singleton = 1").first()) throw new AdminAccessError("forbidden");
      statements.push(
        this.database.prepare(`INSERT INTO portal_administrators (member_id, email, issuer, subject, added_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'bootstrap', ?, ? WHERE NOT EXISTS (SELECT 1 FROM portal_bootstrap) AND NOT EXISTS (SELECT 1 FROM portal_administrators)`)
          .bind(memberId, verified.email, verified.issuer, verified.subject, now, now),
        ...this.guard(),
        this.database.prepare("INSERT INTO portal_bootstrap VALUES (1, ?)").bind(memberId),
      );
      action = "administrator.bootstrap";
    } else if (invited) {
      statements.push(
        this.database.prepare(`UPDATE portal_administrators SET issuer = ?, subject = ?, revision = revision + 1, updated_at = ?
          WHERE member_id = ? AND email = ? AND active = 1 AND subject IS NULL AND revision = ? AND created_at <= ?`)
          .bind(verified.issuer, verified.subject, now, memberId, verified.email, invited.revision, confirmationTime),
        ...this.guard(),
      );
      action = "administrator.bound";
    }
    statements.push(
      this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
        (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1) THEN 1 ELSE 0 END`)
        .bind(memberId, verified.issuer, verified.subject),
      this.database.prepare("DELETE FROM portal_mutation_guard"),
    );
    if (action) statements.push(this.database.prepare(`INSERT INTO portal_admin_audit
      (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id) VALUES (?, ?, ?, 'administrator', ?, ?, ?)`)
      .bind(crypto.randomUUID(), memberId, action, memberId, now, requestId));
    const familyId = crypto.randomUUID();
    statements.push(
      this.database.prepare("UPDATE portal_session_families SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").bind(now, memberId),
      this.database.prepare("DELETE FROM portal_sessions WHERE family_id IN (SELECT family_id FROM portal_session_families WHERE member_id = ?)").bind(memberId),
      this.database.prepare("INSERT INTO portal_session_families (family_id, member_id, created_at) VALUES (?, ?, ?)").bind(familyId, memberId, now),
      this.database.prepare("INSERT INTO portal_sessions VALUES (?, ?, ?, ?, ?, ?)").bind(issued.session.sessionHash, familyId, issued.session.csrfHash, JSON.stringify(verified), now, issued.session.expiresAt),
      this.database.prepare("INSERT INTO portal_auth_audit VALUES (?, ?, 'session.created', ?, ?)").bind(crypto.randomUUID(), memberId, now, requestId),
    );
    await this.database.batch(statements);
    return { ...issued, memberId };
  }

  async revokeSession(sessionHash: string, memberId: string, requestId: string): Promise<void> {
    const now = this.now();
    await this.database.batch([
      this.database.prepare(`UPDATE portal_session_families SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL
        AND family_id = (SELECT family_id FROM portal_sessions WHERE session_hash = ? AND expires_at > ?)
        AND EXISTS (SELECT 1 FROM portal_administrators WHERE member_id = ? AND active = 1)`)
        .bind(now, memberId, sessionHash, now, memberId),
      ...this.guard(),
      this.database.prepare("DELETE FROM portal_sessions WHERE session_hash = ?").bind(sessionHash),
      this.database.prepare("INSERT INTO portal_auth_audit VALUES (?, ?, 'session.revoked', ?, ?)").bind(crypto.randomUUID(), memberId, now, requestId),
    ]);
  }
}