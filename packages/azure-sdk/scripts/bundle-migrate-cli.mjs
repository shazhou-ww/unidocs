/**
 * Bundles `dist/migrate-cli.js` into a self-contained script that plain
 * `node` can run directly. See `src/migrate-cli.ts` for what it does and
 * why it exists, and `packages/azure-markdown/scripts/bundle.mjs` for the
 * general "why bundle at all" rationale (`main`/`exports` pointing at `src`
 * defeats plain `node`'s module resolution across packages).
 *
 * `migrate-cli.ts` only imports siblings within this package (`./pool.js`,
 * `./migrate.js`) — never a bare `@unidocs/*` specifier — so unlike the two
 * Azure services' bundlers, this one needs no workspace alias table at all;
 * esbuild resolves the relative imports directly. It still needs the
 * `external: EXTERNAL_NPM_PACKAGES` list from `scripts/workspace-aliases.mjs`
 * (see that module's doc comment) so genuine npm dependencies like `pg`
 * stay out of the bundle instead of `packages: "external"`, which every
 * Azure bundler in this repo now avoids.
 *
 * The output path matters: it must land at `dist/migrate-cli.js`, one
 * directory below the package root, the same depth as a plain `tsc`-built
 * `dist/migrate.js` — that is what keeps `migrate.ts`'s default
 * `MIGRATIONS_DIR` (computed from `import.meta.url`, which bundling
 * rewrites to point at THIS output file) resolving to the real
 * `packages/azure-sdk/migrations` after bundling. Moving this script's
 * `outfile` elsewhere would silently break that.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { EXTERNAL_NPM_PACKAGES } from "../../../scripts/workspace-aliases.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  absWorkingDir: PKG_ROOT,
  entryPoints: ["src/migrate-cli.ts"],
  outfile: "dist/migrate-cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // 全仓统一用这一份显式列表:`packages: "external"` 会把每一个裸导入
  // 都留在外面,包括 `@azure/identity` 这种没有被提升到根 node_modules
  // 的包,产物只有在生产安装时才会以 ERR_MODULE_NOT_FOUND 暴露。
  external: EXTERNAL_NPM_PACKAGES,
  // esbuild overwrites the plain-`tsc` `migrate-cli.js` with the bundle;
  // without this, a stale `tsc`-emitted `migrate-cli.js.map` would keep
  // pointing at source that no longer matches the file it's attached to.
  sourcemap: true,
  logLevel: "info",
});
