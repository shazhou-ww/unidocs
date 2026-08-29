/** `unicas stacks list|get|create|update`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  idempotencyKeyFromFlag,
  requireSubcommand,
  resolveStackEtag,
  withAdminClient,
} from "./common.js";
import { printJson } from "../output.js";

export async function stacksCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas stacks list|get|create|update", ["list", "get", "create", "update"]);
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
  await withAdminClient(ctx, async (admin) => {
    const page = await admin.listStacks({
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    printJson(page);
  });
}

async function stacksGet(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas stacks get <stackId>");
  await withAdminClient(ctx, async (admin) => {
    printJson((await admin.getStack({ stackId })).value);
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
  await withAdminClient(ctx, async (admin) => {
    const stack = await admin.createStack(
      { displayName },
      { idempotencyKey: idempotencyKeyFromFlag(values["idempotency-key"]) },
    );
    printJson(stack);
  });
}

async function stacksUpdate(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      description: { type: "string" },
      etag: { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, displayName] = positionals;
  if (!stackId || (!displayName && values.description === undefined)) {
    throw new Error("usage: unicas stacks update <stackId> [displayName] [--description D] [--etag E]");
  }
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? (await resolveStackEtag(admin, stackId));
    const { value } = await admin.patchStack(
      { stackId },
      {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
      },
      etag,
    );
    printJson(value);
  });
}

export function parseBoundedLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`invalid --limit '${value}'; expected an integer between 1 and 200`);
  }
  return limit;
}
