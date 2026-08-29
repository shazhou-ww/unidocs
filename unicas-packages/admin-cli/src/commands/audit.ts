/** `unicas audit control|root-domain-refs|root-domain-events`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import { requireLoggedIn, requireSubcommand, requireToolSuccess, withRemote } from "./common.js";
import { printJson } from "../output.js";
import { parseBoundedLimit } from "./stacks.js";
import type { CasAdminPage, CasControlAuditEvent, CasRootRefBalance, CasRootRefEvent } from "@unicas/admin-protocol";

export async function auditCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(
    subcommand,
    "usage: unicas audit control|root-domain-refs|root-domain-events",
    ["control", "root-domain-refs", "root-domain-events"],
  );
  const session = await ctx.store.load();
  requireLoggedIn(session);
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
    options: { limit: { type: "string" }, cursor: { type: "string" }, after: { type: "string" } },
    allowPositionals: true,
  });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas audit control <stackId> [--limit N] [--cursor C] [--after ID]");
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_control_audit_events", {
      stackId,
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      ...(values.after !== undefined ? { after: values.after } : {}),
    });
    requireToolSuccess(result, "list_control_audit_events");
    printJson(result.structuredContent as unknown as CasAdminPage<CasControlAuditEvent>);
  });
}

async function auditRootDomainRefs(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "tenant-id": { type: "string" }, limit: { type: "string" }, cursor: { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, refDomain] = positionals;
  if (!stackId || !refDomain) {
    throw new Error("usage: unicas audit root-domain-refs <stackId> <refDomain> [--tenant-id T] [--limit N] [--cursor C]");
  }
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_root_domain_refs", {
      stackId,
      refDomain,
      ...(values["tenant-id"] !== undefined ? { tenantId: values["tenant-id"] } : {}),
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    requireToolSuccess(result, "list_root_domain_refs");
    printJson(result.structuredContent as unknown as { revision: number; refs: readonly CasRootRefBalance[]; nextCursor: string | null });
  });
}

async function auditRootDomainEvents(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "tenant-id": { type: "string" }, after: { type: "string" }, limit: { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, refDomain] = positionals;
  if (!stackId || !refDomain) {
    throw new Error("usage: unicas audit root-domain-events <stackId> <refDomain> [--tenant-id T] [--after N] [--limit N]");
  }
  const after = values.after === undefined ? undefined : parseNonNegativeInt(values.after);
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_root_domain_events", {
      stackId,
      refDomain,
      ...(values["tenant-id"] !== undefined ? { tenantId: values["tenant-id"] } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
    });
    requireToolSuccess(result, "list_root_domain_events");
    printJson(result.structuredContent as unknown as { events: readonly CasRootRefEvent[]; latestRevision: number; nextAfter: number });
  });
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid --after '${value}'; expected a non-negative integer`);
  }
  return parsed;
}
