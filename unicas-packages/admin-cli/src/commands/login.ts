/** `unicas login` — Google OIDC dance with a local callback, then BFF session exchange. */

import { parseArgs } from "node:util";
import { CliError } from "../errors.js";
import type { CliContext } from "./common.js";
import { runLoginFlow } from "../oauth/login.js";

export async function loginCommand(ctx: CliContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "no-browser": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      "usage: unicas login [--port N] [--no-browser]\n",
    );
    return;
  }
  if (ctx.config.googleClientId.length === 0) {
    throw new CliError("UNICAS_GOOGLE_CLIENT_ID is required to log in", 1);
  }
  const port = values.port === undefined ? 0 : parsePort(values.port);

  const result = await runLoginFlow({
    adminOrigin: ctx.config.adminOrigin,
    googleClientId: ctx.config.googleClientId,
    googleClientSecret: ctx.config.googleClientSecret,
    googleIssuer: ctx.config.googleIssuer,
    store: ctx.store,
    port,
    openBrowser: values["no-browser"] !== true,
    fetchImpl: ctx.fetchImpl,
  });

  process.stdout.write(`Logged in to ${ctx.config.adminOrigin}\n`);
  process.stdout.write(`  identity: ${result.identity.email ?? result.identity.sub}\n`);
  process.stdout.write(`  session:  ${ctx.store.path}\n`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port '${value}'`);
  }
  return port;
}
