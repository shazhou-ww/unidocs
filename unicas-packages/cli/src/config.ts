/**
 * CLI defaults and environment overrides.
 *
 * Production defaults point at the deployed Unicas control plane edge. Tests and
 * local development override `UNICAS_SERVER_URL` and `UNICAS_CONFIG_DIR`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RESOURCE_URL = "https://unicas.shazhou.work/mcp";

export const CONTROL_PLANE_SCOPES = [
  "control:read",
  "control:write",
  "control:security",
] as const;

export type ControlPlaneScope = (typeof CONTROL_PLANE_SCOPES)[number];

export interface CliConfig {
  /** Canonical MCP resource URL of the control plane. */
  readonly serverUrl: string;
  /** Directory holding `token.json`; defaults to `~/.unicas`. */
  readonly configDir: string;
  /** Absolute path of the persisted OAuth session file. */
  readonly tokenPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const serverUrl = env.UNICAS_SERVER_URL?.trim() || DEFAULT_RESOURCE_URL;
  const configDir = env.UNICAS_CONFIG_DIR?.trim() || join(homedir(), ".unicas");
  return {
    serverUrl,
    configDir,
    tokenPath: join(configDir, "token.json"),
  };
}

export function parseScopes(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [...CONTROL_PLANE_SCOPES];
  }
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  for (const scope of scopes) {
    if (!(CONTROL_PLANE_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(
        `unknown scope '${scope}'; expected one of: ${CONTROL_PLANE_SCOPES.join(", ")}`,
      );
    }
  }
  return scopes;
}
