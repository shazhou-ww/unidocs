/**
 * Shared command plumbing: context, admin-client lifecycle, ETag resolution,
 * idempotency keys, and confirmation handling.
 */

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createAdminClient } from "@unicas/admin-client";
import type { AdminClient } from "@unicas/admin-client";
import { loadConfig } from "../config.js";
import type { CliConfig } from "../config.js";
import { CliError } from "../errors.js";
import { generateIdempotencyKey } from "../mcp/catalog.js";
import { TokenStore } from "../store.js";
import type { PersistedSession } from "../store.js";

export interface CliContext {
  readonly config: CliConfig;
  readonly store: TokenStore;
  readonly fetchImpl?: typeof fetch;
}

export function createContext(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): CliContext {
  const config = loadConfig(env);
  return { config, store: new TokenStore({ path: config.sessionPath }), fetchImpl };
}

export async function loadSession(ctx: CliContext): Promise<PersistedSession> {
  return ctx.store.load();
}

/** Validates a subcommand before any session/network work happens. */
export function requireSubcommand(
  subcommand: string | undefined,
  usage: string,
  allowed: readonly string[],
): asserts subcommand is string {
  if (subcommand === undefined || !allowed.includes(subcommand)) {
    throw new Error(usage);
  }
}

export function requireLoggedIn(session: PersistedSession): void {
  if (session.cookie.length === 0 || session.csrfToken.length === 0) {
    throw new CliError("Not logged in. Run `unicas login` first.", 2);
  }
}

/**
 * Builds the admin client from the persisted session and runs `fn` with it.
 * The client re-fetches the session lazily, so a 401 mid-command surfaces as
 * `AdminClientError` and the caller decides whether to prompt for login.
 */
export async function withAdminClient<T>(
  ctx: CliContext,
  fn: (admin: AdminClient) => Promise<T>,
): Promise<T> {
  const session = await ctx.store.load();
  requireLoggedIn(session);
  const admin = createAdminClient({
    baseUrl: ctx.config.adminOrigin,
    getSession: async () => ({ cookie: session.cookie, csrfToken: session.csrfToken }),
    fetcher: ctx.fetchImpl,
  });
  return fn(admin);
}

// ---------------------------------------------------------------------------
// ETag resolution
// ---------------------------------------------------------------------------

export async function resolveStackEtag(admin: AdminClient, stackId: string): Promise<string> {
  const { etag } = await admin.getStack({ stackId });
  if (etag.length === 0) {
    throw new CliError(`could not resolve the current ETag for stack '${stackId}'`, 1);
  }
  return etag;
}

export async function resolveIssuerEtag(admin: AdminClient, stackId: string): Promise<string> {
  const { etag } = await admin.getIssuer({ stackId });
  if (etag.length === 0) {
    throw new CliError(`could not resolve the current ETag for issuer of stack '${stackId}'`, 1);
  }
  return etag;
}

export async function resolveOAuthIssuerEtag(admin: AdminClient, stackId: string): Promise<string> {
  const { etag } = await admin.getOAuthIssuer({ stackId });
  if (etag.length === 0) {
    throw new CliError(`could not resolve the current ETag for OAuth issuer of stack '${stackId}'`, 1);
  }
  return etag;
}

export async function resolveIssuerKeyEtag(
  admin: AdminClient,
  stackId: string,
  kid: string,
): Promise<string> {
  const { keys } = await admin.listIssuerKeys({ stackId });
  const key = keys.find((entry) => entry.kid === kid);
  if (!key) throw new CliError(`issuer key '${kid}' not found on stack '${stackId}'`, 1);
  return `"${key.revision}"`;
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

export function idempotencyKeyFromFlag(flag: string | undefined): string {
  return flag?.trim() || generateIdempotencyKey();
}

// ---------------------------------------------------------------------------
// Confirmation handling
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  readonly flag: string | undefined;
  readonly expected: string;
  readonly label: string;
  readonly input?: Readable;
}

/**
 * Returns the confirmed target value. When the explicit `--confirm-*` flag is
 * absent, prompts on a TTY; scripted (non-TTY) usage must pass the flag.
 */
export async function confirmOrPrompt(options: ConfirmOptions): Promise<string> {
  const value = options.flag?.trim() ?? "";
  if (value !== "") {
    if (value !== options.expected) {
      throw new CliError(`${options.label} confirmation does not match the requested target`, 1);
    }
    return value;
  }
  const input = options.input ?? process.stdin;
  if ((input as { isTTY?: boolean }).isTTY !== true) {
    throw new CliError(
      `${options.label} requires explicit confirmation; pass --${options.label} "${options.expected}"`,
      1,
    );
  }
  const answer = await prompt(`${options.label} (type "${options.expected}" to confirm): `, input);
  if (answer !== options.expected) {
    throw new CliError("confirmation did not match; aborting", 1);
  }
  return answer;
}

function prompt(question: string, input: Readable): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
