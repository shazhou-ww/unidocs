import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  AdminAccessError, adminConfirmationTime, requireRecentAuthentication, validateAdminIdentity, type AdminIdentity,
} from "@unidocs/portal-service";
import type { PortalLoginTransaction } from "../google-login.js";
import { D1TenantSessionStore } from "./session.js";

/** A member keeps at most this many sessions; signing in once more drops the oldest. */
export const TENANT_MEMBER_SESSION_LIMIT = 10;
/** Bounded so a burst of abandoned sign-ins cannot make one `put` slow. */
const EXPIRED_TRANSACTION_SWEEP = 100;

interface MemberRow {
  readonly member_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly email: string;
  readonly revision: number;
  readonly created_at: number;
}

export class D1TenantLoginRepository {
  private readonly sessions: D1TenantSessionStore;

  constructor(private readonly db: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.sessions = new D1TenantSessionStore(db);
  }

  async put(transaction: PortalLoginTransaction): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM portal_tenant_login_transactions WHERE rowid IN
        (SELECT rowid FROM portal_tenant_login_transactions WHERE expires_at <= ? LIMIT ${EXPIRED_TRANSACTION_SWEEP})`)
        .bind(transaction.createdAt),
      this.db.prepare(`INSERT INTO portal_tenant_login_transactions
        (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(transaction.stateHash, transaction.browserHash, transaction.verifier, transaction.nonce, transaction.returnTo, transaction.createdAt, transaction.expiresAt),
    ]);
  }

  async take(stateHash: string, browserHash: string, now: number): Promise<PortalLoginTransaction | null> {
    return this.db.prepare(`DELETE FROM portal_tenant_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING state_hash AS stateHash, browser_hash AS browserHash, verifier, nonce, return_to AS returnTo, created_at AS createdAt, expires_at AS expiresAt`)
      .bind(stateHash, browserHash, now).first<PortalLoginTransaction>();
  }

  /**
   * Reads, then commits binding and session in one batch. Every write the
   * batch depends on is followed by a guard row (`portal_mutation_guard`
   * only accepts 1), so a member removed or an invitation claimed between the
   * read and the batch fails the whole batch instead of leaving a session
   * behind for someone who is no longer a member.
   */
  async completeLogin(identity: AdminIdentity, requestId: string) {
    const now = this.now();
    const verified = validateAdminIdentity(identity, now);
    requireRecentAuthentication(verified, now);
    const confirmedAt = adminConfirmationTime(verified);
    if (confirmedAt === null) throw new AdminAccessError("forbidden");

    const bound = await this.db.prepare("SELECT * FROM portal_tenant_members WHERE issuer = ? AND subject = ? AND active = 1")
      .bind(verified.issuer, verified.subject).first<MemberRow>();
    const invited = bound ? null : await this.db.prepare("SELECT * FROM portal_tenant_members WHERE email = ? AND active = 1 AND subject IS NULL")
      .bind(verified.email).first<MemberRow>();
    const member = bound ?? invited;
    // An identity confirmed before the invitation existed may not claim it.
    if (!member || (invited && confirmedAt < invited.created_at)) throw new AdminAccessError("forbidden");

    const issued = await this.sessions.prepareIssue(member.tenant_id, member.principal_id, now);
    const audit = (action: "member.bound" | "session.created") => this.db.prepare(
      "INSERT INTO portal_tenant_auth_audit (event_id, member_id, action, occurred_at, request_id) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), member.member_id, action, now, requestId);

    const statements: D1PreparedStatement[] = [];
    if (invited) {
      statements.push(
        this.db.prepare(`UPDATE portal_tenant_members SET issuer = ?, subject = ?, revision = revision + 1, updated_at = ?
          WHERE member_id = ? AND email = ? AND active = 1 AND subject IS NULL AND revision = ? AND created_at <= ?`)
          .bind(verified.issuer, verified.subject, now, invited.member_id, verified.email, invited.revision, confirmedAt),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        audit("member.bound"),
      );
    }
    statements.push(
      this.db.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
        (SELECT 1 FROM portal_tenant_members WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1) THEN 1 ELSE 0 END`)
        .bind(member.member_id, verified.issuer, verified.subject),
      this.db.prepare("DELETE FROM portal_mutation_guard"),
      this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ? AND expires_at <= ?")
        .bind(member.tenant_id, member.principal_id, now),
      this.db.prepare(`DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ? AND session_hash NOT IN
        (SELECT session_hash FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?
          ORDER BY created_at DESC, session_hash DESC LIMIT ?)`)
        .bind(member.tenant_id, member.principal_id, member.tenant_id, member.principal_id, TENANT_MEMBER_SESSION_LIMIT - 1),
      issued.statement,
      audit("session.created"),
    );
    await this.db.batch(statements);
    return { memberId: member.member_id, tenantId: member.tenant_id, principalId: member.principal_id, token: issued.token, csrfToken: issued.csrfToken };
  }
}
