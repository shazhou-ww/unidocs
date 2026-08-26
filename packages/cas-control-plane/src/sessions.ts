/**
 * BFF session persistence. `cas-admin-webui` owns session cryptography; this
 * library owns the storage rows. The encrypted payload is opaque here — the
 * BFF encrypts the full session state (Google ID token, OIDC state/PKCE
 * verifier, CSRF token) before storing, and decrypts after reading.
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface StoredSession {
  readonly sessionId: string;
  readonly encryptedPayload: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export class ControlSessionStore {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async create(
    sessionId: string,
    encryptedPayload: string,
    ttlMs: number,
  ): Promise<void> {
    const now = this.#now();
    await this.#db
      .prepare(
        "INSERT INTO cas_admin_sessions (session_id, encrypted_payload, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(sessionId, encryptedPayload, now + ttlMs, now, now)
      .run();
  }

  /** Read a session; expired sessions are deleted and reported as absent. */
  async read(sessionId: string): Promise<StoredSession | null> {
    const now = this.#now();
    const row = await this.#db
      .prepare(
        "SELECT session_id, encrypted_payload, expires_at, created_at, last_seen_at FROM cas_admin_sessions WHERE session_id = ?",
      )
      .bind(sessionId)
      .first<StoredSessionRow>();
    if (!row) return null;
    if (row.expires_at <= now) {
      await this.#db
        .prepare("DELETE FROM cas_admin_sessions WHERE session_id = ?")
        .bind(sessionId)
        .run();
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

  /** Sliding expiry: extend the session TTL from the current time. */
  async touch(sessionId: string, ttlMs: number): Promise<void> {
    const now = this.#now();
    await this.#db
      .prepare(
        "UPDATE cas_admin_sessions SET expires_at = ?, last_seen_at = ? WHERE session_id = ?",
      )
      .bind(now + ttlMs, now, sessionId)
      .run();
  }

  async delete(sessionId: string): Promise<void> {
    await this.#db
      .prepare("DELETE FROM cas_admin_sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }

  /** Delete expired session rows; returns the number removed. */
  async pruneExpired(): Promise<number> {
    const now = this.#now();
    const result = await this.#db
      .prepare("DELETE FROM cas_admin_sessions WHERE expires_at <= ?")
      .bind(now)
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
