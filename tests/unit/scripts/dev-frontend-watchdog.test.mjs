/**
 * The frontend watchdog, run for real against real processes: a stand-in for
 * dev.mjs, and a stand-in Vite server in its own process group with a child of
 * its own (the way `npx vite` sits above the actual server). POSIX-only, like
 * the process groups it manages.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const WATCHDOG = fileURLToPath(new URL("../../../scripts/dev-frontend-watchdog.mjs", import.meta.url));
const posix = process.platform !== "win32";

const started = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that idles until killed. */
function idle(options = {}) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", ...options });
  started.push(child.pid);
  return child;
}

/** A group leader that starts one grandchild and reports its pid, like `npx vite`. */
function frontendGroup() {
  return new Promise((resolve, reject) => {
    const leader = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(server.pid);
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    started.push(leader.pid);
    leader.stdout.once("data", chunk => {
      const serverPid = Number(String(chunk).trim());
      started.push(serverPid);
      resolve({ leader, serverPid });
    });
    leader.once("error", reject);
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return predicate();
}

test.skipIf(!posix)("stops the whole frontend group, grandchild included, once dev.mjs is SIGKILLed", async () => {
  const dev = idle();
  const { leader, serverPid } = await frontendGroup();
  const watchdog = spawn(process.execPath, [WATCHDOG, String(dev.pid), String(leader.pid)], { detached: true, stdio: "ignore" });
  started.push(watchdog.pid);

  // While dev.mjs lives, the watchdog leaves the frontend alone.
  await new Promise(r => setTimeout(r, 1500));
  expect(alive(leader.pid)).toBe(true);
  expect(alive(serverPid)).toBe(true);

  dev.kill("SIGKILL");

  expect(await waitUntil(() => !alive(leader.pid) && !alive(serverPid), 8000), "frontend group outlived dev.mjs").toBe(true);
  expect(await waitUntil(() => !alive(watchdog.pid), 8000), "watchdog did not exit after cleaning up").toBe(true);
}, 20_000);

test.skipIf(!posix)("exits on its own once the frontends are already gone", async () => {
  const dev = idle();
  const { leader } = await frontendGroup();
  const watchdog = spawn(process.execPath, [WATCHDOG, String(dev.pid), String(leader.pid)], { detached: true, stdio: "ignore" });
  started.push(watchdog.pid);

  process.kill(-leader.pid, "SIGKILL");

  expect(await waitUntil(() => !alive(watchdog.pid), 5000), "watchdog lingered with nothing to watch").toBe(true);
  expect(alive(dev.pid)).toBe(true);
}, 15_000);

test("refuses to run without a dev pid and at least one group", async () => {
  const child = spawn(process.execPath, [WATCHDOG, "1234"], { stdio: ["ignore", "ignore", "pipe"] });
  const code = await new Promise(resolve => child.once("close", resolve));
  expect(code).toBe(2);
});
