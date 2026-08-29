/** `unicas login` — Google OIDC dance with a local callback, then BFF session exchange. */

import { parseArgs } from "node:util";
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
  const port = values.port === undefined ? 0 : parsePort(values.port);

  const result = await runLoginFlow({
    adminOrigin: ctx.config.adminOrigin,
    store: ctx.store,
    port,
    openBrowser: values["no-browser"] !== true,
    fetchImpl: ctx.fetchImpl,
  });

  process.stdout.write(`Logged in to ${ctx.config.adminOrigin}\n`);
  process.stdout.write(`  identity: ${result.identity?.emailForDisplay ?? result.identity?.subject ?? "(unknown)"}\n`);
  process.stdout.write(`  session:  ${ctx.store.path}\n`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port '${value}'`);
  }
  return port;
}
