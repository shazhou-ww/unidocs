import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVICE_PACKAGE = "@unicas/service-cloudflare";

export function parseArgs(argv) {
  const options = { dryRun: false, skipSmoke: false, env: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-smoke") options.skipSmoke = true;
    else if (arg === "--env") options.env = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.env !== undefined && !/^[a-z][a-z0-9-]*$/.test(options.env ?? "")) {
    throw new Error("--env requires a lowercase environment name");
  }
  return options;
}

export function deploymentPlan({ env, skipSmoke } = {}) {
  const envArgs = env ? ["--env", env] : [];
  const commands = [
    ["pnpm", "--filter", SERVICE_PACKAGE, "build"],
    ["pnpm", "--filter", SERVICE_PACKAGE, "exec", "wrangler", "deploy", ...envArgs],
  ];
  if (!skipSmoke) {
    commands.push(["pnpm", "--filter", "@unicas/codec", "build"]);
    commands.push(["pnpm", "--filter", "@unidocs/service-auth", "build"]);
    commands.push(["node", "stacks/unicas/deploy/smoke.mjs"]);
  }
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
    if (options.dryRun) {
      plan.forEach((command) => console.log(command.join(" ")));
    } else {
      plan.forEach(run);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}