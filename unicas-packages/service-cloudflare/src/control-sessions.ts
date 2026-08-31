/** D1 persistence for opaque encrypted admin BFF sessions. */

import type { D1Database } from "@cloudflare/workers-types";
import type { ControlSessionRepository, StoredSession } from "@unicas/service";

export class ControlSessionStore implements ControlSessionRepository {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async create(sessionId: string, encryptedPayload: string, ttlMs: number): Promise<void> {
    const now = this.#now();
    await this.#db
      .prepare("INSERT INTO cas_admin_sessions (session_id, encrypted_payload, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sessionId, encryptedPayload, now + ttlMs, now, now)
      .run();
  }

  async read(sessionId: string): Promise<StoredSession | null> {
    const now = this.#now();
    const row = await this.#db
      .prepare("SELECT session_id, encrypted_payload, expires_at, created_at, last_seen_at FROM cas_admin_sessions WHERE session_id = ?")
      .bind(sessionId)
      .first<StoredSessionRow>();
    if (!row) return null;
    if (row.expires_at <= now) {
      await this.delete(sessionId);
      return null;
    }
    return {
      sessionId: row.session_id,
      encryptedPayload: row.encrypted_payload,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    const now = this.#now();
    await this.#db
      .prepare("UPDATE cas_admin_sessions SET expires_at = ?, last_seen_at = ? WHERE session_id = ?")
      .bind(now + ttlMs, now, sessionId)
      .run();
  }

  async delete(sessionId: string): Promise<void> {
    await this.#db
      .prepare("DELETE FROM cas_admin_sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }

  async pruneExpired(): Promise<number> {
    const result = await this.#db
      .prepare("DELETE FROM cas_admin_sessions WHERE expires_at <= ?")
      .bind(this.#now())
      .run();
    return result.meta.changes ?? 0;
  }
}

interface StoredSessionRow {
  readonly session_id: string;
  readonly encrypted_payload: string;
  readonly expires_at: number;
  readonly created_at: number;
  readonly last_seen_at: number;
}
