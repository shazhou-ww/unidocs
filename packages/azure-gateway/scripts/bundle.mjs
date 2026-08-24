/**
 * Bundles `dist/main.js` into a self-contained script that plain `node` can
 * run directly (`node packages/azure-gateway/dist/main.js`).
 *
 * See `packages/azure-markdown/scripts/bundle.mjs` for the full rationale —
 * this is the same technique (esbuild inlines every `@unidocs/*` workspace
 * import from its `.ts` source via `alias`, shared across every bundler in
 * this repo through `scripts/workspace-aliases.mjs`, while
 * `external: EXTERNAL_NPM_PACKAGES` — also from that module, see its doc
 * comment for why this is an explicit list rather than `packages:
 * "external"` — keeps real npm dependencies like `pg` out of the bundle,
 * resolved normally through `node_modules` at runtime).
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
  // 全仓统一用这一份显式列表:`packages: "external"` 会把每一个裸导入
  // 都留在外面,包括 `@azure/identity` 这种没有被提升到根 node_modules
  // 的包,产物只有在生产安装时才会以 ERR_MODULE_NOT_FOUND 暴露。
  external: EXTERNAL_NPM_PACKAGES,
  alias: resolveWorkspaceAliases(REPO_ROOT),
  // esbuild overwrites the plain-`tsc` `main.js` with the bundle; without
  // this, the `tsc`-emitted `main.js.map` from before would keep pointing
  // at source that no longer matches the file it's attached to.
  sourcemap: true,
  logLevel: "info",
});
