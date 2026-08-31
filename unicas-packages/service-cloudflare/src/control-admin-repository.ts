import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CasOperatorIdentityKey } from "@unicas/admin-protocol";
import type {
  ControlAuditRecord,
  ControlCreateStackCommitResult,
  ControlCreateStackPlan,
  ControlIdempotencyRecord,
  ControlIdentityPlan,
  ControlIdentityRecord,
  ControlMembershipRecord,
  ControlPatchStackCommitResult,
  ControlPatchStackPlan,
  ControlPlaneAdminRepository,
  ControlStackRecord,
} from "@unicas/service";

const SNAPSHOT_KEY = "snapshot";

/** D1 storage adapter for the cloud-neutral control admin semantic repository. */
export class D1ControlPlaneAdminRepository implements ControlPlaneAdminRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async getIdentity(identity: CasOperatorIdentityKey): Promise<ControlIdentityRecord | null> {
    const row = await this.#db
      .prepare("SELECT identity_issuer, subject, display_name, email_for_display, created_at FROM cas_operator_identities WHERE identity_issuer = ? AND subject = ?")
      .bind(identity.identityIssuer, identity.subject)
      .first<IdentityRow>();
    return row ? toIdentity(row) : null;
  }

  async commitIdentity(plan: ControlIdentityPlan): Promise<void> {
    const statement = plan.kind === "insert"
      ? this.#db.prepare("INSERT INTO cas_operator_identities (identity_issuer, subject, display_name, email_for_display, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(plan.identity.identityIssuer, plan.identity.subject, plan.identity.displayName, plan.identity.emailForDisplay, plan.identity.createdAt)
      : this.#db.prepare("UPDATE cas_operator_identities SET display_name = ?, email_for_display = ? WHERE identity_issuer = ? AND subject = ?")
        .bind(plan.identity.displayName, plan.identity.emailForDisplay, plan.identity.identityIssuer, plan.identity.subject);
    await this.#db.batch([statement, this.#auditStatement(plan.audit)]);
  }

  async listMemberships(identity: CasOperatorIdentityKey): Promise<readonly ControlMembershipRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT m.stack_id, m.identity_issuer, m.subject, m.joined_at, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.identity_issuer = ? AND m.subject = ? ORDER BY m.stack_id",
      )
      .bind(identity.identityIssuer, identity.subject)
      .all<MembershipRow>();
    return (rows.results ?? []).map(toMembership);
  }

  async readSnapshot(): Promise<number> {
    const row = await this.#db
      .prepare("SELECT value FROM cas_control_meta WHERE key = ?")
      .bind(SNAPSHOT_KEY)
      .first<{ value: number }>();
    return row?.value ?? 0;
  }

  async listStacks(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly afterStackId: string;
    readonly limit: number;
  }): Promise<readonly ControlStackRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT s.stack_id, s.display_name, s.description, s.status, s.created_at, s.revision FROM cas_stacks s JOIN cas_stack_members m ON m.stack_id = s.stack_id WHERE m.identity_issuer = ? AND m.subject = ? AND s.stack_id > ? ORDER BY s.stack_id LIMIT ?",
      )
      .bind(input.identity.identityIssuer, input.identity.subject, input.afterStackId, input.limit)
      .all<StackRow>();
    return (rows.results ?? []).map(toStack);
  }

  async getStack(stackId: string): Promise<ControlStackRecord | null> {
    const row = await this.#db
      .prepare("SELECT stack_id, display_name, description, status, created_at, revision FROM cas_stacks WHERE stack_id = ?")
      .bind(stackId)
      .first<StackRow>();
    return row ? toStack(row) : null;
  }

  async hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?")
      .bind(stackId, identity.identityIssuer, identity.subject)
      .first<{ ok: number }>();
    return row !== null;
  }

  async getIdempotency(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT identity_issuer, subject, method, canonical_route, idempotency_key, payload_hash, response_json, created_at, expires_at FROM cas_control_idempotency WHERE identity_issuer = ? AND subject = ? AND method = ? AND canonical_route = ? AND idempotency_key = ? AND expires_at > ?",
      )
      .bind(input.identity.identityIssuer, input.identity.subject, input.method, input.canonicalRoute, input.key, input.now)
      .first<IdempotencyRow>();
    return row ? toIdempotency(row) : null;
  }

  async commitCreateStack(plan: ControlCreateStackPlan): Promise<ControlCreateStackCommitResult> {
    const statements = [
      ...this.#mutationStatements(plan.audit),
      this.#db.prepare("INSERT INTO cas_stacks (stack_id, display_name, description, status, created_at, revision) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(plan.stack.stackId, plan.stack.displayName, plan.stack.description, plan.stack.status, plan.stack.createdAt, plan.stack.revision),
      this.#db.prepare("INSERT INTO cas_stack_members (stack_id, identity_issuer, subject, joined_at) VALUES (?, ?, ?, ?)")
        .bind(plan.membership.stackId, plan.membership.identityIssuer, plan.membership.subject, plan.membership.joinedAt),
    ];
    if (plan.idempotency) statements.push(this.#idempotencyStatement(plan.idempotency));
    try {
      await this.#db.batch(statements);
      return { kind: "created" };
    } catch (error) {
      if (plan.idempotency && isUniqueViolation(error, "cas_control_idempotency")) {
        const record = await this.getIdempotency({
          identity: plan.idempotency,
          method: plan.idempotency.method,
          canonicalRoute: plan.idempotency.canonicalRoute,
          key: plan.idempotency.key,
          now: plan.idempotency.createdAt,
        });
        if (record) return { kind: "idempotency-race", record };
      }
      throw error;
    }
  }

  async commitPatchStack(plan: ControlPatchStackPlan): Promise<ControlPatchStackCommitResult> {
    const update = this.#db
      .prepare("UPDATE cas_stacks SET display_name = ?, description = ?, revision = ? WHERE stack_id = ? AND revision = ?")
      .bind(plan.displayName, plan.description, plan.nextRevision, plan.stackId, plan.expectedRevision);
    const requireUpdated = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
    );
    try {
      await this.#db.batch([update, requireUpdated, ...this.#mutationStatements(plan.audit)]);
      return { kind: "updated" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      const current = await this.getStack(plan.stackId);
      return current ? { kind: "revision-mismatch" } : { kind: "not-found" };
    }
  }

  async appendAudit(record: ControlAuditRecord): Promise<void> {
    await this.#auditStatement(record).run();
  }

  #mutationStatements(audit: ControlAuditRecord): D1PreparedStatement[] {
    return [
      this.#db.prepare("INSERT OR IGNORE INTO cas_control_meta (key, value) VALUES (?, 0)").bind(SNAPSHOT_KEY),
      this.#db.prepare("UPDATE cas_control_meta SET value = value + 1 WHERE key = ?").bind(SNAPSHOT_KEY),
      this.#auditStatement(audit),
    ];
  }

  #auditStatement(record: ControlAuditRecord): D1PreparedStatement {
    return this.#db.prepare(
      "INSERT INTO cas_control_audit_events (event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.eventId,
      record.stackId,
      record.identityIssuer,
      record.subject,
      record.action,
      record.target,
      record.requestId,
      record.traceId,
      record.callerChannel,
      record.oauthClientHandle,
      record.toolName,
      record.createdAt,
    );
  }

  #idempotencyStatement(record: ControlIdempotencyRecord): D1PreparedStatement {
    return this.#db.prepare(
      "INSERT INTO cas_control_idempotency (identity_issuer, subject, method, canonical_route, idempotency_key, payload_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.identityIssuer,
      record.subject,
      record.method,
      record.canonicalRoute,
      record.key,
      record.payloadHash,
      JSON.stringify(record.response),
      record.createdAt,
      record.expiresAt,
    );
  }
}

interface IdentityRow {
  readonly identity_issuer: string;
  readonly subject: string;
  readonly display_name: string | null;
  readonly email_for_display: string | null;
  readonly created_at: number;
}

interface StackRow {
  readonly stack_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly status: string;
  readonly created_at: number;
  readonly revision: number;
}

interface MembershipRow {
  readonly stack_id: string;
  readonly identity_issuer: string;
  readonly subject: string;
  readonly display_name: string | null;
  readonly email_for_display: string | null;
  readonly joined_at: number;
}

interface IdempotencyRow {
  readonly identity_issuer: string;
  readonly subject: string;
  readonly method: string;
  readonly canonical_route: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
}

function toIdentity(row: IdentityRow): ControlIdentityRecord {
  return {
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    displayName: row.display_name,
    emailForDisplay: row.email_for_display,
    createdAt: row.created_at,
  };
}

function toStack(row: StackRow): ControlStackRecord {
  return {
    stackId: row.stack_id,
    displayName: row.display_name,
    description: row.description,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
    revision: row.revision,
  };
}

function toMembership(row: MembershipRow): ControlMembershipRecord {
  return {
    stackId: row.stack_id,
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    displayName: row.display_name,
    emailForDisplay: row.email_for_display,
    joinedAt: row.joined_at,
  };
}

function toIdempotency(row: IdempotencyRow): ControlIdempotencyRecord {
  return {
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    method: row.method,
    canonicalRoute: row.canonical_route,
    key: row.idempotency_key,
    payloadHash: row.payload_hash,
    response: JSON.parse(row.response_json) as ControlStackRecord,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function isUniqueViolation(error: unknown, table: string): boolean {
  return error instanceof Error
    && error.message.includes("UNIQUE constraint failed")
    && error.message.includes(table);
}

function isJsonFailure(error: unknown): boolean {
  return error instanceof Error && /malformed JSON/i.test(error.message);
}
