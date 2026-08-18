import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LogLevel } from "miniflare";
import { startLocalRuntime } from "./local-runtime.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const runtime = await startLocalRuntime({
  persistPath: join(root, ".wrangler", "miniflare"),
  logLevel: LogLevel.INFO,
});

console.log("UniDocs local runtime");
console.log(`  gateway  ${runtime.urls.gateway}`);
console.log(`  markdown ${runtime.urls.markdown}`);
console.log(`  docx     ${runtime.urls.docx}`);
console.log("Registry: docType:markdown / docType:docx → workerUrl");
console.log("Ctrl+C to stop.");

const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
