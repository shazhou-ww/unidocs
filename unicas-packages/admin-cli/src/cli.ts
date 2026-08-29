#!/usr/bin/env node
/**
 * Unicas control-plane CLI entry point.
 *
 * Plain commands print JSON to stdout and diagnostics to stderr; `unicas mcp`
 * speaks the MCP stdio protocol on stdout and must never print anything else
 * there.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditCommand } from "./commands/audit.js";
import { createContext } from "./commands/common.js";
import { issuerCommand } from "./commands/issuer.js";
import { keysCommand } from "./commands/keys.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { membersCommand } from "./commands/members.js";
import { refDomainsCommand } from "./commands/refdomains.js";
import { stacksCommand } from "./commands/stacks.js";
import { statusCommand } from "./commands/status.js";
import { whoamiCommand } from "./commands/whoami.js";
import { CliError } from "./errors.js";
import { runMcpStdioServer } from "./mcp/stdio-server.js";
import { printError, printText } from "./output.js";

const HELP = `Unicas control-plane management CLI

Usage:
  unicas login [--port N] [--no-browser]                   Google OIDC login, then exchange for an admin session
  unicas logout                                            End the admin session and clear it locally
  unicas status                                             Show local session state
  unicas whoami                                             Current operator identity and memberships

  unicas stacks list [--limit N] [--cursor C]
  unicas stacks get <stackId>
  unicas stacks create <displayName> [--idempotency-key K]
  unicas stacks update <stackId> [displayName] [--description D] [--etag E]

  unicas members list <stackId> [--limit N] [--cursor C]
  unicas members invite <stackId> <email> [--idempotency-key K]
  unicas members remove <stackId> --identity-issuer <url> --subject <sub> [--etag E] [--confirm-subject S]

  unicas issuer get <stackId>
  unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I]

  unicas keys list <stackId>
  unicas keys challenge <stackId> <kid> <ES256|RS256|EdDSA>
  unicas keys add <stackId> <kid> <ES256|RS256|EdDSA> --public-jwk <json> --possession-proof <jws> [--idempotency-key K]
  unicas keys transition <stackId> <kid> <retiring|revoked> [--etag E] [--confirm-kid K] [--confirm-state S]

  unicas ref-domains list <stackId>
  unicas audit control <stackId> [--limit N] [--cursor C] [--after ID]
  unicas audit root-domain-refs <stackId> <refDomain> [--tenant-id T] [--limit N] [--cursor C]
  unicas audit root-domain-events <stackId> <refDomain> [--tenant-id T] [--after N] [--limit N]

  unicas mcp                                                  Run as a stdio MCP server (DSH integration)
  unicas help                                                 Show this help

Environment:
  UNICAS_ADMIN_URL          /admin API origin (default https://unicas.shazhou.work)
  UNICAS_CONFIG_DIR         session directory (default ~/.unicas)

Where a mutation needs a current ETag and none is passed, the CLI reads it
first. Destructive operations require their explicit --confirm-* flag when run
non-interactively.`;

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const ctx = createContext();
  switch (command) {
    case "login":
      await loginCommand(ctx, rest);
      return;
    case "logout":
      await logoutCommand(ctx);
      return;
    case "status":
      await statusCommand(ctx);
      return;
    case "whoami":
      await whoamiCommand(ctx);
      return;
    case "stacks": {
      const [subcommand, ...subArgs] = rest;
      await stacksCommand(ctx, subcommand, subArgs);
      return;
    }
    case "members": {
      const [subcommand, ...subArgs] = rest;
      await membersCommand(ctx, subcommand, subArgs);
      return;
    }
    case "issuer": {
      const [subcommand, ...subArgs] = rest;
      await issuerCommand(ctx, subcommand, subArgs);
      return;
    }
    case "keys": {
      const [subcommand, ...subArgs] = rest;
      await keysCommand(ctx, subcommand, subArgs);
      return;
    }
    case "ref-domains": {
      const [subcommand, ...subArgs] = rest;
      await refDomainsCommand(ctx, subcommand, subArgs);
      return;
    }
    case "audit": {
      const [subcommand, ...subArgs] = rest;
      await auditCommand(ctx, subcommand, subArgs);
      return;
    }
    case "mcp":
      await runMcpStdioServer({
        adminOrigin: ctx.config.adminOrigin,
        store: ctx.store,
        fetchImpl: ctx.fetchImpl,
      });
      return;
    case "help":
    case "--help":
    case "-h":
      printText(HELP);
      return;
    case undefined:
      printText(HELP);
      return;
    default:
      throw new CliError(`unknown command '${command}'; run \`unicas help\` for usage`, 1);
  }
}

// Guard: only run when invoked as a binary (not when imported by tests).
// Realpath comparison keeps the guard working when the script is reached
// through a symlink (e.g. `pnpm install --global ./unicas-packages/admin-cli`),
// because `import.meta.url` resolves to the real path while `process.argv[1]`
// keeps the symlink path.
function invokedAsBinary(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedAsBinary()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    printError(message);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
