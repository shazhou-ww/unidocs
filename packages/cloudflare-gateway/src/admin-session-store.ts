import type { AdminBrowserSession } from "@unidocs/gateway-common";
import type { AdminSqliteStorage } from "./admin-directory-sqlite.js";
import type { GoogleLoginReplayStore } from "./oauth-identity.js";

export interface StoredAdminSession extends AdminBrowserSession { readonly loginId: string; readonly idleExpiresAt: number; }
export const ADMIN_IDLE_MS = 30 * 60_000;

export class SqliteAdminSessionStore implements GoogleLoginReplayStore {
  constructor(private readonly storage: AdminSqliteStorage) {
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS unidocs_admin_login_nonces (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS unidocs_admin_sessions (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, payload TEXT NOT NULL)");
    });
  }

  async register(nonce: string, expiresAt: number): Promise<void> {
    const digest = await hash(nonce);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM unidocs_admin_login_nonces WHERE expires_at <= ?", Date.now());
      const count = Number(this.storage.sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_login_nonces").toArray()[0]!.count);
      if (count >= 10_000) throw new Error("Login transaction capacity reached");
      this.storage.sql.exec("INSERT INTO unidocs_admin_login_nonces VALUES (?, ?)", digest, expiresAt);
    });
  }

  async consume(nonce: string, now: number): Promise<boolean> {
    const digest = await hash(nonce);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec("DELETE FROM unidocs_admin_login_nonces WHERE digest = ? RETURNING expires_at", digest).toArray()[0];
      return Boolean(row && Number(row.expires_at) > now);
    });
  }

  async put(token: string, session: StoredAdminSession, now: number): Promise<void> {
    const digest = await hash(token);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM unidocs_admin_sessions WHERE expires_at <= ? OR idle_expires_at <= ?", now, now);
      const count = Number(this.storage.sql.exec("SELECT COUNT(*) AS count FROM unidocs_admin_sessions").toArray()[0]!.count);
      if (count >= 1000) throw new Error("Management session capacity reached");
      this.storage.sql.exec("INSERT INTO unidocs_admin_sessions VALUES (?, ?, ?, ?)", digest, session.expiresAt, session.idleExpiresAt, JSON.stringify(session));
    });
  }

  async read(token: string, now: number): Promise<StoredAdminSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = await hash(token);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec("SELECT * FROM unidocs_admin_sessions WHERE digest = ?", digest).toArray()[0];
      if (!row) return null;
      if (Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now) {
        this.storage.sql.exec("DELETE FROM unidocs_admin_sessions WHERE digest = ?", digest);
        return null;
      }
      return { ...JSON.parse(String(row.payload)) as StoredAdminSession, idleExpiresAt: Number(row.idle_expires_at) };
    });
  }

  async touch(token: string, now: number): Promise<void> {
    const digest = await hash(token);
    this.storage.sql.exec("UPDATE unidocs_admin_sessions SET idle_expires_at = MIN(expires_at, ?) WHERE digest = ? AND expires_at > ? AND idle_expires_at > ?", now + ADMIN_IDLE_MS, digest, now, now);
  }

  async revoke(token: string): Promise<void> {
    this.storage.sql.exec("DELETE FROM unidocs_admin_sessions WHERE digest = ?", await hash(token));
  }
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function adminRandomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}