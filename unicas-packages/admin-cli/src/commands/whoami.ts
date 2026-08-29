/** `unicas whoami` — authenticated operator identity and memberships. */

import { printJson } from "../output.js";
import type { CliContext } from "./common.js";
import { withAdminClient } from "./common.js";

export async function whoamiCommand(ctx: CliContext): Promise<void> {
  await withAdminClient(ctx, async (admin) => {
    printJson(await admin.me());
  });
}
