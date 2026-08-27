/** `unicas stacks list|get|create|update`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  idempotencyKeyFromFlag,
  requireLoggedIn,
  requireSubcommand,
  requireToolSuccess,
  resolveStackEtag,
  withRemote,
} from "./common.js";
import { printJson } from "../output.js";

export async function stacksCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas stacks list|get|create|update", ["list", "get", "create", "update"]);
  const session = await ctx.store.load();
  requireLoggedIn(session);
  switch (subcommand) {
    case "list":
      return stacksList(ctx, argv);
    case "get":
      return stacksGet(ctx, argv);
    case "create":
      return stacksCreate(ctx, argv);
    case "update":
      return stacksUpdate(ctx, argv);
    default:
      throw new Error("usage: unicas stacks list|get|create|update");
  }
}

async function stacksList(ctx: CliContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, cursor: { type: "string" } },
    allowPositionals: false,
  });
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_stacks", {
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    requireToolSuccess(result, "list_stacks");
    printJson(result.structuredContent);
  });
}

async function stacksGet(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas stacks get <stackId>");
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("get_stack", { stackId });
    requireToolSuccess(result, "get_stack");
    printJson(result.structuredContent);
  });
}

async function stacksCreate(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "idempotency-key": { type: "string" } },
    allowPositionals: true,
  });
  const displayName = positionals[0];
  if (!displayName) throw new Error("usage: unicas stacks create <displayName> [--idempotency-key K]");
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("create_stack", {
      displayName,
      idempotencyKey: idempotencyKeyFromFlag(values["idempotency-key"]),
    });
    requireToolSuccess(result, "create_stack");
    printJson(result.structuredContent);
  });
}

async function stacksUpdate(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { etag: { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, displayName] = positionals;
  if (!stackId || !displayName) throw new Error("usage: unicas stacks update <stackId> <displayName> [--etag E]");
  await withRemote(ctx, async (remote) => {
    const etag = values.etag ?? (await resolveStackEtag(remote, stackId));
    const result = await remote.callTool("update_stack", { stackId, displayName, etag });
    requireToolSuccess(result, "update_stack");
    printJson(result.structuredContent);
  });
}

export function parseBoundedLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`invalid --limit '${value}'; expected an integer between 1 and 200`);
  }
  return limit;
}
