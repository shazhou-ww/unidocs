/** `unicas whoami` — authenticated operator identity and memberships. */

import { printJson } from "../output.js";
import type { CliContext } from "./common.js";
import { requireLoggedIn, requireToolSuccess, withRemote } from "./common.js";

export async function whoamiCommand(ctx: CliContext): Promise<void> {
  const session = await ctx.store.load();
  requireLoggedIn(session);
  await withRemote(ctx, async (remote) => {
    const result = await remote.callTool("whoami", {});
    requireToolSuccess(result, "whoami");
    printJson(result.structuredContent);
  });
}
