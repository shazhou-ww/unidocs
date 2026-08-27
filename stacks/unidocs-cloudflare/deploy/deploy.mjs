import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATEWAY_SOURCE = fileURLToPath(new URL("../../../packages/cloudflare-gateway/src/worker.ts", import.meta.url));
const DOC_PACKAGES = Object.freeze({
  markdown: "@unidocs/cloudflare-markdown",
  docx: "@unidocs/cloudflare-docx",
  psd: "@unidocs/cloudflare-psd",
});
const GATEWAY_PACKAGE = "@unidocs/cloudflare-gateway";

export function parseArgs(argv) {
  const options = { dryRun: false, gateway: false, services: [], env: undefined };
  let hasSelector = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--gateway") {
      options.gateway = true;
      hasSelector = true;
    } else if (arg === "--service") {
      options.services.push(...(argv[++index] ?? "").split(",").filter(Boolean));
      hasSelector = true;
    } else if (arg === "--env") options.env = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!hasSelector) {
    options.services = Object.keys(DOC_PACKAGES);
    options.gateway = true;
  }
  options.services = [...new Set(options.services)];
  for (const service of options.services) {
    if (!DOC_PACKAGES[service]) throw new Error(`Unknown document service: ${service}`);
  }
  if (options.env !== undefined && !/^[a-z][a-z0-9-]*$/.test(options.env ?? "")) {
    throw new Error("--env requires a lowercase environment name");
  }
  return options;
}

export function deploymentPlan({ services, gateway, env } = {}) {
  const envArgs = env ? ["--env", env] : [];
  const commands = [];
  for (const service of services ?? []) {
    const packageName = DOC_PACKAGES[service];
    commands.push(["pnpm", "--filter", packageName, "build"]);
    commands.push(["pnpm", "--filter", packageName, "exec", "wrangler", "deploy", ...envArgs]);
  }
  if (gateway) {
    commands.push([
      "pnpm", "--filter", GATEWAY_PACKAGE, "exec", "wrangler", "d1", "migrations", "apply",
      "unidocs-snapshots", "--remote", ...envArgs,
    ]);
    commands.push(["pnpm", "--filter", GATEWAY_PACKAGE, "build"]);
    commands.push(["pnpm", "--filter", GATEWAY_PACKAGE, "exec", "wrangler", "deploy", ...envArgs]);
  }
  return commands;
}

export function assertProductionIdentityReady(
  source = readFileSync(GATEWAY_SOURCE, "utf8"),
) {
  if (source.includes("createInsecureTenantIdentityResolver")) {
    throw new Error(
      "Cloudflare Gateway still uses createInsecureTenantIdentityResolver; refusing the deployment before any unit is published.",
    );
  }
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
      assertProductionIdentityReady();
      plan.forEach(run);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}