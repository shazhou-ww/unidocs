/** `unicas login` — interactive OAuth authorization with a local callback. */

import { parseArgs } from "node:util";
import { parseScopes } from "../config.js";
import type { CliContext } from "./common.js";
import { runLoginFlow } from "../oauth/login.js";

export async function loginCommand(ctx: CliContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scopes: { type: "string" },
      port: { type: "string" },
      "no-browser": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      "usage: unicas login [--scopes control:read,control:write,control:security] [--port N] [--no-browser]\n",
    );
    return;
  }
  const scopes = parseScopes(values.scopes);
  const port = values.port === undefined ? 0 : parsePort(values.port);

  const result = await runLoginFlow({
    serverUrl: ctx.config.serverUrl,
    store: ctx.store,
    scopes,
    port,
    openBrowser: values["no-browser"] !== true,
    fetchImpl: ctx.fetchImpl,
  });

  process.stdout.write(`Logged in to ${ctx.config.serverUrl}\n`);
  process.stdout.write(`  client id: ${result.clientId || "(none)"}\n`);
  process.stdout.write(`  scopes:    ${scopes.join(", ")}\n`);
  process.stdout.write(`  tokens:    ${ctx.store.path}\n`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port '${value}'`);
  }
  return port;
}
