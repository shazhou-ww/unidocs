/** `unicas members list|invite|remove`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  confirmOrPrompt,
  idempotencyKeyFromFlag,
  requireSubcommand,
  resolveStackEtag,
  withAdminClient,
} from "./common.js";
import { printJson } from "../output.js";
import { parseBoundedLimit } from "./stacks.js";

export async function membersCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas members list|invite|remove", ["list", "invite", "remove"]);
  switch (subcommand) {
    case "list":
      return membersList(ctx, argv);
    case "invite":
      return membersInvite(ctx, argv);
    case "remove":
      return membersRemove(ctx, argv);
    default:
      throw new Error("usage: unicas members list|invite|remove");
  }
}

async function membersList(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, cursor: { type: "string" } },
    allowPositionals: true,
  });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas members list <stackId> [--limit N] [--cursor C]");
  await withAdminClient(ctx, async (admin) => {
    const page = await admin.listMembers(
      { stackId },
      {
        ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
        ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      },
    );
    printJson(page);
  });
}

async function membersInvite(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "idempotency-key": { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, email] = positionals;
  if (!stackId || !email) throw new Error("usage: unicas members invite <stackId> <email> [--idempotency-key K]");
  await withAdminClient(ctx, async (admin) => {
    const result = await admin.createMemberInvitation(
      { stackId },
      { emailConstraint: email },
      { idempotencyKey: idempotencyKeyFromFlag(values["idempotency-key"]) },
    );
    printJson(result);
  });
}

async function membersRemove(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "identity-issuer": { type: "string" },
      subject: { type: "string" },
      etag: { type: "string" },
      "confirm-subject": { type: "string" },
    },
    allowPositionals: true,
  });
  const stackId = positionals[0];
  const identityIssuer = values["identity-issuer"];
  const subject = values.subject;
  if (!stackId || !identityIssuer || !subject) {
    throw new Error("usage: unicas members remove <stackId> --identity-issuer <url> --subject <sub> [--etag E] [--confirm-subject S]");
  }
  const confirmSubject = await confirmOrPrompt({
    flag: values["confirm-subject"],
    expected: subject,
    label: "confirm-subject",
  });
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? (await resolveStackEtag(admin, stackId));
    const result = await admin.deleteMember({ stackId }, { identityIssuer, subject }, etag);
    printJson({ ...result, confirmSubject });
  });
}
