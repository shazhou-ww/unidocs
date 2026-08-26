/**
 * Standalone CAS middleware local dev — ONE command.
 *
 * Starts the CAS middleware backend (tenant CAS 8791 + admin BFF 8792 +
 * local mock OIDC 8793) and spawns the admin console frontend (Vite dev on
 * 4070) as a child process. Ctrl+C tears both down.
 *
 *   pnpm dev:cas-admin        # -> http://localhost:4070/admin/
 *
 * With the local mock OIDC provider, no Google configuration is needed —
 * no client id/secret, and no registered redirect URI (the mock provider
 * accepts any redirect_uri). Set GOOGLE_OIDC_CLIENT_ID /
 * GOOGLE_OIDC_CLIENT_SECRET to use the real Google issuer instead; then the
 * Google-console redirect URI http://localhost:4070/admin/auth/callback
 * applies.
 */
import { spawn } from "node:child_process";
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

// Admin console frontend: one command runs the whole middleware dev env.
const web = spawn("pnpm --filter @unicas/admin-webui dev:ui", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
web.on("error", (err) => console.error("[cas-admin web] failed to start:", err.message));
console.log("Admin console: http://localhost:4070/admin/");
console.log("Ctrl+C to stop.");

const shutdown = async () => {
  web.kill("SIGINT");
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
