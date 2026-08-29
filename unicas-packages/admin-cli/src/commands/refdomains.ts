/** `unicas ref-domains list`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import { requireSubcommand, withAdminClient } from "./common.js";
import { printJson } from "../output.js";

export async function refDomainsCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas ref-domains list", ["list"]);
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
  await withAdminClient(ctx, async (admin) => {
    printJson(await admin.listRefDomains({ stackId }));
  });
}
