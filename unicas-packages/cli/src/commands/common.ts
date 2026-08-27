/**
 * Shared command plumbing: context, remote-client lifecycle, ETag resolution,
 * idempotency keys, and confirmation handling.
 */

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { loadConfig } from "../config.js";
import type { CliConfig } from "../config.js";
import { CliError } from "../errors.js";
import { generateIdempotencyKey } from "../mcp/catalog.js";
import { UnicasRemoteClient } from "../remote/client.js";
import type { ToolCallResult } from "../remote/client.js";
import { TokenStore } from "../store.js";
import type { PersistedSession } from "../store.js";

export interface CliContext {
  readonly config: CliConfig;
  readonly store: TokenStore;
  readonly fetchImpl?: typeof fetch;
}

export function createContext(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): CliContext {
  const config = loadConfig(env);
  return { config, store: new TokenStore({ path: config.tokenPath }), fetchImpl };
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
  if (!session.tokens?.access_token) {
    throw new CliError("Not logged in. Run `unicas login` first.", 2);
  }
}

export async function withRemote<T>(
  ctx: CliContext,
  fn: (remote: UnicasRemoteClient) => Promise<T>,
): Promise<T> {
  const remote = new UnicasRemoteClient({
    serverUrl: ctx.config.serverUrl,
    store: ctx.store,
    fetchImpl: ctx.fetchImpl,
  });
  try {
    return await fn(remote);
  } finally {
    await remote.close();
  }
}

export function isToolError(result: ToolCallResult): boolean {
  return result.isError;
}

/** Throws with the remote tool error text when the tool reported an error. */
export function requireToolSuccess(result: ToolCallResult, operation: string): void {
  if (!result.isError) return;
  const text = result.text ?? JSON.stringify(result.structuredContent);
  throw new CliError(`${operation} failed: ${text}`, 1);
}

// ---------------------------------------------------------------------------
// ETag resolution
// ---------------------------------------------------------------------------

export async function resolveStackEtag(remote: UnicasRemoteClient, stackId: string): Promise<string> {
  const result = await remote.callTool("get_stack", { stackId });
  requireToolSuccess(result, "get_stack");
  return requireEtag(result, `stack '${stackId}'`);
}

export async function resolveIssuerEtag(remote: UnicasRemoteClient, stackId: string): Promise<string> {
  const result = await remote.callTool("get_issuer", { stackId });
  requireToolSuccess(result, "get_issuer");
  return requireEtag(result, `issuer of stack '${stackId}'`);
}

export async function resolveIssuerKeyEtag(
  remote: UnicasRemoteClient,
  stackId: string,
  kid: string,
): Promise<string> {
  const result = await remote.callTool("list_issuer_keys", { stackId });
  requireToolSuccess(result, "list_issuer_keys");
  const keys = Array.isArray(result.structuredContent.keys) ? result.structuredContent.keys : [];
  const key = keys.find((entry) => typeof entry === "object" && entry !== null
    && (entry as Record<string, unknown>).kid === kid) as Record<string, unknown> | undefined;
  if (!key) throw new CliError(`issuer key '${kid}' not found on stack '${stackId}'`, 1);
  if (typeof key.revision !== "number") {
    throw new CliError(`could not resolve a revision for issuer key '${kid}'`, 1);
  }
  return `"${key.revision}"`;
}

function requireEtag(result: ToolCallResult, resource: string): string {
  const etag = result.structuredContent.etag;
  if (typeof etag !== "string" || etag.length === 0) {
    throw new CliError(`could not resolve the current ETag for ${resource}`, 1);
  }
  return etag;
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
