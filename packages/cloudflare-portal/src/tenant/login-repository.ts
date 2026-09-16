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
   * Reads, then commits binding (or provisioning) and session in one batch.
   * Every write the batch depends on is followed by a guard row
   * (`portal_mutation_guard` only accepts 1), so a member removed or an
   * invitation claimed between the read and the batch fails the whole batch
   * instead of leaving a session behind for someone who is no longer a
   * member.
   *
   * The tenant plane is self-service: any Google account with a verified
   * email may sign in. An identity that is neither an existing member nor an
   * invitation is provisioned its own, brand-new tenant right here — there is
   * no "not on the list" rejection left. The one case that still throws
   * `AdminAccessError("forbidden")` is an invitation claimed by a
   * confirmation that predates it.
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
    // An identity confirmed before the invitation existed may not claim it.
    if (invited && confirmedAt < invited.created_at) throw new AdminAccessError("forbidden");

    // Neither an existing member nor an invitation: provision a fresh tenant
    // and member for this identity. A member removed by an administrator
    // lands here too on their next sign-in — removal means "removed from
    // that tenant", not "locked out" — and gets a new, empty tenant.
    const provisioned = !bound && !invited;
    const member: MemberRow = bound ?? invited ?? {
      member_id: crypto.randomUUID(),
      tenant_id: `t-${crypto.randomUUID()}`,
      principal_id: `user:${crypto.randomUUID()}`,
      email: verified.email,
      revision: 0,
      created_at: now,
    };

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
    } else if (provisioned) {
      statements.push(
        this.db.prepare(`INSERT INTO portal_tenant_members
          (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 'self-signup', ?, ?)`)
          .bind(member.member_id, member.tenant_id, member.principal_id, member.email, verified.issuer, verified.subject, now, now),
        // The partial unique indexes on active email and active (issuer,
        // subject) are what actually decide a race between two signups for
        // the same identity: the loser's INSERT above throws a plain D1
        // error, aborting its whole batch before this guard even runs. This
        // guard exists so a provisioning write is checked the same way every
        // other write in this batch is.
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
    try {
      await this.db.batch(statements);
    } catch (error) {
      // Distinguishes one coded failure from every other batch failure, the
      // way tenant-members-repository.ts's `add` does for its own equivalent
      // conflict: an email already an active member under a *different*
      // Google identity throws here as a plain (uncoded) unique-index
      // violation on provisioning's INSERT — this identity is not who holds
      // that email, so it is a login refusal (`login=denied`), not a
      // transient failure (`login=failed`). A genuine race between two
      // sign-ins for the *same* identity must still surface as that plain D1
      // error (a retry then simply succeeds against the row the winner
      // wrote): the re-check below only matches a *different* subject, so it
      // does not fire for that case.
      const heldByAnother = await this.db.prepare(
        "SELECT 1 FROM portal_tenant_members WHERE email = ? AND active = 1 AND subject <> ?",
      ).bind(verified.email, verified.subject).first();
      if (heldByAnother) throw new AdminAccessError("forbidden");
      throw error;
    }
    return { memberId: member.member_id, tenantId: member.tenant_id, principalId: member.principal_id, token: issued.token, csrfToken: issued.csrfToken };
  }
}
