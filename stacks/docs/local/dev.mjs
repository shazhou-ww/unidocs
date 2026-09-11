import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function run(command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["pnpm", "--filter", "@unicas/admin-protocol", "docs:generate"]);
run(["pnpm", "--filter", "@unicas/tenant-protocol", "docs:generate"]);
run(["pnpm", "--filter", "@unidocs/protocol-admin-portal", "docs:generate"]);

const forwardedArgs = process.argv.slice(2);
const child = spawn("pnpm", [
  "--filter",
  "@unidocs/docs-webui",
  "dev",
  ...(forwardedArgs.length > 0 ? ["--", ...forwardedArgs] : []),
], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", (error) => {
  console.error(`Failed to start the documentation portal: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
