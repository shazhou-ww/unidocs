import { spawnSync } from "node:child_process";

const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("npm_execpath is unavailable; run this probe through pnpm");
const concurrencyIndex = process.argv.indexOf("--cas-concurrency");
const casConcurrency = concurrencyIndex >= 0 ? process.argv[concurrencyIndex + 1] : "2";
if (!/^\d+$/.test(casConcurrency) || Number(casConcurrency) < 1) {
  throw new Error("--cas-concurrency requires a positive integer");
}
const result = spawnSync(
  process.execPath,
  [packageManager, "exec", "vitest", "run", "tests/memory-probe.test.ts", "--disableConsoleIntercept"],
  {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DOCX_MEMORY_PROBE: "1",
      DOCX_MEMORY_PROBE_CAS_CONCURRENCY: casConcurrency,
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;