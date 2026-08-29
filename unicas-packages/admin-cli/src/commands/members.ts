/** `unicas members list|invite|remove`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  confirmOrPrompt,
  idempotencyKeyFromFlag,
  requireLoggedIn,
  requireSubcommand,
  requireToolSuccess,
  resolveStackEtag,
  withRemote,
} from "./common.js";
import { printJson } from "../output.js";
import { parseBoundedLimit } from "./stacks.js";
import type { CasAdminDeleteMemberResponse, CasAdminPage, CasMemberInvitation, CasStackMember } from "@unicas/admin-protocol";

export async function membersCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas members list|invite|remove", ["list", "invite", "remove"]);
  const session = await ctx.store.load();
  requireLoggedIn(session);
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
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_members", {
      stackId,
      ...(values.limit !== undefined ? { limit: parseBoundedLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    requireToolSuccess(result, "list_members");
    printJson(result.structuredContent as unknown as CasAdminPage<CasStackMember>);
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
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("invite_member", {
      stackId,
      email,
      confirmEmail: email,
      idempotencyKey: idempotencyKeyFromFlag(values["idempotency-key"]),
    });
    requireToolSuccess(result, "invite_member");
    printJson(result.structuredContent as unknown as CasMemberInvitation);
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
  await withRemote(ctx, async (remote) => {
    const etag = values.etag ?? (await resolveStackEtag(remote, stackId));
    const result = await remote.callTool("remove_member", {
      stackId,
      identityIssuer,
      subject,
      etag,
      confirmSubject,
    });
    requireToolSuccess(result, "remove_member");
    printJson(result.structuredContent as unknown as CasAdminDeleteMemberResponse);
  });
}
