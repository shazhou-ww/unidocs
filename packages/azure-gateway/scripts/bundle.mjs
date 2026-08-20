/**
 * Bundles `dist/main.js` into a self-contained script that plain `node` can
 * run directly (`node packages/azure-gateway/dist/main.js`).
 *
 * See `packages/azure-markdown/scripts/bundle.mjs` for the full rationale —
 * this is the same technique (esbuild inlines every `@unidocs/*` workspace
 * import from its `.ts` source via `alias`, while `packages: "external"`
 * keeps real npm dependencies like `pg` out of the bundle, resolved normally
 * through `node_modules` at runtime), scoped to this package's dependency
 * graph.
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
