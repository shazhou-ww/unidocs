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

export interface CliConfig {
  /** Origin of the control-plane `/admin` API. */
  readonly adminOrigin: string;
  /** Directory holding `session.json`; defaults to `~/.unicas`. */
  readonly configDir: string;
  /** Absolute path of the persisted session file. */
  readonly sessionPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const adminOrigin = env.UNICAS_ADMIN_URL?.trim().replace(/\/$/, "")
    || env.UNICAS_SERVER_URL?.trim().replace(/\/+$/, "").replace(/\/mcp$/, "")
    || DEFAULT_ADMIN_ORIGIN;
  const configDir = env.UNICAS_CONFIG_DIR?.trim() || join(homedir(), ".unicas");
  return {
    adminOrigin,
    configDir,
    sessionPath: join(configDir, "session.json"),
  };
}
