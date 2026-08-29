/** `unicas issuer get|set`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  confirmOrPrompt,
  requireLoggedIn,
  requireSubcommand,
  requireToolSuccess,
  withRemote,
} from "./common.js";
import { printJson } from "../output.js";
import type { CasStackIssuer } from "@unicas/admin-protocol";

export async function issuerCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas issuer get|set", ["get", "set"]);
  const session = await ctx.store.load();
  requireLoggedIn(session);
  switch (subcommand) {
    case "get":
      return issuerGet(ctx, argv);
    case "set":
      return issuerSet(ctx, argv);
    default:
      throw new Error("usage: unicas issuer get|set");
  }
}

async function issuerGet(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas issuer get <stackId>");
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("get_issuer", { stackId });
    requireToolSuccess(result, "get_issuer");
    printJson(result.structuredContent as unknown as CasStackIssuer);
  });
}

async function issuerSet(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { etag: { type: "string" }, "confirm-issuer": { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, issuer, audience] = positionals;
  if (!stackId || !issuer || !audience) {
    throw new Error("usage: unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I]");
  }
  const confirmIssuer = await confirmOrPrompt({
    flag: values["confirm-issuer"],
    expected: issuer,
    label: "confirm-issuer",
  });
  await withRemote(ctx, async (remote) => {
    // `*` is the documented ETag for initial issuer creation; a current issuer
    // requires its live ETag.
    let etag = values.etag;
    if (etag === undefined) {
      const current = await remote.callTool("get_issuer", { stackId });
      const currentEtag = current.structuredContent.etag;
      etag = !current.isError && typeof currentEtag === "string" && currentEtag.length > 0 ? currentEtag : "*";
    }
    const result = await remote.callTool("set_issuer", { stackId, issuer, audience, etag, confirmIssuer });
    requireToolSuccess(result, "set_issuer");
    printJson(result.structuredContent as unknown as CasStackIssuer);
  });
}
