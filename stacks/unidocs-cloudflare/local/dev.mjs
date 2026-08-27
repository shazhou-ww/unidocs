import { fileURLToPath } from "node:url";
import { applyForwardedLocalArgs } from "../../../scripts/forward-local-args.mjs";
import { runLocalCompose } from "../../../scripts/run-local-compose.mjs";

applyForwardedLocalArgs();
const dockerIndex = process.argv.indexOf("--docker", 2);
if (dockerIndex !== -1) {
  process.argv.splice(dockerIndex, 1);
  runLocalCompose(
    fileURLToPath(new URL("compose.yaml", import.meta.url)),
    process.argv.slice(2),
  );
  process.exit(0);
}

process.env.UNIDOCS_LOCAL_PLATFORM = "cloudflare";
await import("../../../scripts/dev.mjs");