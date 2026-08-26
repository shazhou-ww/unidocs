/**
 * Standalone CAS middleware local runtime.
 *
 * Starts only the CAS middleware — the tenant CAS worker (8791), the admin
 * BFF (8792), and the local mock OIDC provider (8793) — with no gateway and
 * no doc type workers, mirroring the middleware's independent deployment
 * boundary. The admin console UI is served separately by Vite:
 *
 *   pnpm dev:cas-admin
 *   pnpm --filter @unidocs/cas-admin-webui dev:ui   # -> http://localhost:4070/admin/
 *
 * Set GOOGLE_OIDC_CLIENT_ID / GOOGLE_OIDC_CLIENT_SECRET to use the real
 * Google issuer instead of the local mock provider.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const { LogLevel } = await import("miniflare");
const { startLocalRuntime } = await import("../stacks/cloudflare/local/runtime.mjs");

const runtime = await startLocalRuntime({
  docTypes: [],
  persistPath: join(root, ".wrangler", "miniflare"),
  logLevel: LogLevel.INFO,
  casMiddlewareOnly: true,
});

console.log("CAS middleware local runtime (standalone)");
for (const [name, url] of Object.entries(runtime.urls)) {
  console.log(`  ${name.padEnd(8)} ${url}`);
}
console.log(
  "Admin console: run `pnpm --filter @unidocs/cas-admin-webui dev:ui` then open http://localhost:4070/admin/",
);
console.log("Ctrl+C to stop.");

const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
