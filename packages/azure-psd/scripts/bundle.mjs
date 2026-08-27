/**
 * Bundles `dist/main.js` into a self-contained script that plain `node` can
 * run directly (`node packages/azure-psd/dist/main.js`).
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
 * shared with `stacks/unidocs-cloudflare/local/runtime.mjs` and
 * `packages/azure-gateway/scripts/bundle.mjs` via
 * `scripts/workspace-aliases.mjs`, see that module's doc for why).
 *
 * Every azure-* bundler in this repo, this one included, uses the explicit
 * `EXTERNAL_NPM_PACKAGES` list from `scripts/workspace-aliases.mjs` rather
 * than esbuild's `packages: "external"`. The two look interchangeable but
 * aren't: `packages: "external"` leaves *every* bare import unresolved,
 * including PSD's own real npm dependencies (`ag-psd`, `fast-png`) — those
 * would ship as unresolvable imports and blow up at runtime with
 * `ERR_MODULE_NOT_FOUND` the moment the bundle actually runs. The explicit
 * list only externalizes the packages that are genuinely safe to leave out
 * (already real JS/CJS, resolved normally through `node_modules`), and
 * inlines everything else — `ag-psd` / `fast-png` included. See
 * `scripts/workspace-aliases.mjs`'s doc comment for the full
 * runtime-resolution reasoning and why this list has exactly one
 * definition, shared with `stacks/unidocs-azure/local/runtime.mjs`'s
 * `bundleService()`. `tests/unit/scripts/bundle-deps.test.mjs` enforces this
 * choice repo-wide: it fails any azure-* bundler that uses
 * `packages: "external"` instead of this explicit list.
 *
 * `package.json`'s `build` script runs `tsc` first (for `dist/*.d.ts`, kept
 * for consistency with the repo's `main`/`types`/`exports` -> `dist/*`
 * `publishConfig` convention) and then this script, which overwrites
 * `dist/main.js` with the runnable bundle.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  EXTERNAL_NPM_PACKAGES,
  resolveWorkspaceAliases,
} from "../../../scripts/workspace-aliases.mjs";

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
  external: EXTERNAL_NPM_PACKAGES,
  alias: resolveWorkspaceAliases(REPO_ROOT),
  // esbuild overwrites the plain-`tsc` `main.js` with the bundle; without
  // this, the `tsc`-emitted `main.js.map` from before would keep pointing
  // at source that no longer matches the file it's attached to.
  sourcemap: true,
  logLevel: "info",
});
