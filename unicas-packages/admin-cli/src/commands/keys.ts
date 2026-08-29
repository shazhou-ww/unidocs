/** `unicas keys list|challenge|add|transition`. */

import { parseArgs } from "node:util";
import type { CliContext } from "./common.js";
import {
  confirmOrPrompt,
  idempotencyKeyFromFlag,
  requireSubcommand,
  resolveIssuerKeyEtag,
  withAdminClient,
} from "./common.js";
import { printJson } from "../output.js";

const KEY_ALGORITHMS = ["ES256", "RS256", "EdDSA"] as const;
const KEY_STATES = ["retiring", "revoked"] as const;

export async function keysCommand(ctx: CliContext, subcommand: string | undefined, argv: string[]): Promise<void> {
  requireSubcommand(subcommand, "usage: unicas keys list|challenge|add|transition", ["list", "challenge", "add", "transition"]);
  switch (subcommand) {
    case "list":
      return keysList(ctx, argv);
    case "challenge":
      return keysChallenge(ctx, argv);
    case "add":
      return keysAdd(ctx, argv);
    case "transition":
      return keysTransition(ctx, argv);
    default:
      throw new Error("usage: unicas keys list|challenge|add|transition");
  }
}

async function keysList(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const stackId = positionals[0];
  if (!stackId) throw new Error("usage: unicas keys list <stackId>");
  await withAdminClient(ctx, async (admin) => {
    printJson(await admin.listIssuerKeys({ stackId }));
  });
}

async function keysChallenge(ctx: CliContext, argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const [stackId, kid, algorithm] = positionals;
  if (!stackId || !kid || !isAlgorithm(algorithm)) {
    throw new Error(`usage: unicas keys challenge <stackId> <kid> <${KEY_ALGORITHMS.join("|")}>`);
  }
  await withAdminClient(ctx, async (admin) => {
    printJson(await admin.createIssuerKeyChallenge({ stackId, kid, algorithm }));
  });
}

async function keysAdd(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "public-jwk": { type: "string" },
      "possession-proof": { type: "string" },
      "idempotency-key": { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, kid, algorithm] = positionals;
  const publicJwk = parseJsonArg(values["public-jwk"], "--public-jwk");
  const possessionProof = values["possession-proof"];
  if (!stackId || !kid || !isAlgorithm(algorithm) || !publicJwk || !possessionProof) {
    throw new Error("usage: unicas keys add <stackId> <kid> <ES256|RS256|EdDSA> --public-jwk <json> --possession-proof <jws> [--idempotency-key K]");
  }
  await withAdminClient(ctx, async (admin) => {
    const { value } = await admin.createIssuerKey(
      { stackId },
      { kid, algorithm, publicJwk, possessionProof },
      { idempotencyKey: idempotencyKeyFromFlag(values["idempotency-key"]) },
    );
    printJson(value);
  });
}

async function keysTransition(ctx: CliContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      etag: { type: "string" },
      "confirm-kid": { type: "string" },
      "confirm-state": { type: "string" },
    },
    allowPositionals: true,
  });
  const [stackId, kid, state] = positionals;
  if (!stackId || !kid || !isKeyState(state)) {
    throw new Error(`usage: unicas keys transition <stackId> <kid> <${KEY_STATES.join("|")}> [--etag E] [--confirm-kid K] [--confirm-state S]`);
  }
  const confirmKid = await confirmOrPrompt({ flag: values["confirm-kid"], expected: kid, label: "confirm-kid" });
  const confirmState = await confirmOrPrompt({ flag: values["confirm-state"], expected: state, label: "confirm-state" });
  await withAdminClient(ctx, async (admin) => {
    const etag = values.etag ?? (await resolveIssuerKeyEtag(admin, stackId, kid));
    const { value } = await admin.deleteIssuerKey({ stackId, kid }, state, etag);
    printJson({ ...value, confirmKid, confirmState });
  });
}

function isAlgorithm(value: string | undefined): value is (typeof KEY_ALGORITHMS)[number] {
  return (KEY_ALGORITHMS as readonly string[]).includes(value ?? "");
}

function isKeyState(value: string | undefined): value is (typeof KEY_STATES)[number] {
  return (KEY_STATES as readonly string[]).includes(value ?? "");
}

function parseJsonArg(value: string | undefined, flag: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${flag} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${flag} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}
