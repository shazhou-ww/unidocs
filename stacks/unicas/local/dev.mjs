import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LogLevel } from "miniflare";
import { applyForwardedLocalArgs } from "../../../scripts/forward-local-args.mjs";
import { runLocalCompose } from "../../../scripts/run-local-compose.mjs";
import { startLocalUnicasRuntime } from "./runtime.mjs";

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

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const host = process.env.UNIDOCS_LOCAL_HOST ?? "127.0.0.1";
const runtime = await startLocalUnicasRuntime({
  host,
  persistPath: join(root, ".wrangler", "miniflare"),
  logLevel: LogLevel.INFO,
});

console.log("UniCAS local runtime");
for (const [name, url] of Object.entries(runtime.urls)) {
  console.log(`  ${name.padEnd(8)} ${url}`);
}

const web = spawn(
  "pnpm",
  ["--filter", "@unicas/admin-webui", "dev:ui", "--", "--host", host],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
web.on("error", (error) => console.error("[unicas admin] failed to start:", error.message));
console.log(`Admin console: http://${host === "0.0.0.0" ? "localhost" : host}:4070/admin/`);
console.log("Ctrl+C to stop.");

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  web.kill("SIGINT");
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);