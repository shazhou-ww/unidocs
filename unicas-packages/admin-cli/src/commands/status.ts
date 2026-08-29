/** `unicas status` — local session summary without any network traffic. */

import { printJson } from "../output.js";
import type { CliContext } from "./common.js";

export async function statusCommand(ctx: CliContext): Promise<void> {
  const session = await ctx.store.load();
  printJson({
    adminOrigin: ctx.config.adminOrigin,
    sessionAdminOrigin: session.adminOrigin || null,
    loggedIn: session.cookie.length > 0,
    identity: session.identity ?? null,
    savedAt: session.savedAt ?? null,
    sessionPath: ctx.store.path,
  });
}
