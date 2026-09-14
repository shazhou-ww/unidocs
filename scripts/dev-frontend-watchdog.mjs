/**
 * Stops `pnpm dev`'s frontend dev servers when `scripts/dev.mjs` dies without
 * running its own shutdown.
 *
 * dev.mjs starts each Vite server through a wrapper (`npx vite`, `pnpm --filter
 * … dev:ui`) in its own process group, and its SIGINT/SIGTERM/SIGHUP handlers
 * signal those whole groups. None of that runs when dev.mjs is SIGKILLed or
 * crashes hard: the wrappers are re-parented to PID 1 and the Vite servers keep
 * their ports, so the next `pnpm dev` fails with "Port 5174 is already in use".
 *
 * This process is started detached, outside those groups, and does nothing but
 * poll dev.mjs's pid. Once dev.mjs is gone it sends SIGTERM to every group,
 * then SIGKILL to any that are still alive, and exits.
 *
 * Usage: node dev-frontend-watchdog.mjs <dev pid> <process group id>...
 */

const POLL_MS = 1000;
const GRACE_MS = 3000;

const [devPid, ...groups] = process.argv.slice(2).map(Number);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else: still alive.
    return error.code === "EPERM";
  }
}

function signalGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(groupId) {
  return signalGroup(groupId, 0);
}

if (!Number.isSafeInteger(devPid) || devPid <= 1 || groups.length === 0 || groups.some(g => !Number.isSafeInteger(g) || g <= 1)) {
  console.error("usage: dev-frontend-watchdog.mjs <dev pid> <process group id>...");
  process.exit(2);
}

const timer = setInterval(() => {
  const remaining = groups.filter(groupAlive);
  if (remaining.length === 0) {
    clearInterval(timer);
    return;
  }
  if (alive(devPid)) return;
  clearInterval(timer);
  for (const groupId of remaining) signalGroup(groupId, "SIGTERM");
  setTimeout(() => {
    for (const groupId of remaining) if (groupAlive(groupId)) signalGroup(groupId, "SIGKILL");
  }, GRACE_MS);
}, POLL_MS);
