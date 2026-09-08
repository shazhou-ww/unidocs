import type { AdminTypeRegistration, AdminUrlValidation } from "./admin-type-contract.js";

export class AdminDirectoryError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export interface AdminGoogleIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface Administrator {
  readonly adminId: string;
  readonly email: string;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly addedBy: string;
  readonly addedAt: string;
  readonly revision: number;
}

export interface AdminActor extends AdminGoogleIdentity { readonly adminId: string; }
export interface AdministratorAuditEvent {
  readonly eventId: string;
  readonly actorId: string;
  readonly action: "administrator.bootstrap" | "administrator.bound" | "administrator.added" | "administrator.removed";
  readonly targetId: string;
  readonly targetEmail: string;
  readonly occurredAt: string;
}

export interface AdminTypeAuditEvent {
  readonly eventId: string;
  readonly actorId: string;
  readonly action: "doctype.registered" | "doctype.updated";
  readonly targetId: string;
  readonly occurredAt: string;
  readonly before: AdminTypeRegistration | null;
  readonly after: AdminTypeRegistration;
  readonly reason: string;
}

export type AdminAuditEvent = AdministratorAuditEvent | AdminTypeAuditEvent;

export interface AdminCommandResult {
  readonly fingerprint: string;
  readonly administrator: Administrator;
}

export interface AdminTypeCommandResult {
  readonly fingerprint: string;
  readonly registration: AdminTypeRegistration;
}

export interface AdminDirectoryTransaction {
  initialized(): boolean;
  markInitialized(): void;
  byId(adminId: string): Administrator | null;
  byEmail(email: string): Administrator | null;
  list(): Administrator[];
  insert(administrator: Administrator): void;
  bind(adminId: string, issuer: string, subject: string): void;
  remove(adminId: string): void;
  appendAudit(event: AdminAuditEvent): void;
  audit(): AdminAuditEvent[];
  command(actorId: string, key: string): AdminCommandResult | null;
  remember(actorId: string, key: string, result: AdminCommandResult): void;
  types(): AdminTypeRegistration[];
  type(docType: string): AdminTypeRegistration | null;
  putType(record: AdminTypeRegistration): void;
  validation(validationId: string): AdminUrlValidation | null;
  putValidation(record: AdminUrlValidation, now: number): void;
  typeCommand(actorId: string, key: string): AdminTypeCommandResult | null;
  rememberType(actorId: string, key: string, result: AdminTypeCommandResult): void;
  appendTypeAudit(actorId: string, action: AdminTypeAuditEvent["action"], before: AdminTypeRegistration | null, after: AdminTypeRegistration, reason: string): void;
}

export interface AdminDirectoryStore {
  transact<Result>(callback: (transaction: AdminDirectoryTransaction) => Result): Promise<Result>;
}

export function normalizeAdminEmail(value: unknown): string {
  if (typeof value !== "string") throw new AdminDirectoryError("invalid_email", 400);
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)
    || email.startsWith(".") || email.includes("..") || email.includes(".@")) {
    throw new AdminDirectoryError("invalid_email", 400);
  }
  return email;
}

function googleIdentity(identity: AdminGoogleIdentity): AdminGoogleIdentity {
  if (identity.issuer !== "https://accounts.google.com" || !identity.subject || identity.subject.length > 255 || identity.emailVerified !== true) {
    throw new AdminDirectoryError("invalid_google_identity", 403);
  }
  return { issuer: identity.issuer, subject: identity.subject, email: normalizeAdminEmail(identity.email), emailVerified: true };
}

export class AdminDirectory {
  constructor(
    private readonly store: AdminDirectoryStore,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) { }

  async bootstrap(email: string): Promise<Administrator> {
    const normalized = normalizeAdminEmail(email);
    return this.store.transact(transaction => {
      if (transaction.initialized() || transaction.list().length) throw new AdminDirectoryError("already_initialized", 409);
      const administrator = this.record(normalized, "bootstrap");
      transaction.insert(administrator);
      transaction.markInitialized();
      this.audit(transaction, "bootstrap", "administrator.bootstrap", administrator);
      return administrator;
    });
  }

  async bindGoogleIdentity(identity: AdminGoogleIdentity): Promise<Administrator> {
    const verified = googleIdentity(identity);
    return this.store.transact(transaction => {
      const administrator = transaction.byEmail(verified.email);
      if (!administrator) throw new AdminDirectoryError("administrator_required", 403);
      if (administrator.subject !== null) {
        if (administrator.subject !== verified.subject || administrator.issuer !== verified.issuer) throw new AdminDirectoryError("identity_mismatch", 403);
        return administrator;
      }
      if (transaction.list().some(record => record.issuer === verified.issuer && record.subject === verified.subject)) throw new AdminDirectoryError("identity_mismatch", 403);
      transaction.bind(administrator.adminId, verified.issuer, verified.subject);
      const bound = transaction.byId(administrator.adminId)!;
      this.audit(transaction, bound.adminId, "administrator.bound", bound);
      return bound;
    });
  }

  current(actor: AdminActor): Promise<Administrator> {
    return this.store.transact(transaction => this.authorize(transaction, actor));
  }

  list(actor: AdminActor): Promise<Administrator[]> {
    return this.store.transact(transaction => { this.authorize(transaction, actor); return transaction.list(); });
  }

  listAudit(actor: AdminActor): Promise<AdminAuditEvent[]> {
    return this.store.transact(transaction => { this.authorize(transaction, actor); return transaction.audit(); });
  }

  authorized<Result>(actor: AdminActor, callback: (transaction: AdminDirectoryTransaction) => Result): Promise<Result> {
    return this.store.transact(transaction => { this.authorize(transaction, actor); return callback(transaction); });
  }

  async add(actor: AdminActor, email: string, key: string): Promise<Administrator> {
    const normalized = normalizeAdminEmail(email);
    return this.mutate(actor, key, JSON.stringify(["add", normalized]), transaction => {
      if (transaction.byEmail(normalized)) throw new AdminDirectoryError("administrator_exists", 409);
      if (transaction.list().length >= 1000) throw new AdminDirectoryError("administrator_limit", 409);
      const administrator = this.record(normalized, actor.adminId);
      transaction.insert(administrator);
      this.audit(transaction, actor.adminId, "administrator.added", administrator);
      return administrator;
    });
  }

  async remove(actor: AdminActor, adminId: string, revision: number, key: string): Promise<Administrator> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new AdminDirectoryError("invalid_revision", 400);
    return this.mutate(actor, key, JSON.stringify(["remove", adminId, revision]), transaction => {
      if (actor.adminId === adminId) throw new AdminDirectoryError("self_removal_forbidden", 409);
      const administrator = transaction.byId(adminId);
      if (!administrator) throw new AdminDirectoryError("administrator_not_found", 404);
      if (administrator.revision !== revision) throw new AdminDirectoryError("revision_conflict", 412);
      if (transaction.list().length <= 1) throw new AdminDirectoryError("last_administrator", 409);
      transaction.remove(adminId);
      this.audit(transaction, actor.adminId, "administrator.removed", administrator);
      return administrator;
    });
  }

  private authorize(transaction: AdminDirectoryTransaction, actor: AdminActor): Administrator {
    const identity = googleIdentity(actor);
    const current = transaction.byId(actor.adminId);
    if (!current || current.email !== identity.email || current.subject !== identity.subject || current.issuer !== identity.issuer) {
      throw new AdminDirectoryError("administrator_required", 403);
    }
    return current;
  }

  private mutate(actor: AdminActor, key: string, fingerprint: string, perform: (transaction: AdminDirectoryTransaction) => Administrator): Promise<Administrator> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AdminDirectoryError("invalid_idempotency_key", 400);
    return this.store.transact(transaction => {
      this.authorize(transaction, actor);
      const previous = transaction.command(actor.adminId, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AdminDirectoryError("idempotency_conflict", 409);
        return previous.administrator;
      }
      const administrator = perform(transaction);
      transaction.remember(actor.adminId, key, { fingerprint, administrator });
      return administrator;
    });
  }

  private record(email: string, addedBy: string): Administrator {
    return { adminId: this.newId(), email, issuer: null, subject: null, addedBy, addedAt: this.now(), revision: 1 };
  }

  private audit(transaction: AdminDirectoryTransaction, actorId: string, action: AdministratorAuditEvent["action"], administrator: Administrator): void {
    transaction.appendAudit({ eventId: this.newId(), actorId, action, targetId: administrator.adminId, targetEmail: administrator.email, occurredAt: this.now() });
  }
}