/** `unicas oauth-issuer get|inspect|activate`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import { requireSubcommand, resolveOAuthIssuerEtag, withAdminClient } from "./common.js";
import { printJson } from "../output.js";

export async function oauthIssuerCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas oauth-issuer get|inspect|activate", ["get", "inspect", "activate"]);
  switch (subcommand) {
    case "get": return oauthIssuerGet(ctx, argv);
    case "inspect": return oauthIssuerInspect(ctx, argv);
    case "activate": return oauthIssuerActivate(ctx, argv);
  }
}

async function oauthIssuerGet(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas oauth-issuer get <stackId>");
  await withAdminClient(ctx, async (admin) => {
    const result = await admin.getOAuthIssuer({ stackId });
    printJson({ ...result.value, etag: result.etag });
  });
}

async function oauthIssuerInspect(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "capability-max-lifetime-seconds": { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, issuer, audience] = positionals;
  if (!stackId || !issuer || !audience) {
    throw new Error("usage: unicas oauth-issuer inspect <stackId> <issuer> <audience> [--capability-max-lifetime-seconds N]");
  }
  const rawLifetime = values["capability-max-lifetime-seconds"];
  if (rawLifetime !== undefined
    && (!/^\d+$/.test(rawLifetime) || Number(rawLifetime) < 60 || Number(rawLifetime) > 604800)) {
    throw new Error("--capability-max-lifetime-seconds must be an integer between 60 and 604800");
  }
  await withAdminClient(ctx, async (admin) => {
    const body: { issuer: string; audience: string; capabilityMaxLifetimeSeconds?: number } = { issuer, audience };
    if (rawLifetime !== undefined) body.capabilityMaxLifetimeSeconds = Number(rawLifetime);
    const result = await admin.inspectOAuthIssuer({ stackId }, body);
    printJson({ ...result.value, etag: result.etag });
  });
}

async function oauthIssuerActivate(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { etag: { type: "string" }, "activation-proof": { type: "string" } },
    allowPositionals: true,
  });
  const [stackId, inspectionId] = positionals;
  const activationProof = values["activation-proof"];
  if (!stackId || !inspectionId || !activationProof) {
    throw new Error("usage: unicas oauth-issuer activate <stackId> <inspectionId> --activation-proof <jws> [--etag E]");
  }
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? await resolveOAuthIssuerEtag(admin, stackId);
    const result = await admin.activateOAuthIssuer({ stackId }, { inspectionId, activationProof }, etag);
    printJson({ ...result.value, etag: result.etag });
  });
}