# `pnpm dev portal` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `portal` a selectable target of the local dev runtime, so `pnpm dev portal` starts every portal component that exists today and gains the rest without redesign.

**Architecture:** `portal` is an **umbrella target**, not a document type and not a single worker. A new dependency-free registry declares the portal components — backend workers and Vite frontends — and the selector expands `portal` into all of them. Today it expands to one worker (`@unidocs/cloudflare-portal`); `admin-portal-webui`, `tenant-portal-webui` and further services join by adding a row. Positional arguments stay as they are: `pnpm dev portal psd` runs the portal alongside a document type, and the Cloudflare stack stays the default.

**Tech Stack:** Node ESM scripts (no TypeScript in `stacks/` or `scripts/`), Miniflare 4 with D1, esbuild bundling, Vitest 3 for the unit tests under `tests/unit/scripts/`.

## Global Constraints

- `stacks/unidocs-cloudflare/local/doc-types.mjs` is deliberately dependency-free (only `node:path`) so `dev.mjs` can validate argv before importing esbuild or Miniflare. Any new registry module must keep that property: no imports beyond `node:path`.
- `DOC_TYPES` describes document types. The portal has no editor or operator Durable Object, takes no gateway route, and does not appear in `docServicesJson`. Do not add it to that table.
- `packages/cloudflare-portal/wrangler.jsonc` is the deployment contract. Do not change its `compatibility_date`; the local runtime supplies its own (`COMPATIBILITY_DATE` in `doc-types.mjs`, currently `"2025-08-17"`).
- `portalGoogleConfigFromGateway` currently requires a canonical HTTPS origin and exactly the Google issuer. Both need a **narrow, explicit** local-development allowance. A production origin or a production issuer must never be able to fall into the allowance.
- Local dev secrets never enter the repository. `.dev.vars` is gitignored; the runtime passes the mock OIDC client id and secret as bindings instead.
- The existing local mock OIDC provider (`stacks/unicas/local/mock-oidc-worker.mjs`, port `MOCK_OIDC_PORT` 8793) serves discovery and JWKS for its own origin and accepts any `client_id` — it does not validate the secret. Reuse it; do not write a second one.
- Occupied ports fail fast, matching the existing `assertPortFree` behaviour.
- `CLAUDE.md` is local-only: it is in `.git/info/exclude` and has never been tracked. Never edit it, never `git add` it, and never `git add -A` from a directory that would sweep it in.
- Commit messages are English, imperative, and explain the reasoning; do not push or open a PR.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `stacks/unidocs-cloudflare/local/services.mjs` | **New.** The portal component registry and the pure helpers that expand a selection into worker/frontend descriptors. Dependency-free. |
| `stacks/unidocs-cloudflare/local/doc-types.mjs` | Gains `parseTargets`, which splits positional args into document types and service targets. `DOC_TYPES` itself is untouched. |
| `stacks/unidocs-cloudflare/local/runtime.mjs` | Starts the selected service workers, applies the portal's D1 migrations, and reports their URLs. |
| `scripts/dev.mjs` | Routes the split selection to the two stacks; rejects service targets on Azure with a specific message. |
| `packages/cloudflare-portal/src/google-config.ts` | Gains the local-development origin and issuer allowance. |
| `tests/unit/scripts/services.test.mjs` | **New.** Registry expansion and argument splitting. |
| `tests/unit/scripts/doc-types.test.mjs` | Extended for `parseTargets`. |
| `packages/cloudflare-portal/tests/google-config.test.ts` | Extended: the allowance admits exactly what it should and nothing else. |

---

### Task 1: The portal component registry and argument splitting

**Files:**
- Create: `stacks/unidocs-cloudflare/local/services.mjs`
- Modify: `stacks/unidocs-cloudflare/local/doc-types.mjs` (add `parseTargets`; do not touch `DOC_TYPES`)
- Test: `tests/unit/scripts/services.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `SERVICE_TARGETS`, `PORTAL_PORT`, `expandServiceTarget(name)`, `serviceWorkers(names)`, `serviceFrontends(names)` from `services.mjs`; `parseTargets(args)` from `doc-types.mjs` returning `{ docTypes, services }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scripts/services.test.mjs`:

```js
import { expect, test } from "vitest";
import { expandServiceTarget, serviceFrontends, serviceWorkers, SERVICE_TARGETS } from "../../../stacks/unidocs-cloudflare/local/services.mjs";
import { parseTargets } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

test("portal is an umbrella that expands to every component it owns", () => {
  const components = expandServiceTarget("portal");
  expect(components.length).toBeGreaterThan(0);
  expect(components.every(component => component.target === "portal")).toBe(true);
  expect(components.map(component => component.name)).toContain("portal");
});

test("every registered component declares either a worker entry or a frontend directory", () => {
  for (const [target, components] of Object.entries(SERVICE_TARGETS)) {
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.name, `${target} component is unnamed`).toBeTruthy();
      expect(Boolean(component.entry) || Boolean(component.web), `${component.name} declares neither entry nor web`).toBe(true);
      if (component.entry) expect(component.port, `${component.name} has an entry but no port`).toBeTypeOf("number");
      if (component.web) expect(component.web.dir && component.web.port, `${component.name} web is incomplete`).toBeTruthy();
    }
  }
});

test("workers and frontends are selected separately, so a target may have only one kind", () => {
  const workers = serviceWorkers(["portal"]);
  expect(workers.every(component => component.entry)).toBe(true);
  expect(serviceFrontends(["portal"]).every(component => component.web)).toBe(true);
});

test("an unknown service target names the ones that exist", () => {
  expect(() => expandServiceTarget("nope")).toThrow(/Unknown service target: nope/);
  expect(() => expandServiceTarget("nope")).toThrow(/portal/);
});

test("positional arguments split into document types and service targets", () => {
  expect(parseTargets(["portal"])).toEqual({ docTypes: [], services: ["portal"] });
  expect(parseTargets(["portal", "psd"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
  expect(parseTargets(["psd", "portal"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
});

test("no arguments still means every document type and no service", () => {
  const { docTypes, services } = parseTargets([]);
  expect(docTypes).toEqual(["markdown", "docx", "psd"]);
  expect(services).toEqual([]);
});

test("duplicates collapse and order is preserved within each kind", () => {
  expect(parseTargets(["psd", "portal", "psd", "portal"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
});

test("an unknown positional names both kinds of valid target", () => {
  expect(() => parseTargets(["nope"])).toThrow(/Unknown target: nope/);
  expect(() => parseTargets(["nope"])).toThrow(/markdown/);
  expect(() => parseTargets(["nope"])).toThrow(/portal/);
});

test("the registry stays dependency-free so argv validation costs nothing", async () => {
  const source = await import("node:fs/promises").then(fs =>
    fs.readFile(new URL("../../../stacks/unidocs-cloudflare/local/services.mjs", import.meta.url), "utf8"));
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]);
  expect(imports.filter(specifier => specifier !== "node:path")).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run tests/unit/scripts/services.test.mjs
```

Expected: FAIL — `services.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

Create `stacks/unidocs-cloudflare/local/services.mjs`:

```js
/**
 * Registry of locally runnable portal components, plus the pure helpers that
 * expand a selection into worker and frontend descriptors.
 *
 * A *target* is what a user types (`pnpm dev portal`); a *component* is one
 * process. `portal` is an umbrella: it owns the backend service today, and the
 * admin and tenant WebUIs join it by adding rows here rather than by growing a
 * second selector.
 *
 * Deliberately dependency-free, for the same reason `doc-types.mjs` is: argv is
 * validated against this table before anything heavy is imported.
 */

/** Portal backend; kept clear of the gateway/doc-type band (8787-8790). */
export const PORTAL_PORT = 8795;

export const SERVICE_TARGETS = {
  portal: [
    {
      name: "portal",
      target: "portal",
      entry: "packages/cloudflare-portal/src/worker.ts",
      worker: "unidocs-portal",
      outfile: "portal.js",
      port: PORTAL_PORT,
      /** Applied by the runtime; Miniflare has no migrations runner of its own. */
      migrations: "packages/cloudflare-portal/migrations",
      d1Binding: "DB",
    },
    // admin-portal-webui and tenant-portal-webui land here as
    // { name, target: "portal", web: { dir, port } } once those packages exist.
  ],
};

export function expandServiceTarget(name) {
  const components = SERVICE_TARGETS[name];
  if (!components) {
    throw new Error(`Unknown service target: ${name}. Available: ${Object.keys(SERVICE_TARGETS).join(", ")}`);
  }
  return components;
}

/** Components of the selected targets that run as a Miniflare worker. */
export function serviceWorkers(names) {
  return names.flatMap(expandServiceTarget).filter(component => component.entry);
}

/** Components of the selected targets that run as a Vite dev server. */
export function serviceFrontends(names) {
  return names.flatMap(expandServiceTarget).filter(component => component.web);
}
```

Add to `stacks/unidocs-cloudflare/local/doc-types.mjs`, directly below `parseDocTypes`:

```js
/**
 * Split positional arguments into document types and service targets.
 *
 * They share one argument position because that is how the command reads —
 * `pnpm dev portal psd` — but they expand along different paths: a document
 * type becomes an editor/operator pair behind the gateway, a service target
 * becomes one or more standalone processes. No arguments still means every
 * document type and no service, which is the historical behaviour.
 */
export function parseTargets(args) {
  if (args.length === 0) return { docTypes: Object.keys(DOC_TYPES), services: [] };
  const docTypes = [];
  const services = [];
  for (const arg of args) {
    if (Object.hasOwn(DOC_TYPES, arg)) {
      if (!docTypes.includes(arg)) docTypes.push(arg);
    } else if (Object.hasOwn(SERVICE_TARGETS, arg)) {
      if (!services.includes(arg)) services.push(arg);
    } else {
      throw new Error(
        `Unknown target: ${arg}. Document types: ${Object.keys(DOC_TYPES).join(", ")}. Services: ${Object.keys(SERVICE_TARGETS).join(", ")}`,
      );
    }
  }
  return { docTypes, services };
}
```

and at the top of that file, beside the existing `node:path` import:

```js
import { SERVICE_TARGETS } from "./services.mjs";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run tests/unit/scripts/services.test.mjs tests/unit/scripts/doc-types.test.mjs
```

Expected: PASS, including the existing `doc-types.test.mjs` cases.

- [ ] **Step 5: Commit**

```bash
git add stacks/unidocs-cloudflare/local/services.mjs stacks/unidocs-cloudflare/local/doc-types.mjs tests/unit/scripts/services.test.mjs
git commit -m "feat(dev): register portal as an umbrella dev target

A document type expands into an editor and operator pair behind the gateway;
the portal expands into standalone processes with no Durable Object and no
gateway route. Putting it in DOC_TYPES would make every field of that table
conditional, so it gets its own registry and the selector splits one argument
position across both.

The registry is an umbrella rather than a worker so that the admin and tenant
WebUIs join by adding a row, instead of by growing a second selector once they
exist."
```

---

### Task 2: The local-development origin and issuer allowance

**Files:**
- Modify: `packages/cloudflare-portal/src/google-config.ts`
- Test: `packages/cloudflare-portal/tests/google-config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `portalGoogleConfigFromGateway` accepting a loopback HTTP origin together with a loopback issuer; `LOCAL_DEV_ORIGIN_PATTERN` exported for the runtime to assert against.

- [ ] **Step 1: Write the failing test**

Append to `packages/cloudflare-portal/tests/google-config.test.ts`:

```ts
test("accepts a loopback origin only when the issuer is also loopback", () => {
  const local = { ...settings, GATEWAY_OIDC_ISSUER: "http://127.0.0.1:8793" };
  expect(portalGoogleConfigFromGateway(local, "http://127.0.0.1:8795")).toMatchObject({
    origin: "http://127.0.0.1:8795",
    redirectUri: "http://127.0.0.1:8795/admin/auth/callback",
    issuer: "http://127.0.0.1:8793",
  });
  expect(portalGoogleConfigFromGateway({ ...settings }, "http://localhost:8795").origin).toBe("http://localhost:8795");
});

test.each([
  ["a public origin over http", { ...settings }, "http://unidocs.shazhou.work"],
  ["a loopback-looking hostname that is not loopback", { ...settings }, "http://127.0.0.1.evil.test:8795"],
  ["a loopback origin with a path", { ...settings }, "http://127.0.0.1:8795/admin"],
  ["a non-loopback issuer over http", { ...settings, GATEWAY_OIDC_ISSUER: "http://accounts.example" }, "http://127.0.0.1:8795"],
])("refuses %s", (_label, override, origin) => {
  expect(() => portalGoogleConfigFromGateway(override, origin)).toThrow(TypeError);
});

test("a loopback issuer is never accepted for a production origin", () => {
  const local = { ...settings, GATEWAY_OIDC_ISSUER: "http://127.0.0.1:8793" };
  expect(() => portalGoogleConfigFromGateway(local, "https://unidocs.shazhou.work")).toThrow(TypeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/google-config.test.ts
```

Expected: FAIL — the loopback cases throw today.

- [ ] **Step 3: Write the implementation**

Replace the body of `portalGoogleConfigFromGateway` in `packages/cloudflare-portal/src/google-config.ts`:

```ts
export const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Loopback only, and only the two spellings a local runtime actually binds.
 * A hostname that merely starts with 127.0.0.1 is a different host, so this
 * matches the whole authority rather than a prefix.
 */
export const LOCAL_DEV_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

function isLoopback(origin: string): boolean {
  return LOCAL_DEV_ORIGIN_PATTERN.test(origin);
}

export function portalGoogleConfigFromGateway(settings: Readonly<Record<string, string | undefined>>, portalOrigin = PORTAL_PUBLIC_ORIGIN): PortalGoogleConfig {
  const clientId = settings.GATEWAY_OIDC_CLIENT_ID?.trim();
  const clientSecret = settings.GATEWAY_OIDC_CLIENT_SECRET;
  const issuer = (settings.GATEWAY_OIDC_ISSUER ?? GOOGLE_ISSUER).replace(/\/$/, "");
  const origin = new URL(portalOrigin);
  if (origin.origin !== portalOrigin) throw new TypeError("Portal requires a canonical origin");

  // A loopback origin is a local runtime, and it may only talk to a loopback
  // OIDC provider — the mock. Pairing them is what keeps this allowance from
  // ever applying in production: a deployed origin is not loopback, and a
  // loopback issuer is refused for any other origin, so neither half can be
  // reached by a misconfigured deployment on its own.
  const local = isLoopback(portalOrigin);
  const localIssuer = isLoopback(issuer);
  if (local !== localIssuer) throw new TypeError("Portal pairs a loopback origin with a loopback OIDC issuer, or neither");
  if (!local && (origin.protocol !== "https:" || issuer !== GOOGLE_ISSUER)) {
    throw new TypeError("Portal requires a canonical HTTPS origin and the Google issuer");
  }
  if (!clientId || !clientSecret?.trim()) throw new TypeError("Gateway Google OIDC client ID and secret are required");

  return { issuer: issuer as PortalGoogleConfig["issuer"], clientId, clientSecret, origin: portalOrigin, redirectUri: `${portalOrigin}/admin/auth/callback` };
}
```

Widen the `issuer` field on `PortalGoogleConfig` from the literal to `string`, keeping the doc comment that says production is always Google:

```ts
export interface PortalGoogleConfig {
  /** Always the Google issuer in production; a loopback mock only in local development. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
  readonly redirectUri: string;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS, including every pre-existing case in `google-config.test.ts`, `auth.test.ts` and `worker.test.ts`.

- [ ] **Step 5: Verify the allowance cannot be reached in production**

Temporarily change the production default in `wrangler.production.jsonc`'s `PORTAL_ORIGIN` to `http://127.0.0.1:8795`, run `pnpm --filter @unidocs/cloudflare-portal exec wrangler deploy --dry-run --config wrangler.production.jsonc`, and confirm it still builds — then revert. The point of the check is to confirm nothing in the deployment path silently depends on the old strictness. Record what you observed; revert the file and confirm `git diff` is empty.

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/google-config.ts packages/cloudflare-portal/tests/google-config.test.ts
git commit -m "feat(portal): allow a loopback origin paired with a loopback issuer

Local development needs both halves: the runtime binds http://127.0.0.1, and
the mock OIDC provider issues for its own loopback origin, so requiring the
Google issuer refused local login just as firmly as requiring HTTPS refused the
local origin.

The two are allowed only together. A deployed origin is not loopback, and a
loopback issuer is refused for any other origin, so neither half of a
misconfigured deployment can reach the allowance alone."
```

---

### Task 3: Start the portal worker in the local runtime

**Files:**
- Modify: `stacks/unidocs-cloudflare/local/doc-types.mjs` (`bundleTargets`, `resolvePorts`, `buildWorkers`)
- Modify: `stacks/unidocs-cloudflare/local/runtime.mjs`
- Test: `tests/unit/scripts/doc-types.test.mjs`

**Interfaces:**
- Consumes: `serviceWorkers`, `PORTAL_PORT` (Task 1); the loopback allowance (Task 2).
- Produces: `startLocalRuntime({ services })` starting the selected service workers and exposing `runtime.urls.portal`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/scripts/doc-types.test.mjs`:

```js
import { serviceWorkers } from "../../../stacks/unidocs-cloudflare/local/services.mjs";

test("selected services contribute their own bundle targets", () => {
  const withPortal = bundleTargets(["psd"], { services: ["portal"] }).map(target => target.outfile);
  expect(withPortal).toContain("portal.js");
  expect(bundleTargets(["psd"]).map(target => target.outfile)).not.toContain("portal.js");
});

test("service ports are reserved alongside the gateway and document types", () => {
  const ports = resolvePorts(["psd"], {}, ["portal"]);
  expect(ports.portal).toBe(serviceWorkers(["portal"])[0].port);
  expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
});

test("a selected service becomes a Miniflare worker with its D1 binding", () => {
  const workers = buildWorkers({
    docTypes: [], host: "127.0.0.1", ports: resolvePorts([], {}, ["portal"]),
    bundleDir: "/tmp/bundle", services: ["portal"],
  });
  const portal = workers.find(worker => worker.name === "unidocs-portal");
  expect(portal).toBeDefined();
  expect(portal.d1Databases).toMatchObject({ DB: expect.any(String) });
  expect(portal.bindings.PORTAL_ORIGIN).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(portal.bindings.GATEWAY_OIDC_ISSUER).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(portal.compatibilityDate).toBe(COMPATIBILITY_DATE);
});

test("no selected service leaves the worker list exactly as it was", () => {
  const base = buildWorkers({ docTypes: ["psd"], host: "127.0.0.1", ports: resolvePorts(["psd"]), bundleDir: "/tmp/bundle" });
  expect(base.some(worker => worker.name === "unidocs-portal")).toBe(false);
});
```

Import `COMPATIBILITY_DATE` in that file if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run tests/unit/scripts/doc-types.test.mjs
```

Expected: FAIL — `bundleTargets`, `resolvePorts` and `buildWorkers` ignore services.

- [ ] **Step 3: Write the implementation**

In `stacks/unidocs-cloudflare/local/doc-types.mjs`:

Import the helpers beside the existing `SERVICE_TARGETS` import:

```js
import { SERVICE_TARGETS, serviceWorkers } from "./services.mjs";
```

`bundleTargets` — add `services = []` to the destructured options and append, just before the closing `]` of the returned array:

```js
    ...serviceWorkers(services).map(component => ({ entry: component.entry, outfile: component.outfile })),
```

`resolvePorts` — take a third parameter and reserve each service port after the document-type loop:

```js
export function resolvePorts(docTypes, overrides = {}, services = []) {
  const ports = { gateway: overrides.gateway ?? GATEWAY_PORT };
  for (const name of docTypes) {
    ports[name] = overrides[name] ?? DOC_TYPES[name].port;
  }
  for (const component of serviceWorkers(services)) {
    ports[component.name] = overrides[component.name] ?? component.port;
  }
  return ports;
}
```

`buildWorkers` — add `services = []` to the destructured options, and build one config per service worker. Place this beside `mockOidcWorker`, and include it in every array the function returns except the `casMiddlewareOnly` one:

```js
  // The portal reads its Google settings from the same switch the CAS admin BFF
  // uses: a real client id means a real Google, its absence means the local mock
  // provider. `useRealGoogle` is already computed above for exactly this.
  const serviceWorkerConfigs = serviceWorkers(services).map(component => ({
    name: component.worker,
    modules: true,
    scriptPath: join(bundleDir, component.outfile),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      PORTAL_ORIGIN: `http://${host}:${ports[component.name]}`,
      GATEWAY_OIDC_ISSUER: useRealGoogle
        ? googleOidcIssuer ?? "https://accounts.google.com"
        : `http://${host}:${ports.mockOidc}`,
      GATEWAY_OIDC_CLIENT_ID: googleOidcClientId ?? "unidocs-portal-local",
      GATEWAY_OIDC_CLIENT_SECRET: googleOidcClientSecret ?? "unidocs-portal-local-secret",
      PORTAL_BOOTSTRAP_EMAIL: process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL ?? "",
    },
    d1Databases: { [component.d1Binding]: component.worker },
    unsafeDirectSockets: [{ host, port: ports[component.name] }],
  }));
```

In `stacks/unidocs-cloudflare/local/runtime.mjs`:

Add `services = []` to `startLocalRuntime`'s destructured options, next to `docTypes`, and thread it through the three call sites — `bundleTargets(docTypes, { ..., services })`, `resolvePorts(docTypes, portOverrides, services)`, and `buildWorkers({ ..., services })`.

**Two things come for free and must not be re-implemented.** `urls` is derived from `ports` (`Object.fromEntries(Object.entries(ports).map(...))` at line 437), so reserving `ports.portal` in `resolvePorts` already produces `runtime.urls.portal`. The free-port assertion runs over `Object.values(ports)` (line 426), so the new port is already checked. Adding either by hand would duplicate existing behaviour.

Add the migration runner beside `migrateSnapshotsDb`:

```js
/**
 * Apply a service's committed D1 migrations. Same ledger shape as
 * `migrateSnapshotsDb`, minus its bootstrap-inference branch: the gateway has
 * local databases that predate its ledger and must have their generation
 * inferred, while a service database here has no such history — a fresh one
 * simply applies every file.
 */
async function migrateServiceDb(mf, component, root) {
  const db = await mf.getD1Database(component.d1Binding, component.worker);
  const directory = join(root, component.migrations);
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS _unidocs_service_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);
  const appliedResult = await db.prepare("SELECT name FROM _unidocs_service_migrations ORDER BY name").all();
  const applied = new Set((appliedResult.results ?? []).map(row => row.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(directory, file), "utf8");
    await db.exec(sql);
    await db.prepare(
      "INSERT INTO _unidocs_service_migrations (name, applied_at) VALUES (?, ?)",
    ).bind(file, Date.now()).run();
  }
}
```

Call it once per selected component that declares migrations, in the same place `migrateSnapshotsDb(mf)` is called:

```js
  for (const component of serviceWorkers(services)) {
    if (component.migrations) await migrateServiceDb(mf, component, ROOT);
  }
```

Use whatever the module already calls the repository root — `migrateSnapshotsDb` resolves `MIGRATIONS_DIR` from it, so the constant exists.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run tests/unit/scripts/doc-types.test.mjs tests/unit/scripts/services.test.mjs
pnpm test:local
```

Expected: PASS. `pnpm test:local` covers `tests/integration/cloudflare`, which boots the runtime — confirm the existing integration tests still pass with the new option defaulted to empty.

- [ ] **Step 5: Commit**

```bash
git add stacks/unidocs-cloudflare/local/doc-types.mjs stacks/unidocs-cloudflare/local/runtime.mjs tests/unit/scripts/doc-types.test.mjs
git commit -m "feat(dev): run the portal worker inside the local runtime

Miniflare has no migrations runner, so the portal's D1 schema is applied the
way the gateway's already is: read the committed .sql files in filename order
and record each one in a ledger table. The portal database has no pre-ledger
generation to infer, so unlike the gateway it simply applies every file on a
fresh database.

The compatibility date comes from the runtime rather than the portal's
wrangler.jsonc, which is a deployment contract and should not be lowered to
suit whichever workerd the lockfile happens to pin."
```

---

### Task 4: Wire the selection through `pnpm dev`, and reject it on Azure

**Files:**
- Modify: `scripts/dev.mjs`
- Test: `tests/unit/scripts/services.test.mjs` (extend)

**Interfaces:**
- Consumes: `parseTargets` (Task 1), `startLocalRuntime({ services })` (Task 3).
- Produces: `pnpm dev portal`, `pnpm dev portal psd`, and a specific failure for `pnpm dev unidocs-azure portal`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/scripts/services.test.mjs`:

```js
import { assertServicesAvailable } from "../../../stacks/unidocs-cloudflare/local/services.mjs";

test("services are available on the Cloudflare stack", () => {
  expect(() => assertServicesAvailable("cloudflare", ["portal"])).not.toThrow();
  expect(() => assertServicesAvailable("azure", [])).not.toThrow();
});

test("asking for the portal on Azure says why, and names the missing package", () => {
  expect(() => assertServicesAvailable("azure", ["portal"]))
    .toThrow(/portal is not available on the unidocs-azure stack/);
  expect(() => assertServicesAvailable("azure", ["portal"])).toThrow(/packages\/azure-portal/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run tests/unit/scripts/services.test.mjs
```

Expected: FAIL — `assertServicesAvailable` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `stacks/unidocs-cloudflare/local/services.mjs`:

```js
/** Which stacks can run a given target, and what is missing when they cannot. */
const SERVICE_PLATFORMS = {
  portal: { cloudflare: true, azure: "packages/azure-portal does not exist yet" },
};

export function assertServicesAvailable(platform, names) {
  for (const name of names) {
    const support = SERVICE_PLATFORMS[name]?.[platform];
    if (support === true) continue;
    throw new Error(
      `${name} is not available on the unidocs-${platform} stack yet (${support ?? "no adapter is registered"}).`,
    );
  }
}
```

In `scripts/dev.mjs`:

- Replace the `parseDocTypes(positional)` call with `parseTargets(positional)`, destructuring `{ docTypes, services }`. Keep the existing error handling and `USAGE` output, and extend `USAGE` to read:

```js
const USAGE =
  "Usage: pnpm dev <unidocs-cloudflare|unidocs-azure> [docType|service ...] [--cas <remote|local>] [--fonts <auto|off>]\n" +
  "  document types: markdown, docx, psd    services: portal";
```

- Immediately after parsing, call `assertServicesAvailable(platform, services)` inside the same try/catch that prints the message and exits 1. This must run **before** the Docker probe and the port probe, so an unsupported selection fails on argv alone.
- Pass `services` into `startLocalRuntime({ ... })` on the Cloudflare branch.
- After the existing frontend loop, start each `serviceFrontends(services)` component the same way document-type frontends are started, injecting `GATEWAY_URL` identically. There are none today; the loop exists so the WebUI packages need no further wiring.
- The `Static registrations:` line prints document types only. Add a `Services:` line when `services.length > 0`.

- [ ] **Step 4: Run the tests and exercise the command**

```bash
pnpm exec vitest run tests/unit/scripts/services.test.mjs
pnpm dev unidocs-azure portal   # expect the specific message and exit 1
```

Expected: the unit tests pass; the Azure invocation prints `portal is not available on the unidocs-azure stack yet (packages/azure-portal does not exist yet).` and exits non-zero without starting Docker.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev.mjs stacks/unidocs-cloudflare/local/services.mjs tests/unit/scripts/services.test.mjs
git commit -m "feat(dev): accept portal as a positional dev target

Azure rejects it by name instead of ignoring it: a command that appears to
start something and does not is worse than one that refuses, and the message
says which package is missing so the reader knows what would fix it. The check
runs on argv alone, before the Docker and port probes, so the refusal costs
nothing."
```

---

### Task 5: Run it, and write down how

**Files:**
- Modify: `stacks/unidocs-cloudflare/local/README.md` if one exists, otherwise `stacks/README.md`
- Do **not** touch `CLAUDE.md`. It is listed in `.git/info/exclude` and has never been tracked — it is a local-only file, so editing it here would either be lost or, if force-added, push a private file to the remote. Its `pnpm dev docx` examples are stale, but correcting them is the repository owner's local edit to make.

- [ ] **Step 1: Start it and prove the login path works end to end**

```bash
pnpm dev portal
```

Then, against the printed portal URL:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/admin/auth/session          # expect 401
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8795/admin/auth/login  # expect 303 to the mock provider on 8793
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/admin/api/v1/document-types # expect 401
```

Record the three results. If the login redirect points at `accounts.google.com` rather than the mock, the issuer binding did not reach the worker — fix that before continuing.

- [ ] **Step 2: Confirm the combined selection**

```bash
pnpm dev portal psd
```

Confirm the printed URL list contains both the portal and the psd worker, and that `Ctrl+C` stops everything. Record what the terminal printed.

- [ ] **Step 3: Document it**

Add a short section covering: `pnpm dev portal` and `pnpm dev portal psd`; that `portal` is an umbrella whose WebUI components land later; that the local runtime supplies its own compatibility date, so running `wrangler dev` directly inside `packages/cloudflare-portal` fails against the pinned workerd; and that local login uses the mock OIDC provider, so no Google credentials are needed.

Do not edit `CLAUDE.md` (see the Files list above). If you notice its `pnpm dev` examples are stale, say so in your report instead.

- [ ] **Step 4: Full verification**

```bash
pnpm exec vitest run tests/unit/scripts
pnpm --filter @unidocs/cloudflare-portal test
pnpm typecheck
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add -A stacks docs
git commit -m "docs(dev): document the portal dev target

Records the two things a reader cannot derive from the code: that running
wrangler dev directly inside packages/cloudflare-portal fails because its
deployment compatibility date is newer than the pinned workerd, and that local
login needs no Google credentials because the runtime points the portal at the
mock OIDC provider."
```

---

## Out of scope

- `packages/admin-portal-webui`, `packages/tenant-portal-client`, `packages/tenant-portal-webui` — the registry has their row shape and the frontend loop is written, but the packages themselves are separate work.
- `packages/azure-portal` — the portal's repository layer is D1-shaped and Azure needs Postgres; Task 4 makes the gap explicit rather than papering over it.
- Any tenant HTTP route. The tenant business core in `@unidocs/portal-service` has no adapter, so `pnpm dev portal` exposes the administrator surface only.
- Upgrading wrangler or workerd. The compatibility-date mismatch is worked around locally, not resolved; resolving it means moving the lockfile past what the company registry carries.
