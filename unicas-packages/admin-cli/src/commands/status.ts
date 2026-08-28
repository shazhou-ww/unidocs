/** `unicas status` — local session summary without any network traffic. */

import { printJson } from "../output.js";
import type { CliContext } from "./common.js";

export async function statusCommand(ctx: CliContext): Promise<void> {
  const session = await ctx.store.load();
  const tokens = session.tokens;
  const expiresAt = tokens?.expires_in !== undefined && typeof session.savedAt === "number"
    ? session.savedAt + tokens.expires_in * 1000
    : undefined;
  printJson({
    serverUrl: ctx.config.serverUrl,
    sessionServerUrl: session.serverUrl || null,
    loggedIn: tokens?.access_token !== undefined,
    hasRefreshToken: tokens?.refresh_token !== undefined,
    scopes: tokens?.scope !== undefined ? tokens.scope.split(" ").filter(Boolean) : [],
    expiresAt: expiresAt ?? null,
    tokenPath: ctx.store.path,
  });
}
