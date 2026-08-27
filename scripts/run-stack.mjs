import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STACKS_ROOT = join(ROOT, "stacks");

export const STACK_ACTION_ENTRIES = Object.freeze({
  dev: ["local", "dev.mjs"],
  deploy: ["deploy", "deploy.mjs"],
  smoke: ["deploy", "smoke.mjs"],
});

export function resolveStackEntry(stacksRoot, action, stack) {
  const parts = STACK_ACTION_ENTRIES[action];
  if (!parts) {
    throw new Error(`Unknown stack action: ${action}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(stack ?? "")) {
    throw new Error(`Invalid stack name: ${stack ?? ""}`);
  }
  return join(stacksRoot, stack, ...parts);
}

export async function listStacks(stacksRoot = STACKS_ROOT) {
  const entries = await readdir(stacksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[a-z][a-z0-9-]*$/.test(name))
    .sort();
}

async function main() {
  const [action, stack, ...args] = process.argv.slice(2);
  if (!STACK_ACTION_ENTRIES[action] || !stack) {
    const available = await listStacks();
    console.error(
      "Usage: pnpm <dev|deploy|smoke> <stack> [...args]\n\n" +
      `Available stacks: ${available.join(", ") || "none"}`,
    );
    process.exitCode = 1;
    return;
  }

  let entry;
  try {
    entry = resolveStackEntry(STACKS_ROOT, action, stack);
    await access(entry);
  } catch (error) {
    const available = await listStacks();
    console.error(
      `${error.message}\nExpected entry: stacks/${stack}/${STACK_ACTION_ENTRIES[action].join("/")}\n` +
      `Available stacks: ${available.join(", ") || "none"}`,
    );
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [entry, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });

  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  child.once("error", (error) => {
    console.error(`Failed to start ${action} for ${stack}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}