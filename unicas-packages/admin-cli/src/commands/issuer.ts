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
      "capability-max-lifetime-seconds": { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, issuer, audience] = positionals;
  if (!stackId || !issuer || !audience) {
    throw new Error("usage: unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I] [--capability-max-lifetime-seconds N]");
  }
  const rawLifetime = values["capability-max-lifetime-seconds"];
  if (rawLifetime !== undefined
    && (!/^\d+$/.test(rawLifetime) || Number(rawLifetime) < 60 || Number(rawLifetime) > 604800)) {
    throw new Error("--capability-max-lifetime-seconds must be an integer between 60 and 604800");
  }
  const confirmed = await confirmOrPrompt({
    flag: values["confirm-issuer"],
    expected: issuer,
    label: "confirm-issuer",
  });
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? (await resolveIssuerEtag(admin, stackId));
    const body: {
      issuer: string;
      audience: string;
      capabilityMaxLifetimeSeconds?: number;
    } = { issuer, audience };
    if (rawLifetime !== undefined) body.capabilityMaxLifetimeSeconds = Number(rawLifetime);
    const { value } = await admin.putIssuer({ stackId }, body, etag);
    printJson({ ...value, confirmed });
  });
}
