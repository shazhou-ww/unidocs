/**
 * `bundleWorker`'s esbuild `external` list, pinned per entry.
 *
 * This exists because the list was once keyed by a hard-coded array of two
 * entry paths, and `packages/cloudflare-gateway/src/worker.ts` was not one of
 * them. When platform-document-do.ts started importing `DurableObject` from
 * `cloudflare:workers`, esbuild failed with `Could not resolve
 * "cloudflare:workers"` — and because `bundleTargets` builds the gateway for
 * *every* selection, `pnpm dev` could not boot a single target, branch-wide,
 * for any doc type or service. A whole-runtime outage with no failing test.
 *
 * The two externals are pinned for two different reasons, and the tests are
 * split the same way:
 *
 * - `cloudflare:workers` is a workerd built-in. It resolves at runtime with no
 *   compatibility flag, so it must be external unconditionally — for every
 *   entry `bundleTargets` can emit, present and future.
 * - `node:*` resolves only under `compatibilityFlags: ["nodejs_compat"]`, so
 *   externalizing it on an entry whose worker lacks that flag would convert a
 *   build error into a runtime one. The drift guard ties the two tables
 *   together so neither can drift.
 *
 * Both sweeps expand from the registries themselves (`DOC_TYPES`,
 * `SERVICE_TARGETS`) rather than a hand-written list: a guard that has to be
 * edited when a row is added is a guard that will be green on the day it
 * matters. The final describe pins that `bundleWorker` asks for the computed
 * list instead of restating one at the call site.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as esbuild from "esbuild";
import { bundleWorker } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import {
  ADMIN_PORT,
  DOC_TYPES,
  EDGE_PORT,
  MOCK_OIDC_PORT,
  buildWorkers,
  bundleExternals,
  bundleTargets,
  resolvePorts,
} from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { SERVICE_TARGETS } from "../../../stacks/unidocs-cloudflare/local/services.mjs";

// `bundleWorker` is the only thing here that reaches esbuild; stubbing it lets
// the wiring test read back the options without a real build.
vi.mock("esbuild", () => ({ build: vi.fn(async () => ({})) }));

// Both registries, expanded — never a hand-written list. A doc type or a
// service target added later is swept by every test below automatically, which
// is the whole point: the tables these tests compare can only be kept honest
// if both sides grow from the same rows.
const ALL_DOC_TYPES = Object.keys(DOC_TYPES);
const ALL_SERVICES = Object.keys(SERVICE_TARGETS);
const GATEWAY_ENTRY = "packages/cloudflare-gateway/src/worker.ts";
const PORTAL_ENTRY = "packages/cloudflare-portal/src/worker.ts";

/** Every entry the local runtime can ask esbuild to bundle. */
const ALL_TARGETS = bundleTargets(ALL_DOC_TYPES, { services: ALL_SERVICES });

describe("cloudflare:workers is external everywhere", () => {
  // Named on its own: this is the entry the bug was in, and the one whose
  // failure takes every other target down with it.
  test("the gateway entry is externalized", () => {
    expect(bundleExternals(GATEWAY_ENTRY)).toContain("cloudflare:workers");
  });

  // `bundleWorker` is called with join(ROOT, entry), so the absolute form has
  // to match too — a prefix-anchored check would silently stop matching.
  test("an absolute entry path is externalized the same way", () => {
    expect(bundleExternals(join("/somewhere/unidocs", GATEWAY_ENTRY)))
      .toContain("cloudflare:workers");
  });

  test.each(ALL_TARGETS.map(({ entry }) => entry))("%s is externalized", (entry) => {
    expect(bundleExternals(entry)).toContain("cloudflare:workers");
  });

  // The gateway really is in that list — otherwise the sweep above passes
  // vacuously if `bundleTargets` ever stops emitting it.
  test("bundleTargets emits the gateway for every selection", () => {
    expect(ALL_TARGETS.map(({ entry }) => entry)).toContain(GATEWAY_ENTRY);
    expect(bundleTargets([], { services: [] }).map(({ entry }) => entry))
      .toContain(GATEWAY_ENTRY);
  });
});

describe("node:* stays scoped to the nodejs_compat entries", () => {
  test("the gateway does not externalize node:*", () => {
    expect(bundleExternals(GATEWAY_ENTRY)).not.toContain("node:*");
  });

  test("the portal does externalize node:*", () => {
    expect(bundleExternals(PORTAL_ENTRY)).toContain("node:*");
  });

  // The classifier normalizes separators before matching. Without that, a
  // Windows-style path misses the table and silently loses `node:*` — a
  // runtime "node:crypto is not available" on the portal rather than a build
  // error, and only on the one platform nobody here runs.
  test("a Windows-separator portal path classifies the same way", () => {
    expect(bundleExternals(PORTAL_ENTRY.replaceAll("/", "\\"))).toContain("node:*");
    expect(bundleExternals(join("C:\\unidocs", PORTAL_ENTRY).replaceAll("/", "\\")))
      .toContain("node:*");
  });

  /**
   * The drift guard: the set of entries that externalize `node:*` must be
   * exactly the set of workers that declare `nodejs_compat`. Adding a
   * `node:crypto` import to a worker without the flag, or dropping the flag
   * from a worker that has the import, fails here instead of at runtime.
   */
  test("matches the workers that declare the flag", () => {
    const bundleDir = "/tmp/unidocs-externals-test";
    const ports = {
      ...resolvePorts(ALL_DOC_TYPES, {}, ALL_SERVICES),
      admin: ADMIN_PORT,
      mockOidc: MOCK_OIDC_PORT,
      edge: EDGE_PORT,
    };
    const workers = buildWorkers({
      docTypes: ALL_DOC_TYPES,
      host: "127.0.0.1",
      ports,
      bundleDir,
      services: ALL_SERVICES,
      casMiddleware: true,
      capabilityFixture: { issuer: "https://example.test", jwks: { keys: [] }, kid: "k", privateKeyPkcs8: "p" },
      stackFixture: {
        issuer: "https://stack.example.test",
        audience: "aud",
        stackId: "stack",
        kid: "k",
        privateKeyPkcs8: "p",
        jwks: { keys: [] },
      },
    });

    const nodeCompatScripts = new Set(
      workers
        .filter(worker => (worker.compatibilityFlags ?? []).includes("nodejs_compat"))
        .map(worker => worker.scriptPath)
        .filter(Boolean),
    );
    const nodeCompatOutfiles = ALL_TARGETS
      .filter(({ outfile }) => nodeCompatScripts.has(join(bundleDir, outfile)))
      .map(({ outfile }) => outfile)
      .sort();
    const externalizedOutfiles = ALL_TARGETS
      .filter(({ entry }) => bundleExternals(entry).includes("node:*"))
      .map(({ outfile }) => outfile)
      .sort();

    expect(nodeCompatOutfiles.length).toBeGreaterThan(0);
    expect(externalizedOutfiles).toEqual(nodeCompatOutfiles);
  });
});

/**
 * Everything above pins the *rule*. This pins that `bundleWorker` actually
 * asks for it: hard-coding `external: ["cloudflare:workers", "node:*"]` at the
 * call site would leave every other test in this file green while handing
 * `node:*` to workers that never declared `nodejs_compat`.
 */
describe("bundleWorker passes the computed list to esbuild", () => {
  const outfile = join(tmpdir(), "unidocs-externals-wiring", "out.js");

  beforeEach(() => {
    vi.mocked(esbuild.build).mockClear();
  });

  test.each([GATEWAY_ENTRY, PORTAL_ENTRY])("%s", async (entry) => {
    await bundleWorker(entry, outfile);
    expect(esbuild.build).toHaveBeenCalledTimes(1);
    expect(vi.mocked(esbuild.build).mock.calls[0][0].external)
      .toEqual(bundleExternals(entry));
  });
});
