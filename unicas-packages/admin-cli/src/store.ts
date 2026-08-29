/**
 * Admin session persistence for the Unicas CLI.
 *
 * The session file lives at `~/.unicas/session.json` (configurable through
 * `UNICAS_CONFIG_DIR`). It stores the `/admin` BFF session cookie and CSRF
 * token minted by `unicas login`. Writes are atomic (temp file + rename) and
 * the file is created with `0600` permissions so the session never leaks to
 * other local users.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PersistedSession {
  /** Origin the session was issued for. */
  readonly adminOrigin: string;
  /** Raw `Cookie` header value for the BFF session, e.g. `cas_admin_session=...`. */
  readonly cookie: string;
  /** CSRF token the BFF issued with this session (sent on mutations). */
  readonly csrfToken: string;
  /** Verified Google identity behind the session, for `unicas status`. */
  readonly identity?: {
    readonly identityIssuer: string;
    readonly subject: string;
    readonly displayName: string | null;
    readonly emailForDisplay: string | null;
  };
  /** Epoch milliseconds when the file was last written. */
  readonly savedAt?: number;
}

export interface TokenStoreOptions {
  readonly path: string;
}

export class TokenStore {
  /** Absolute path of the session file. */
  readonly path: string;

  constructor(options: TokenStoreOptions) {
    this.path = options.path;
  }

  async load(): Promise<PersistedSession> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as PersistedSession;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.adminOrigin !== "string") {
        return { adminOrigin: "", cookie: "", csrfToken: "" };
      }
      return parsed;
    } catch {
      return { adminOrigin: "", cookie: "", csrfToken: "" };
    }
  }

  async save(session: PersistedSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(tempPath, JSON.stringify({ ...session, savedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}
