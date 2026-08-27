/** `unicas logout` — RFC 7009 revocation plus local session deletion. */

import { revokeAndClearSession } from "../oauth/logout.js";
import type { CliContext } from "./common.js";

export async function logoutCommand(ctx: CliContext): Promise<void> {
  const session = await ctx.store.load();
  const result = await revokeAndClearSession({
    serverUrl: ctx.config.serverUrl,
    store: ctx.store,
    session,
    fetchImpl: ctx.fetchImpl,
  });

  if (!result.hadTokens && !result.hadClientInformation) {
    process.stdout.write("Not logged in; nothing to revoke.\n");
    return;
  }
  if (result.revoked) {
    process.stdout.write("Revoked Unicas OAuth tokens and cleared the local session.\n");
  } else if (result.revocationError) {
    process.stderr.write(`warning: revocation failed (${result.revocationError}); local session cleared.\n`);
    process.stdout.write("Cleared the local session.\n");
  } else {
    process.stdout.write("Cleared the local session.\n");
  }
}
