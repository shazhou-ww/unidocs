import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCS_PACKAGE = "@unicas/docs-webui";
const CONFIG = "../../stacks/unicas-docs/wrangler.jsonc";

export function parseArgs(argv) {
  const options = { dryRun: false, skipSmoke: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-smoke") options.skipSmoke = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function deploymentPlan({ skipSmoke = false } = {}) {
  const commands = [
    ["pnpm", "--filter", DOCS_PACKAGE, "build"],
    ["pnpm", "--filter", DOCS_PACKAGE, "exec", "wrangler", "deploy", "--config", CONFIG],
  ];
  if (!skipSmoke) commands.push(["node", "stacks/unicas-docs/deploy/smoke.mjs"]);
  return commands;
}

function run(command) {
  console.log(`> ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = deploymentPlan(options);
    if (options.dryRun) plan.forEach((command) => console.log(command.join(" ")));
    else plan.forEach(run);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
