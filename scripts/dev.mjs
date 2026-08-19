import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocTypes } from "./doc-types.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let docTypes;
try {
  docTypes = parseDocTypes(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  console.error("Usage: pnpm dev [docType ...]   e.g. pnpm dev docx markdown");
  process.exit(1);
}

// Imported after argv validation so a typo fails fast instead of paying for
// the esbuild + Miniflare import graph first.
const { LogLevel } = await import("miniflare");
const { startLocalRuntime } = await import("./local-runtime.mjs");

const runtime = await startLocalRuntime({
  docTypes,
  persistPath: join(root, ".wrangler", "miniflare"),
  logLevel: LogLevel.INFO,
});

console.log("UniDocs local runtime");
for (const [name, url] of Object.entries(runtime.urls)) {
  console.log(`  ${name.padEnd(8)} ${url}`);
}
console.log(
  `Registry: ${docTypes.map((t) => `docType:${t}`).join(" / ")} → workerUrl`,
);
console.log("Ctrl+C to stop.");

const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
