import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TYPES, parseDocTypes } from "./doc-types.mjs";

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

// Start each selected doc type's dev frontend (if it declares one), with the
// gateway URL injected so its Vite proxy can forward API calls end-to-end.
const webChildren = [];
for (const name of docTypes) {
  const web = DOC_TYPES[name].web;
  if (!web) continue;
  const child = spawn("npx", ["vite", "--port", String(web.port), "--strictPort"], {
    cwd: join(root, web.dir),
    stdio: "inherit",
    env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
  });
  child.on("error", (err) => console.error(`[${name} web] failed to start:`, err.message));
  webChildren.push(child);
  console.log(`  ${(name + " web").padEnd(8)} http://127.0.0.1:${web.port}`);
}

console.log("Ctrl+C to stop.");

const shutdown = async () => {
  for (const child of webChildren) child.kill("SIGINT");
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
