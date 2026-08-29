/** `unicas audit control|root-domain-refs|root-domain-events`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import { requireSubcommand, withAdminClient } from "./common.js";
import { printJson } from "../output.js";
import { parseBoundedLimit } from "./stacks.js";

export async function auditCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas audit control|root-domain-refs|root-domain-events", ["control", "root-domain-refs", "root-domain-events"]);
  switch (subcommand) {
    case "control":
      return auditControl(ctx, argv);
    case "root-domain-refs":
      return auditRootDomainRefs(ctx, argv);
    case "root-domain-events":
      return auditRootDomainEvents(ctx, argv);
    default:
      throw new Error("usage: unicas audit control|root-domain-refs|root-domain-events");
  }
}

async function auditControl(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, cursor: { type: "string" } },
    allowPositionals: true,
  });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas audit control <stackId> [--limit N] [--cursor C]");
  await withAdminClient(ctx, async (admin) => {
    const page = await admin.listControlAuditEvents(
      { stackId },
      {
        ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
        ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      },
    );
    printJson(page);
  });
}

async function auditRootDomainRefs(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, refDomain] = positionals;
  if (!stackId || !refDomain) throw new Error("usage: unicas audit root-domain-refs <stackId> <refDomain> [--tenant-id T] [--limit N] [--cursor C]");
  await withAdminClient(ctx, async (admin) => {
    const result = await admin.listRootDomainRefs(
      { stackId, refDomain },
      {
        ...(values["tenant-id"] !== undefined ? { tenantId: values["tenant-id"] } : {}),
        ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
        ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      },
    );
    printJson(result);
  });
}

async function auditRootDomainEvents(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, refDomain] = positionals;
  if (!stackId || !refDomain) throw new Error("usage: unicas audit root-domain-events <stackId> <refDomain> [--tenant-id T] [--after N] [--limit N]");
  await withAdminClient(ctx, async (admin) => {
    const result = await admin.listRootDomainEvents(
      { stackId, refDomain },
      {
        ...(values["tenant-id"] !== undefined ? { tenantId: values["tenant-id"] } : {}),
        ...(values.after !== undefined ? { after: parseAfter(values.after) } : {}),
        ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      },
    );
    printJson(result);
  });
}

function parseAfter(value: string): number {
  const after = Number(value);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new Error(`invalid --after '${value}'; expected a non-negative integer`);
  }
  return after;
}
