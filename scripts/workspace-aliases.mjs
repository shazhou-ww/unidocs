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
