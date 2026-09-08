import type { Administrator, AdminAuditEvent, AdminCommandResult, AdminDirectoryStore, AdminDirectoryTransaction } from "@unidocs/gateway-common";
import type { AdminTypeRegistration, AdminUrlValidation } from "@unidocs/gateway-common";

export interface AdminSqliteStorage {
  readonly sql: { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<Result>(callback: () => Result): Result;
}

export class SqliteAdminDirectoryStore implements AdminDirectoryStore {
  constructor(private readonly storage: AdminSqliteStorage) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS unidocs_admin_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), initialized INTEGER NOT NULL)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS unidocs_administrators (
        admin_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, issuer TEXT, subject TEXT,
        added_by TEXT NOT NULL, added_at TEXT NOT NULL, revision INTEGER NOT NULL,
        CHECK ((issuer IS NULL AND subject IS NULL) OR (issuer IS NOT NULL AND subject IS NOT NULL)), UNIQUE(issuer, subject))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS unidocs_admin_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS unidocs_admin_commands (actor_id TEXT NOT NULL, request_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(actor_id, request_key))`);
      storage.sql.exec("CREATE TABLE IF NOT EXISTS unidocs_admin_types (doc_type TEXT PRIMARY KEY, payload TEXT NOT NULL)");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS unidocs_admin_url_validations (validation_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS unidocs_admin_type_commands (actor_id TEXT NOT NULL, request_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(actor_id, request_key))");
    });
  }

  async transact<Result>(callback: (transaction: AdminDirectoryTransaction) => Result): Promise<Result> {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const find = (query: string, value: string) => {
        const row = sql.exec(query, value).toArray()[0];
        return row ? administrator(row) : null;
      };
      const result = callback({
        types: () => sql.exec("SELECT payload FROM unidocs_admin_types ORDER BY doc_type").toArray().map(row => JSON.parse(String(row.payload)) as AdminTypeRegistration),
        type: docType => {
          const row = sql.exec("SELECT payload FROM unidocs_admin_types WHERE doc_type = ?", docType).toArray()[0];
          return row ? JSON.parse(String(row.payload)) as AdminTypeRegistration : null;
        },
        putType: record => { sql.exec("INSERT INTO unidocs_admin_types VALUES (?, ?) ON CONFLICT(doc_type) DO UPDATE SET payload = excluded.payload", record.docType, JSON.stringify(record)); },
        validation: id => {
          const row = sql.exec("SELECT payload FROM unidocs_admin_url_validations WHERE validation_id = ?", id).toArray()[0];
          return row ? JSON.parse(String(row.payload)) as AdminUrlValidation : null;
        },
        putValidation: (record, now) => {
          sql.exec("DELETE FROM unidocs_admin_url_validations WHERE expires_at <= ?", now);
          if (Number(sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_url_validations").toArray()[0]!.count) >= 1000) throw new Error("Validation capacity reached");
          sql.exec("INSERT INTO unidocs_admin_url_validations VALUES (?, ?, ?)", record.validationId, record.expiresAt, JSON.stringify(record));
        },
        typeCommand: (actorId, key) => {
          const row = sql.exec("SELECT payload FROM unidocs_admin_type_commands WHERE actor_id = ? AND request_key = ?", actorId, key).toArray()[0];
          return row ? JSON.parse(String(row.payload)) : null;
        },
        rememberType: (actorId, key, outcome) => {
          if (Number(sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_type_commands").toArray()[0]!.count) >= 100_000) throw new Error("Type command capacity reached");
          sql.exec("INSERT INTO unidocs_admin_type_commands VALUES (?, ?, ?)", actorId, key, JSON.stringify(outcome));
        },
        appendTypeAudit: (actorId, action, before, after, reason) => {
          if (Number(sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_audit").toArray()[0]!.count) >= 100_000) throw new Error("Management audit capacity reached");
          const eventId = crypto.randomUUID();
          sql.exec("INSERT INTO unidocs_admin_audit(event_id, payload) VALUES (?, ?)", eventId, JSON.stringify({ eventId, actorId, action, targetId: after.docType, occurredAt: after.updatedAt, before, after, reason }));
        },
        initialized: () => sql.exec("SELECT singleton FROM unidocs_admin_state WHERE initialized = 1").toArray().length > 0,
        markInitialized: () => { sql.exec("INSERT INTO unidocs_admin_state VALUES (1, 1)"); },
        byId: adminId => find("SELECT * FROM unidocs_administrators WHERE admin_id = ?", adminId),
        byEmail: email => find("SELECT * FROM unidocs_administrators WHERE email = ?", email),
        list: () => sql.exec("SELECT * FROM unidocs_administrators ORDER BY email").toArray().map(administrator),
        insert: record => { sql.exec("INSERT INTO unidocs_administrators VALUES (?, ?, ?, ?, ?, ?, ?)", record.adminId, record.email, record.issuer, record.subject, record.addedBy, record.addedAt, record.revision); },
        bind: (adminId, issuer, subject) => { sql.exec("UPDATE unidocs_administrators SET issuer = ?, subject = ?, revision = revision + 1 WHERE admin_id = ?", issuer, subject, adminId); },
        remove: adminId => { sql.exec("DELETE FROM unidocs_administrators WHERE admin_id = ?", adminId); },
        appendAudit: event => {
          if (Number(sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_audit").toArray()[0]!.count) >= 100_000) throw new Error("Management audit capacity reached");
          sql.exec("INSERT INTO unidocs_admin_audit(event_id, payload) VALUES (?, ?)", event.eventId, JSON.stringify(event));
        },
        audit: () => sql.exec("SELECT payload FROM unidocs_admin_audit ORDER BY sequence DESC LIMIT 100").toArray().map(row => JSON.parse(String(row.payload)) as AdminAuditEvent),
        command: (actorId, key) => {
          const row = sql.exec("SELECT payload FROM unidocs_admin_commands WHERE actor_id = ? AND request_key = ?", actorId, key).toArray()[0];
          return row ? JSON.parse(String(row.payload)) as AdminCommandResult : null;
        },
        remember: (actorId, key, outcome) => {
          if (Number(sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_commands").toArray()[0]!.count) >= 100_000) throw new Error("Management command capacity reached");
          sql.exec("INSERT INTO unidocs_admin_commands VALUES (?, ?, ?)", actorId, key, JSON.stringify(outcome));
        },
      });
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Admin transaction must be synchronous");
      return result;
    });
  }
}

function administrator(row: Record<string, unknown>): Administrator {
  return { adminId: String(row.admin_id), email: String(row.email), issuer: row.issuer === null ? null : String(row.issuer), subject: row.subject === null ? null : String(row.subject), addedBy: String(row.added_by), addedAt: String(row.added_at), revision: Number(row.revision) };
}