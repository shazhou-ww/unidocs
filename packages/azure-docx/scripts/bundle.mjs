/**
 * Bundles `dist/main.js` into a self-contained script that plain `node` can
 * run directly (`node packages/azure-docx/dist/main.js`).
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
 * shared with `scripts/local-runtime.mjs` and
 * `packages/azure-gateway/scripts/bundle.mjs` via
 * `scripts/workspace-aliases.mjs`, see that module's doc for why).
 *
 * Unlike `packages/azure-markdown/scripts/bundle.mjs`, this file does NOT
 * use `packages: "external"`. That blanket flag marks every bare (non-
 * `@unidocs/*`) import external, on the assumption a plain Node `require`/
 * `import` from the bundle's own directory can always find it again — true
 * for `pg`/`@azure/storage-blob` only because they're also root
 * `package.json` devDependencies, so pnpm hoists them to the repo root
 * `node_modules`, which sits on every bundle's ancestor path. DOCX's own
 * real npm dependency, `@ariadng/office` (declared only on
 * `packages/doctype-docx`, pulled in here because `@unidocs/doctype-docx`
 * is alias-inlined as source), is *not* a root dependency and is *not*
 * hoisted anywhere a `packages/azure-docx/dist/main.js` or a
 * `.azure-runtime/bundles/docx.mjs` can find it by walking up from its own
 * location — `packages: "external"` would leave a bare import Node can
 * never resolve at runtime (`ERR_MODULE_NOT_FOUND`). Explicitly externalizing
 * only `pg`/`@azure/storage-blob` (the packages that really do resolve at
 * runtime) lets esbuild inline everything else — `@ariadng/office` included —
 * straight into the bundle, which is what actually makes it self-contained.
 *
 * `package.json`'s `build` script runs `tsc` first (for `dist/*.d.ts`, kept
 * for consistency with the repo's `main`/`types`/`exports` -> `dist/*`
 * `publishConfig` convention) and then this script, which overwrites
 * `dist/main.js` with the runnable bundle.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");

await esbuild.build({
  absWorkingDir: PKG_ROOT,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // See the file-level comment above for why this isn't `packages: "external"`.
  external: ["pg", "@azure/storage-blob"],
  alias: resolveWorkspaceAliases(REPO_ROOT),
  // esbuild overwrites the plain-`tsc` `main.js` with the bundle; without
  // this, the `tsc`-emitted `main.js.map` from before would keep pointing
  // at source that no longer matches the file it's attached to.
  sourcemap: true,
  logLevel: "info",
});
