/** `unicas ref-domains list`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import { requireLoggedIn, requireSubcommand, requireToolSuccess, withRemote } from "./common.js";
import { printJson } from "../output.js";
import type { CasRefDomain } from "@unicas/admin-protocol";

export async function refDomainsCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas ref-domains list", ["list"]);
  const session = await ctx.store.load();
  requireLoggedIn(session);
  switch (subcommand) {
    case "list":
      return refDomainsList(ctx, argv);
    default:
      throw new Error("usage: unicas ref-domains list");
  }
}

async function refDomainsList(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas ref-domains list <stackId>");
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("list_ref_domains", { stackId });
    requireToolSuccess(result, "list_ref_domains");
    printJson(result.structuredContent as unknown as { domains: readonly CasRefDomain[] });
  });
}
