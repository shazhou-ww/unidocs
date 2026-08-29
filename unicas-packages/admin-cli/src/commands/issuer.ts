/** `unicas issuer get|set`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  confirmOrPrompt,
  requireSubcommand,
  resolveIssuerEtag,
  withAdminClient,
} from "./common.js";
import { printJson } from "../output.js";

export async function issuerCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas issuer get|set", ["get", "set"]);
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
  await withAdminClient(ctx, async (admin) => {
    printJson((await admin.getIssuer({ stackId })).value);
  });
}

async function issuerSet(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      etag: { type: "string" },
      "confirm-issuer": { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, issuer, audience] = positionals;
  if (!stackId || !issuer || !audience) {
    throw new Error("usage: unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I]");
  }
  const confirmed = await confirmOrPrompt({
    flag: values["confirm-issuer"],
    expected: issuer,
    label: "confirm-issuer",
  });
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? (await resolveIssuerEtag(admin, stackId));
    const { value } = await admin.putIssuer({ stackId }, { issuer, audience }, etag);
    printJson({ ...value, confirmed });
  });
}
