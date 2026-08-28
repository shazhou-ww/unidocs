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

/**
 * `pnpm dev` 省略栈名时用它。本地开发绝大多数时候就是这个栈，让最常见的
 * 那条命令不必每次重复它。
 */
export const DEFAULT_DEV_STACK = "unidocs-cloudflare";

/**
 * 把 `<action> [stack] [...args]` 里的栈名和其余参数分开。
 *
 * 第一个 token 是已知栈名就用它，否则它属于下游（doc type、`--cas` 之类），
 * 整串原样转发：`pnpm dev psd` 等价于 `pnpm dev unidocs-cloudflare psd`。
 *
 * 只有 `dev` 会这样兜底。`deploy` / `smoke` 缺栈名就是缺栈名 —— 往一个猜出来
 * 的栈上静默部署是不能接受的。
 */
export function resolveInvocation(action, rest, availableStacks) {
  const [first, ...tail] = rest;
  if (availableStacks.includes(first)) return { stack: first, args: tail };
  if (action !== "dev") return { stack: undefined, args: rest };
  return { stack: DEFAULT_DEV_STACK, args: rest };
}

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
  const [action, ...rest] = process.argv.slice(2);
  const available = await listStacks();
  const { stack, args } = STACK_ACTION_ENTRIES[action]
    ? resolveInvocation(action, rest, available)
    : { stack: undefined, args: rest };
  if (!STACK_ACTION_ENTRIES[action] || !stack) {
    console.error(
      "Usage: pnpm dev [stack] [docType ...] [--cas <local|remote>]\n" +
      "       pnpm <deploy|smoke> <stack> [...args]\n\n" +
      `Available stacks: ${available.join(", ") || "none"}\n` +
      `dev defaults to: ${DEFAULT_DEV_STACK}`,
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