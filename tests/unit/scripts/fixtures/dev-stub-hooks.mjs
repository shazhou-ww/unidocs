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
 * The two env-gated overrides of `services.mjs` below are the only exceptions,
 * both off unless a test sets the variable, and both re-export everything they
 * do not replace.
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
 *  \`spawn\` stands in for every Vite dev server. The line carries `cwd` and the
 *  injected `GATEWAY_URL` as well as the argv, because those are what the
 *  frontend loops actually decide: which package, which port, and whether the
 *  Vite proxy has a gateway to forward to. */
const CHILD_PROCESS = `
export function execFileSync() { return ""; }
export function spawn(command, args, options) {
  console.log("STUB spawn " + JSON.stringify({
    command,
    args: args ?? [],
    cwd: options?.cwd ?? null,
    gatewayUrl: options?.env?.GATEWAY_URL ?? null,
  }));
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

/**
 * Two independent, env-gated overrides of the service registry. Both are off
 * by default, and each is a *named* stand-in for a future the registry does
 * not contain yet:
 *
 * - UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY=1 lifts the availability gate, so
 *   the code *after* it can be reached on the Azure branch. It only removes an
 *   earlier refusal; it cannot make a later assertion pass.
 * - UNIDOCS_TEST_STUB_SERVICE_FRONTEND=1 hands the service frontend loop one
 *   synthetic component. This one does supply data, deliberately: no service
 *   in SERVICE_TARGETS declares a `web` block today, so the loop that will
 *   start admin-portal-webui and tenant-portal-webui has nothing to iterate
 *   over and every assertion about it would be vacuous. The component names a
 *   directory and port no real target uses, so a test asserting on it is
 *   asserting about the loop and nothing else.
 */
const SERVICES = (real) => `
export * from ${JSON.stringify(real)};
${process.env.UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY === "1" ? "export function assertServicesAvailable() {}" : ""}
${process.env.UNIDOCS_TEST_STUB_SERVICE_FRONTEND === "1"
  ? `export function serviceFrontends(names) {
  return names.map(name => ({ name: name + "-webui", target: name, web: { dir: "packages/stub-webui", port: 5199 } }));
}`
  : ""}
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
      return process.env.UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY === "1"
        || process.env.UNIDOCS_TEST_STUB_SERVICE_FRONTEND === "1" ? SERVICES(realUrl) : null;
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
