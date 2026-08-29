/**
 * CLI defaults and environment overrides.
 *
 * Production defaults point at the deployed Unicas control plane `/admin` API.
 * Tests and local development override `UNICAS_ADMIN_URL` and
 * `UNICAS_CONFIG_DIR`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ADMIN_ORIGIN = "https://unicas.shazhou.work";
export const DEFAULT_GOOGLE_ISSUER = "https://accounts.google.com";
/** Google Desktop (installed app) OAuth client for the CLI. Public id — not a secret. */
export const DEFAULT_GOOGLE_CLIENT_ID = "152437813368-5e621mj27so25a22vp9167ql6gcm2lfj.apps.googleusercontent.com";

export interface CliConfig {
  /** Origin of the control-plane `/admin` API. */
  readonly adminOrigin: string;
  /** Directory holding `session.json`; defaults to `~/.unicas`. */
  readonly configDir: string;
  /** Absolute path of the persisted session file. */
  readonly sessionPath: string;
  /** Google OAuth client id used for the CLI's own OIDC dance. */
  readonly googleClientId: string;
  /** Optional Google OAuth client secret (confidential clients). */
  readonly googleClientSecret?: string;
  /** Google OIDC issuer; defaults to accounts.google.com. */
  readonly googleIssuer?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const adminOrigin = env.UNICAS_ADMIN_URL?.trim().replace(/\/$/, "")
    || env.UNICAS_SERVER_URL?.trim().replace(/\/+$/, "").replace(/\/mcp$/, "")
    || DEFAULT_ADMIN_ORIGIN;
  const configDir = env.UNICAS_CONFIG_DIR?.trim() || join(homedir(), ".unicas");
  const googleClientId = env.UNICAS_GOOGLE_CLIENT_ID?.trim() || DEFAULT_GOOGLE_CLIENT_ID;
  return {
    adminOrigin,
    configDir,
    sessionPath: join(configDir, "session.json"),
    googleClientId,
    googleClientSecret: env.UNICAS_GOOGLE_CLIENT_SECRET?.trim() || undefined,
    googleIssuer: env.UNICAS_GOOGLE_ISSUER?.trim() || undefined,
  };
}
