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
 * `scripts/local-runtime.mjs`, the Azure services' own `scripts/bundle.mjs`)
 * has to point esbuild's `alias` option at the real `.ts` entry file itself.
 *
 * Before this module existed, that table was hand-copied in three places
 * (`scripts/local-runtime.mjs`, `packages/azure-markdown/scripts/bundle.mjs`,
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
  "@unidocs/core": "packages/core/src/index.ts",
  "@unidocs/core/internal": "packages/core/src/internal.ts",
  "@unidocs/cas": "packages/cas/src/index.ts",
  "@unidocs/server-core": "packages/server-core/src/index.ts",
  "@unidocs/azure-sdk": "packages/azure-sdk/src/index.ts",
  "@unidocs/cloudflare-sdk": "packages/cloudflare-sdk/src/index.ts",
  "@unidocs/cloudflare-cas/public": "packages/cloudflare-cas/src/public-cas-route.ts",
  "@unidocs/doctype-markdown": "packages/doctype-markdown/src/index.ts",
  "@unidocs/doctype-docx": "packages/doctype-docx/src/index.ts",
  "@unidocs/doctype-psd": "packages/doctype-psd/src/index.ts",
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
 * — `packages/azure-docx/scripts/bundle.mjs` and `scripts/azure-runtime.mjs`'s
 * `bundleService()` both import this rather than hardcoding their own copy.
 *
 * Why these two, and why not just `packages: "external"` (which marks EVERY
 * bare import external, no list needed): that blanket flag only stays
 * resolvable at runtime for an npm dependency that is *also* hoisted to the
 * repo-root `node_modules` — an ancestor of every path these bundles get
 * written to (`packages/azure-{name}/dist/`, `.azure-runtime/bundles/`).
 * `pg` and `@azure/storage-blob` qualify only because they're *also* direct
 * `devDependencies` of the root `package.json`, so pnpm hoists them there.
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
export const EXTERNAL_NPM_PACKAGES = ["pg", "@azure/storage-blob"];
