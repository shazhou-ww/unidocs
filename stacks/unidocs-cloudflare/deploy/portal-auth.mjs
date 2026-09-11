import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = join(root, "packages/cloudflare-portal");
const origin = "https://unidocs.shazhou.work";
const protectedDatabaseIds = new Set(["d3c78c42-b32f-4a4d-86e4-6cf6341baa8f"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPortalAuthDeploymentConfig(template, settings) {
  const { databaseId, googleClientId, bootstrapEmail } = settings;
  if (typeof databaseId !== "string" || !uuid.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId) || protectedDatabaseIds.has(databaseId.toLowerCase())) {
    throw new Error("A dedicated Portal D1 database ID is required; the Gateway database must not be reused");
  }
  if (typeof googleClientId !== "string" || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId)) throw new Error("A Google OAuth client ID is required");
  if (typeof bootstrapEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail) || bootstrapEmail !== bootstrapEmail.trim().toLowerCase()) throw new Error("A normalized bootstrap email is required");
  return {
    name: "unidocs-portal",
    main: join(packageRoot, "src/worker.ts"),
    compatibility_date: template.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    vars: {
      PORTAL_ORIGIN: origin,
      GATEWAY_OIDC_ISSUER: "https://accounts.google.com",
      GATEWAY_OIDC_CLIENT_ID: googleClientId,
      PORTAL_BOOTSTRAP_EMAIL: bootstrapEmail,
    },
    secrets: { required: ["GATEWAY_OIDC_CLIENT_SECRET"] },
    d1_databases: [{ binding: "DB", database_name: "unidocs-portal", database_id: databaseId, migrations_dir: join(packageRoot, "migrations") }],
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 } },
  };
}

export function portalAuthDeploymentSummary(config) {
  return {
    worker: config.name,
    origin: config.vars.PORTAL_ORIGIN,
    callback: `${config.vars.PORTAL_ORIGIN}/admin/auth/callback`,
    database: config.d1_databases[0].database_name,
    publicRoutes: config.routes,
    willDeploy: false,
    conflicts: ["/admin/auth/login", "/admin/auth/session", "cookie: __Host-unidocs_admin"],
    nextGate: "Confirm isolated rehearsal or legacy admin auth cutover before exposing public routes",
  };
}

export async function checkPortalAuthDeployment(settings, run = spawnSync) {
  const source = await readFile(join(packageRoot, "wrangler.jsonc"), "utf8");
  const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", source);
  if (parsed.error) throw new Error("Invalid Portal Wrangler configuration");
  const config = createPortalAuthDeploymentConfig(parsed.config, settings);
  const directory = await mkdtemp(join(tmpdir(), "unidocs-portal-check-"));
  try {
    const configPath = join(directory, "wrangler.jsonc");
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const wrangler = join(packageRoot, "node_modules/wrangler/bin/wrangler.js");
    const result = run(process.execPath, [wrangler, "deploy", "--dry-run", "--config", configPath], {
      cwd: packageRoot, env: process.env, stdio: "pipe", encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("Portal deployment dry-run failed; no deployment was requested");
    return portalAuthDeploymentSummary(config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("This command accepts no arguments and only performs a dry-run");
    process.exitCode = 1;
  } else {
    try {
      const summary = await checkPortalAuthDeployment({
        databaseId: process.env.PORTAL_D1_DATABASE_ID,
        googleClientId: process.env.GATEWAY_OIDC_CLIENT_ID,
        bootstrapEmail: process.env.PORTAL_BOOTSTRAP_EMAIL,
      });
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Portal deployment check failed");
      process.exitCode = 1;
    }
  }
}