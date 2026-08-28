import { join } from "node:path";

/**
 * Single source of truth for the `@unidocs/*` -> `src/index.ts` alias table
 * every esbuild-based bundler in this repo needs.
 *
 * Why this exists: per the repo convention (README's "Workspace package
 * resolution"), each `@unidocs/*` package's `main`/`exports` point at its
 * own `src/index.ts`, not `dist/` — that's what lets `vitest`/`pnpm -r test`
 * run without a pre-build, because vite/vitest's resolver transpiles TS on
 * the fly. A bundler has no such resolver of its own, so anything that
 * bundles workspace source directly (Cloudflare Workers via
 * `stacks/unidocs-cloudflare/local/runtime.mjs`, the Azure services' own `scripts/bundle.mjs`)
 * has to point esbuild's `alias` option at the real `.ts` entry file itself.
 *
 * Before this module existed, that table was hand-copied in three places
 * (`stacks/unidocs-cloudflare/local/runtime.mjs`, `packages/azure-markdown/scripts/bundle.mjs`,
 * `packages/azure-gateway/scripts/bundle.mjs`). A missing entry there is NOT
 * a build failure — `packages: "external"` just leaves the unaliased
 * specifier as a bare import, esbuild has no way to know that's wrong, and
 * the bundle produces `ERR_MODULE_NOT_FOUND` only once the process actually
 * runs and tries to import it. One shared table, always passed in full
 * (below), removes the "which subset does this one caller need" judgment
 * call entirely — every bundler in the repo always gets every entry, so
 * adding a workspace package here once is enough for a NEW alias/subpath to
 * become available to all three callers automatically. If it isn't listed
 * here at all, that failure mode is unchanged, but there is only one place
 * left to check when it happens.
 */
const WORKSPACE_PACKAGE_ENTRYPOINTS = {
  "@unidocs/protocol": "packages/protocol/src/index.ts",
  "@unicas/protocol": "unicas-packages/protocol/src/index.ts",
  "@unidocs/protocol-doc": "packages/protocol-doc/src/index.ts",
  "@unidocs/protocol-gateway": "packages/protocol-gateway/src/index.ts",
  "@unidocs/service-auth": "packages/service-auth/src/index.ts",
  "@unidocs/svalue-codec": "packages/svalue-codec/src/index.ts",
  "@unidocs/svalue-codec/internal": "packages/svalue-codec/src/internal.ts",
  "@unidocs/gateway-common": "packages/gateway-common/src/index.ts",
  "@unicas/server-common": "unicas-packages/server-common/src/index.ts",
  "@unicas/client": "unicas-packages/client/src/index.ts",
  "@unidocs/doctype-server-common": "packages/doctype-server-common/src/index.ts",
  "@unidocs/doctype-server-common/agent": "packages/doctype-server-common/src/agent/index.ts",
  "@unidocs/azure-sdk": "packages/azure-sdk/src/index.ts",
  "@unidocs/cloudflare-sdk": "packages/cloudflare-sdk/src/index.ts",
  "@unidocs/doctype-markdown": "packages/doctype-markdown/src/index.ts",
  "@unidocs/doctype-docx": "packages/doctype-docx/src/index.ts",
  "@unidocs/doctype-psd": "packages/doctype-psd/src/index.ts",
  "@unidocs/doctype-psd/engine": "packages/doctype-psd/src/engine.ts",
};

/**
 * Resolves the table above to absolute paths under `repoRoot`. Always
 * returns every entry — see the module doc for why callers should not try
 * to hand-pick a subset.
 */
export function resolveWorkspaceAliases(repoRoot) {
  const result = {};
  for (const [specifier, relPath] of Object.entries(WORKSPACE_PACKAGE_ENTRYPOINTS)) {
    result[specifier] = join(repoRoot, relPath);
  }
  return result;
}

/**
 * Single source of truth for which bare (non-`@unidocs/*`) npm specifiers
 * every esbuild-based Azure bundler must mark `external` instead of bundling
 * — all five Azure bundle points in this repo import this rather than
 * hardcoding their own copy: `packages/azure-markdown/scripts/bundle.mjs`,
 * `packages/azure-gateway/scripts/bundle.mjs`,
 * `packages/azure-sdk/scripts/bundle-migrate-cli.mjs`,
 * `packages/azure-docx/scripts/bundle.mjs`, and
 * `stacks/unidocs-azure/local/runtime.mjs`'s `bundleService()`. They used to be split
 * between two strategies — `packages: "external"` for the first three,
 * this explicit list for the last two — and that split itself caused a
 * production bug: `azure-docx` used the explicit list but never declared
 * `pg`/`@azure/storage-blob` in its own `dependencies`, which only a real
 * production install (not the monorepo's root `node_modules` hoisting)
 * exposes as `ERR_MODULE_NOT_FOUND`. All five now use this one list so
 * there is exactly one place the "did every external package get declared"
 * invariant needs to hold (enforced by `tests/unit/scripts/bundle-deps.test.mjs`).
 *
 * Why these three, and why not just `packages: "external"` (which marks EVERY
 * bare import external, no list needed): that blanket flag only stays
 * resolvable at runtime for an npm dependency that is *also* hoisted to the
 * repo-root `node_modules` — an ancestor of every path these bundles get
 * written to (`packages/azure-{name}/dist/`, `.azure-runtime/bundles/`).
 * `pg`, `@azure/storage-blob`, and `@azure/identity` qualify only because
 * they're *also* direct `devDependencies` of the root `package.json`, so
 * pnpm hoists them there.
 *
 * `@azure/identity` specifically cannot be flipped the other way (inlined
 * instead of externalized) even though esbuild is happy to try: inlining it
 * pulls its CJS transitive dependencies (`jsonwebtoken`, `jws`) into the
 * bundle, and that crashes at runtime with `Dynamic require of "buffer" is
 * not supported` — killed `azure-markdown`'s and `azure-docx`'s local
 * processes on startup. This was measured, not assumed; if a future change
 * is tempted to drop `@azure/identity` from this list to shrink the
 * external surface, it will reintroduce that crash.
 *
 * A doc type's own real npm dependency declared on a nested workspace
 * package only (e.g. `doctype-docx`'s `@ariadng/office`) is NOT hoisted
 * anywhere reachable from those bundle locations — since
 * `@unidocs/doctype-docx` is alias-inlined as source (via
 * `resolveWorkspaceAliases` above), its own `import ... from
 * "@ariadng/office/..."` line ends up literally in the bundle, and
 * `packages: "external"` would leave that as an unresolvable bare import at
 * runtime (`ERR_MODULE_NOT_FOUND`). Naming only the packages that genuinely
 * do resolve at runtime lets esbuild inline everything else instead.
 *
 * If a future doc type needs a new bare npm import to actually stay
 * external at runtime (e.g. a native binding, or another root
 * devDependency), add it here — this list, not `packages: "external"`, is
 * what every Azure bundler now uses. One shared array removes the
 * "which caller's copy did I update" judgment call this task's own review
 * caught: two independently-hardcoded literals kept in sync only by a
 * cross-referencing comment is exactly the drift hazard
 * `resolveWorkspaceAliases` above already exists to prevent for the alias
 * table.
 */
export const EXTERNAL_NPM_PACKAGES = ["pg", "@azure/storage-blob", "@azure/identity"];
