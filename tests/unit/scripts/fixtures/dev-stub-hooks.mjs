/**
 * Module hooks that let `scripts/dev.mjs` be run for real, end to end, without
 * starting anything.
 *
 * Why a loader rather than a unit-testable helper: the behaviours this pins are
 * *wiring* — which argument reaches `startLocalRuntime`, in what order the
 * pre-flight checks run, which line gets printed. Extracting them into a pure
 * function would move the wiring somewhere else and leave the entry script
 * itself untested, which is exactly where the mistakes live.
 *
 * Only imports made **by dev.mjs itself** are redirected (`context.parentURL`
 * is checked), so every other module in the graph — `doc-types.mjs`,
 * `services.mjs`, `ports.mjs` — is the real one and keeps its real behaviour.
 *
 * Stubs print a single `STUB <name> <json>` line so the test can assert on the
 * exact arguments a collaborator received.
 */

const STUB_SCHEME = "unidocs-stub:";

/** Runs a fake port probe: dev.mjs's `assertPortFree` binds to check, and a
 *  test must not depend on 5433/10000 being free on the developer's machine. */
const NET = `
export function createServer() {
  const handlers = {};
  return {
    once(event, handler) { handlers[event] = handler; return this; },
    listen() { queueMicrotask(() => handlers.listening?.()); return this; },
    close(done) { done?.(); },
  };
}
`;

/** `execFileSync` stands in for the \`docker info\` probe (present, happy);
 *  \`spawn\` stands in for every Vite dev server. */
const CHILD_PROCESS = `
export function execFileSync() { return ""; }
export function spawn(command, args) {
  console.log("STUB spawn " + JSON.stringify([command, ...(args ?? [])]));
  return { on() { return this; }, kill() {} };
}
`;

const MINIFLARE = `export const LogLevel = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, VERBOSE: 5 };`;

const CF_RUNTIME = `
export async function startLocalRuntime(options) {
  console.log("STUB startLocalRuntime " + JSON.stringify({ docTypes: options.docTypes, services: options.services }));
  return { urls: { gateway: "http://127.0.0.1:8787" }, dispose: async () => {} };
}
`;

const AZURE_RUNTIME = `
export async function startAzureRuntime(options) {
  console.log("STUB startAzureRuntime " + JSON.stringify({ docTypes: options.docTypes }));
  return { urls: { gateway: "http://127.0.0.1:41787" }, dispose: async () => {} };
}
export const GATEWAY_DATABASE_URL = "postgres://stub/gateway";
export function docDatabaseUrl(name) { return "postgres://stub/" + name; }
export const BLOB_CONNECTION_STRING = "stub-blob";
`;

/** Nothing here writes the real `local-credentials.json`, which holds a live
 *  private key for whatever stack the developer last ran. */
const DEV_CONFIG = (real) => `
export * from ${JSON.stringify(real)};
export async function writeLocalCredentials() { return "/tmp/stub-local-credentials.json"; }
`;

/** Only with UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY=1: pretends the selected
 *  service is supported everywhere, so the code *after* the availability gate
 *  can be reached on the Azure branch. */
const SERVICES = (real) => `
export * from ${JSON.stringify(real)};
export function assertServicesAvailable() {}
`;

const COMPOSE_STATUS = `export function composeOwnsPortNow() { return false; }`;

function stubSourceFor(specifier, realUrl) {
  switch (specifier) {
    case "node:net": return NET;
    case "node:child_process": return CHILD_PROCESS;
    case "miniflare": return MINIFLARE;
    case "../stacks/unidocs-cloudflare/local/runtime.mjs": return CF_RUNTIME;
    case "../stacks/unidocs-azure/local/runtime.mjs": return AZURE_RUNTIME;
    case "../stacks/unidocs-azure/local/compose-status.mjs": return COMPOSE_STATUS;
    case "./unidocs-dev-config.mjs": return DEV_CONFIG(realUrl);
    case "../stacks/unidocs-cloudflare/local/services.mjs":
      return process.env.UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY === "1" ? SERVICES(realUrl) : null;
    default: return null;
  }
}

const sources = new Map();

export async function resolve(specifier, context, nextResolve) {
  if (!(context.parentURL ?? "").endsWith("/scripts/dev.mjs")) {
    return nextResolve(specifier, context);
  }
  const resolved = await nextResolve(specifier, context);
  const source = stubSourceFor(specifier, resolved.url);
  if (source === null) return resolved;
  const url = `${STUB_SCHEME}${encodeURIComponent(specifier)}`;
  sources.set(url, source);
  return { url, format: "module", shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith(STUB_SCHEME)) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: sources.get(url) };
}
