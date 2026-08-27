/**
 * OAuth session persistence for the Unicas CLI.
 *
 * The session file lives at `~/.unicas/token.json` (configurable through
 * `UNICAS_CONFIG_DIR`). It stores the dynamic client registration, the OAuth
 * tokens, and cached RFC 9728/8414 discovery state. Writes are atomic (temp
 * file + rename) and the file is created with `0600` permissions so refresh
 * tokens never leak to other local users.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export interface PersistedSession {
  /** The MCP resource URL these credentials were issued for. */
  serverUrl: string;
  /** RFC 7591 dynamic client registration, when registered. */
  clientInformation?: OAuthClientInformationMixed;
  /** Current OAuth tokens. */
  tokens?: OAuthTokens;
  /** Cached RFC 9728/8414 discovery results, persisted to skip re-discovery. */
  discoveryState?: OAuthDiscoveryState;
  /** Epoch milliseconds when the file was last written. */
  savedAt?: number;
}

export interface TokenStoreOptions {
  /** Absolute path of the session file. */
  readonly path: string;
}

export class TokenStore {
  readonly #path: string;

  constructor(options: TokenStoreOptions) {
    this.#path = options.path;
  }

  get path(): string {
    return this.#path;
  }

  /** Loads the session, or an empty session when the file is absent/corrupt. */
  async load(): Promise<PersistedSession> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { serverUrl: "" };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSession>;
      if (typeof parsed !== "object" || parsed === null) return { serverUrl: "" };
      return {
        serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
        clientInformation: parsed.clientInformation,
        tokens: parsed.tokens,
        discoveryState: parsed.discoveryState,
        savedAt: parsed.savedAt,
      };
    } catch {
      // A corrupt session file must not brick the CLI; the next `unicas login`
      // overwrites it. Keep the bytes around for manual recovery.
      return { serverUrl: "" };
    }
  }

  async save(session: PersistedSession): Promise<void> {
    const payload: PersistedSession = { ...session, savedAt: Date.now() };
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    await mkdir(dirname(this.#path), { recursive: true });
    const tempPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, json, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.#path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
