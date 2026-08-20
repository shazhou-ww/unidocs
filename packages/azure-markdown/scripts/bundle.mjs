/**
 * Bundles `dist/main.js` into a self-contained script that plain `node` can
 * run directly (`node packages/azure-markdown/dist/main.js`).
 *
 * Why this exists, and why `tsc` alone (what every other package's `build`
 * script uses) is not enough here: per the repo convention (README's
 * "Workspace package resolution"), every `@unidocs/*` workspace package's
 * `main`/`exports` point at its `src/index.ts`, not `dist/`. That convention
 * exists so `pnpm -r test`/`vitest` don't need a pre-build — vite/vitest's
 * own resolver transforms TS on the fly. Plain `node`, running a `tsc`-emitted
 * `dist/main.js`, has no such resolver: it would follow `@unidocs/azure-sdk`
 * straight to `packages/azure-sdk/src/index.ts`, a `.ts` file whose own
 * relative imports (`./pool.js`, etc.) point at siblings that don't exist as
 * `.js` — nothing else in this repo runs a workspace package this way
 * (Cloudflare workers ship through `wrangler`'s own bundler instead), so
 * that mismatch was never exercised before.
 *
 * Fix: `esbuild` transpiles TS itself, so bundling resolves and inlines
 * every `@unidocs/*` import directly from its `.ts` source (`alias` below —
 * same technique `scripts/local-runtime.mjs` uses to bundle Cloudflare
 * workers for Miniflare, adapted for `platform: "node"` instead of
 * `"browser"`). `packages: "external"` keeps genuine npm dependencies (`pg`,
 * `@azure/storage-blob`) OUT of the bundle — they already ship real
 * JS/CJS and are resolved normally through `node_modules` at runtime; only
 * the alias entries below are pulled in as source.
 *
 * `package.json`'s `build` script runs `tsc` first (for `dist/*.d.ts`, kept
 * for consistency with the repo's `main`/`types`/`exports` -> `dist/*`
 * `publishConfig` convention) and then this script, which overwrites
 * `dist/main.js` with the runnable bundle.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");

const WORKSPACE_ALIASES = {
  "@unidocs/core": join(REPO_ROOT, "packages/core/src/index.ts"),
  "@unidocs/cas": join(REPO_ROOT, "packages/cas/src/index.ts"),
  "@unidocs/server-core": join(REPO_ROOT, "packages/server-core/src/index.ts"),
  "@unidocs/azure-sdk": join(REPO_ROOT, "packages/azure-sdk/src/index.ts"),
  "@unidocs/doctype-markdown": join(REPO_ROOT, "packages/doctype-markdown/src/index.ts"),
};

await esbuild.build({
  absWorkingDir: PKG_ROOT,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  alias: WORKSPACE_ALIASES,
  logLevel: "info",
});
