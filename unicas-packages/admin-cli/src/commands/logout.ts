/** `unicas logout` — end the BFF session server-side and clear the local session. */

import { revokeAndClearSession } from "../oauth/logout.js";
import type { CliContext } from "./common.js";

export async function logoutCommand(ctx: CliContext): Promise<void> {
  const session = await ctx.store.load();
  if (session.cookie.length === 0) {
    process.stdout.write("Not logged in; nothing to clear.\n");
    return;
  }
  const result = await revokeAndClearSession({
    adminOrigin: ctx.config.adminOrigin,
    store: ctx.store,
    session,
    fetchImpl: ctx.fetchImpl,
  });
  if (result.revoked) {
    process.stdout.write("Ended the Unicas admin session and cleared the local session.\n");
  } else if (result.revocationError) {
    process.stderr.write(`warning: server-side logout failed (${result.revocationError}); local session cleared.\n`);
    process.stdout.write("Cleared the local session.\n");
  } else {
    process.stdout.write("Cleared the local session.\n");
  }
}
