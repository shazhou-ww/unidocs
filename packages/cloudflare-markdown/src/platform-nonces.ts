import { DurableObject } from "cloudflare:workers";

export class PlatformNonces extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (
      scope TEXT NOT NULL, nonce TEXT NOT NULL, retain_until INTEGER NOT NULL,
      PRIMARY KEY (scope, nonce)
    ); CREATE INDEX IF NOT EXISTS nonce_expiry ON nonces(retain_until)`);
  }

  async claim(scope: string, nonce: string, retainUntil: number): Promise<boolean> {
    const now = Date.now() / 1000;
    if (typeof scope !== "string" || scope.length === 0 || scope.length > 1024
      || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)
      || !Number.isSafeInteger(retainUntil) || retainUntil <= now || retainUntil > now + 360) {
      throw new TypeError("Invalid nonce claim");
    }
    const claimed = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM nonces WHERE retain_until <= ?", now);
      return this.ctx.storage.sql.exec(
        "INSERT INTO nonces (scope, nonce, retain_until) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING nonce",
        scope, nonce, retainUntil,
      ).toArray().length === 1;
    });
    await this.#scheduleCleanup();
    return claimed;
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM nonces WHERE retain_until <= ?", Date.now() / 1000);
    await this.#scheduleCleanup();
  }

  async #scheduleCleanup(): Promise<void> {
    const earliest = this.ctx.storage.sql.exec<{ expiry: number | null }>(
      "SELECT MIN(retain_until) AS expiry FROM nonces",
    ).one().expiry;
    if (earliest !== null) await this.ctx.storage.setAlarm(earliest * 1000);
  }
}

export function createPlatformNonceStore(namespace: DurableObjectNamespace<PlatformNonces>) {
  return {
    async claim(scope: string, nonce: string, retainUntil: number): Promise<boolean> {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)));
      const shard = digest[0].toString(16).padStart(2, "0");
      return namespace.getByName(JSON.stringify([scope, shard])).claim(scope, nonce, retainUntil);
    },
  };
}