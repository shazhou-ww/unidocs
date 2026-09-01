import { createServer } from "node:net";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
} from "jose";
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
} from "miniflare";
import {
  buildWorkers,
  bundleTargets,
  ADMIN_PORT,
  MOCK_OIDC_PORT,
  EDGE_PORT,
  DOC_TYPES,
  GATEWAY_WORKER,
  SERVICE_WORKER,
  resolvePorts,
} from "./doc-types.mjs";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";
import { docSessionObjectName } from "../../../packages/doctype-server-common/src/session-object-name.ts";
import { migrateControlSchema } from "../../../unicas-packages/service-cloudflare/src/control-schema.ts";

export { DOC_TYPES, parseDocTypes } from "./doc-types.mjs";

export const DEFAULT_PORTS = resolvePorts(Object.keys(DOC_TYPES));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// See scripts/workspace-aliases.mjs — shared with the Azure services'
// own esbuild bundlers so this table is kept in one place.
const WORKSPACE_ALIASES = resolveWorkspaceAliases(ROOT);

async function bundleWorker(entry, outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    alias: WORKSPACE_ALIASES,
    ...(entry.replaceAll("\\", "/").includes("unicas-packages/service-cloudflare/")
      ? { external: ["cloudflare:workers", "node:*"] }
      : {}),
    logOverride: { "empty-import-meta": "silent" },
  });
}

function workerUrl(host, port) {
  return `http://${host}:${port}`;
}

/**
 * Parse a wrangler-style .dev.vars file (KEY=VALUE lines, # comments,
 * optional surrounding quotes). Missing file → empty object.
 *
 * The values are secrets (the PSD Operator's LLM_API_KEY, …): they go straight
 * into Miniflare bindings and must never be logged.
 */
export async function readDevVars(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const MIGRATIONS_DIR = join(
  ROOT,
  "packages",
  "cloudflare-gateway",
  "migrations",
);

/**
 * Apply the Gateway-owned D1 schema. Real
 * Cloudflare D1 (via wrangler) gets this from `migrations_dir` in
 * wrangler.toml; local Miniflare has no migrations runner, so we read all SQL
 * files in filename order and record each successful filename. Older local
 * databases predate the ledger, so bootstrap infers their schema generation
 * once before applying only genuinely pending migrations.
 */
async function migrateSnapshotsDb(mf) {
  const db = await mf.getD1Database("GATEWAY_DB", GATEWAY_WORKER);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(file => file.endsWith(".sql"))
    .sort();
  await db.exec("CREATE TABLE IF NOT EXISTS _unidocs_gateway_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const appliedResult = await db.prepare(
    "SELECT name FROM _unidocs_gateway_migrations ORDER BY name",
  ).all();
  const applied = new Set((appliedResult.results ?? []).map(row => row.name));
  if (applied.size === 0) {
    await bootstrapMigrationLedger(db, files, applied);
  }
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
    await db.prepare(
      "INSERT INTO _unidocs_gateway_migrations (name, applied_at) VALUES (?, ?)",
    ).bind(file, Date.now()).run();
  }
}

async function bootstrapMigrationLedger(db, files, applied) {
  const gatewayTable = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_documents'",
  ).first();
  if (!gatewayTable) return;

  const columns = await db.prepare("PRAGMA table_info(gateway_documents)").all();
  const columnNames = new Set((columns.results ?? []).map(column => column.name));
  if (!columnNames.has("owner_id")) {
    // A prior run completed the tenant-key migration before the ledger existed.
    // Clean up legacy tables that an interrupted replay may have recreated.
    await db.exec("DROP TABLE IF EXISTS snapshots;\nDROP TABLE IF EXISTS docs;");
    await recordAppliedMigrations(db, files, applied);
    return;
  }

  const completed = ["0001_init.sql", "0002_gateway_documents.sql"];
  const legacyDocs = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('docs', 'snapshots') LIMIT 1",
  ).first();
  if (!legacyDocs) completed.push("0003_drop_legacy_doc_index.sql");
  const requestsTable = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_document_requests'",
  ).first();
  if (requestsTable) completed.push("0004_requested_doc_id.sql");
  await recordAppliedMigrations(
    db,
    completed.filter(file => files.includes(file)),
    applied,
  );
}

async function recordAppliedMigrations(db, files, applied) {
  for (const file of files) {
    await db.prepare(
      "INSERT OR IGNORE INTO _unidocs_gateway_migrations (name, applied_at) VALUES (?, ?)",
    ).bind(file, Date.now()).run();
    applied.add(file);
  }
}

function assertPortFree(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the leftover workerd/node process occupying it, then retry \`pnpm dev\`.`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
    server.listen(port, host);
  });
}

/**
 * Backend-neutral storage assertions (see `StorageProbe` in the task brief):
 * a global snapshot index lookup and a CAS blob existence check. Miniflare's
 * implementation is exactly the two `getD1Database`/`getR2Bucket` calls the
 * behavior tests used to make directly; `stacks/unidocs-azure/local/runtime.mjs` provides
 * the Postgres/Azurite equivalent behind the same two methods so the test
 * bodies in `tests/integration/shared/behavior-suite.mjs` don't need to know which backend
 * they're running against.
 */
function createStorageProbe(mf, { stackId } = {}) {
  const tenantByHash = new Map();
  return {
    async sessionIdentity(docType, docId, tenantId) {
      const db = await mf.getD1Database("GATEWAY_DB", GATEWAY_WORKER);
      const tenantFilter = tenantId === undefined ? "" : " AND tenant_id = ?";
      const statement = db
        .prepare(
          `SELECT session_id, tenant_id FROM gateway_documents
           WHERE doc_type = ? AND doc_id = ?${tenantFilter}`,
        );
      const directory = await statement
        .bind(...(tenantId === undefined
          ? [docType, docId]
          : [docType, docId, tenantId]))
        .first();
      if (!directory) return null;
      return {
        sessionId: directory.session_id,
        tenantId: directory.tenant_id,
      };
    },
    async snapshotIndex(docType, docId) {
      const directory = await this.sessionIdentity(docType, docId);
      if (!directory) return [];
      const spec = DOC_TYPES[docType];
      const namespace = await mf.getDurableObjectNamespace(spec.editor, spec.worker);
      const id = namespace.idFromName(docSessionObjectName(
        directory.tenantId,
        directory.sessionId,
      ));
      const response = await namespace.get(id).fetch(
        "https://editor.internal/_internal/snapshot-index",
        {
          headers: {
            "X-Tenant-Id": directory.tenantId,
            "X-Session-Id": directory.sessionId,
            "X-UniDocs-Auth-Context": "capability",
            "X-UniDocs-Doc-Operation": "history",
          },
        },
      );
      const body = await response.json();
      if (!response.ok || body.success !== true) return [];
      return body.data.map((row) => {
        tenantByHash.set(row.hash, directory.tenantId);
        return { version: row.version, hash: row.hash };
      });
    },
    async blobExists(hash) {
      const tenantId = tenantByHash.get(hash);
      if (!tenantId) return false;
      // Stack mode stores node content in the MIDDLEWARE bucket under
      // stack-scoped keys.
      const bucket = await mf.getR2Bucket("CAS_R2", SERVICE_WORKER);
      const object = await bucket.get(`stacks/${stackId}/tenants/${tenantId}/nodes-v2/${hash}`);
      return object !== null;
    },
    /**
     * Cloudflare-probe-only: the middleware's CAS_CONTROL_DB handle (binding
     * on the canonical tenant worker). Tests seed registered stacks here.
     */
    async middlewareControlDb() {
      return mf.getD1Database("CAS_CONTROL_DB", SERVICE_WORKER);
    },
    /**
     * Cloudflare-probe-only: retained roots in the MIDDLEWARE tenant store for
     * a (stackId, tenantId) — the canonical stack-scoped cas_nodes table.
     */
    async middlewareRetainedRoots(stackId, tenantId) {
      const db = await mf.getD1Database("CAS_DB", SERVICE_WORKER);
      const rows = await db
        .prepare(
          "SELECT hash, root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND root_ref_count > 0 ORDER BY hash",
        )
        .bind(stackId, tenantId)
        .all();
      return rows.results.map((row) => ({
        hash: row.hash,
        count: Number(row.root_ref_count),
      }));
    },
    /**
     * Cloudflare-probe-only: root-ref request ids recorded in the MIDDLEWARE
     * idempotency table for a (stackId, tenantId).
     */
    async middlewareRootRefRequestIds(stackId, tenantId) {
      const db = await mf.getD1Database("CAS_DB", SERVICE_WORKER);
      const rows = await db
        .prepare(
          "SELECT request_id FROM cas_root_ref_requests WHERE stack_id = ? AND tenant_id = ? ORDER BY applied_at, request_id",
        )
        .bind(stackId, tenantId)
        .all();
      return rows.results.map((row) => row.request_id);
    },
  };
}

/**
 * Start the gateway plus the selected document type workers in one Miniflare
 * runtime. The Gateway receives a static registry containing only the selected
 * document types, so it 404s on the rest.
 */
export async function startLocalRuntime({
  host = "127.0.0.1",
  docTypes = Object.keys(DOC_TYPES),
  ports: portOverrides = {},
  persistPath,
  casFault = false,
  capabilityFixture,
  stackFixture,
  logLevel = LogLevel.WARN,
  casAdminPublicOrigin,
  casMiddlewareOnly = false,
  casMiddleware = false,
  middlewareStacks,
  casOrigin,
} = {}) {
  const resolvedStackFixture = stackFixture ?? await createEphemeralStackFixture();
  const ports = resolvePorts(docTypes, portOverrides);
  if (!casOrigin) {
    ports.admin = portOverrides.admin ?? ADMIN_PORT;
    ports.mockOidc = portOverrides.mockOidc ?? MOCK_OIDC_PORT;
    ports.edge = portOverrides.edge ?? EDGE_PORT;
  }
  if (casMiddlewareOnly) {
    // CAS middleware runs alone: no gateway, no doc type workers — the
    // independent-deployment boundary, mirrored by stacks/unicas/local/dev.mjs.
    delete ports.gateway;
    for (const name of docTypes) delete ports[name];
  }

  await Promise.all(
    Object.values(ports).map((port) => assertPortFree(host, port)),
  );

  const bundleDir = join(ROOT, ".wrangler", "local-bundles", String(ports.gateway ?? "cas-admin"));

  await Promise.all(
    bundleTargets(docTypes, { casMiddlewareOnly, casMiddleware: casMiddleware || !casOrigin }).map(({ entry, outfile }) =>
      bundleWorker(join(ROOT, entry), join(bundleDir, outfile)),
    ),
  );

  const urls = Object.fromEntries(
    Object.entries(ports).map(([name, port]) => [name, workerUrl(host, port)]),
  );

  // Load per-doc-type secrets from .dev.vars into that worker's bindings.
  // Never log these — they are API keys.
  const extraBindings = {};
  const processDocBindings = Object.fromEntries(
    ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  for (const name of docTypes) {
    const devVars = DOC_TYPES[name].devVars;
    extraBindings[name] = {
      ...(devVars ? await readDevVars(join(ROOT, devVars)) : {}),
      ...processDocBindings,
    };
  }
  const resolvedCapabilityFixture = capabilityFixture ?? await createEphemeralCapabilityFixture();

  let mf;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        host,
        port: ports.gateway,
        log: new Log(logLevel),
        logRequests: logLevel >= LogLevel.INFO,
        ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
        workers: buildWorkers({
          docTypes,
          host,
          ports,
          bundleDir,
          casFault,
          extraBindings,
          capabilityFixture: resolvedCapabilityFixture,
          stackFixture: resolvedStackFixture,
          casAdminPublicOrigin: casAdminPublicOrigin
            ?? process.env.UNIDOCS_CAS_ADMIN_ORIGIN
            ?? `http://localhost:4070`,
          googleOidcClientId: process.env.GOOGLE_OIDC_CLIENT_ID,
          googleOidcClientSecret: process.env.GOOGLE_OIDC_CLIENT_SECRET,
          googleOidcIssuer: process.env.GOOGLE_OIDC_ISSUER,
          casMiddlewareOnly,
          casMiddleware: casMiddleware || !casOrigin,
          casOrigin,
        }),
      }),
    );

    await mf.ready;

    if (!casMiddlewareOnly) {
      await migrateSnapshotsDb(mf);
    }
    if (!casOrigin) {
      const controlDb = await mf.getD1Database("CAS_CONTROL_DB", SERVICE_WORKER);
      if (!middlewareStacks) {
        // Register the local unidocs-cloudflare stack (issuer/keys/refDomains
        // identical to what the gateway signs with). Skipped when the caller
        // provided explicit middlewareStacks (they own the registration).
        const fixtureStacks = [{
          stackId: resolvedStackFixture.stackId,
          issuer: resolvedStackFixture.issuer,
          audience: resolvedStackFixture.audience,
          kid: resolvedStackFixture.kid,
          publicJwk: resolvedStackFixture.jwks.keys[0],
          refDomains: resolvedStackFixture.refDomains,
        }];
        await seedMiddlewareStacks(controlDb, fixtureStacks);
      }
      if (middlewareStacks) {
        await seedMiddlewareStacks(controlDb, middlewareStacks);
      }
    }
    // CAS_CONTROL_DB schema is migrated idempotently by the service adapter
    // before its first admin or MCP dispatch.

    return {
      mf,
      urls,
      docTypes,
      capabilityFixture: resolvedCapabilityFixture,
      stackFixture: resolvedStackFixture,
      storage: createStorageProbe(mf, {
        stackId: resolvedStackFixture.stackId,
      }),
      async dispose() {
        await mf.dispose();
      },
    };
  } catch (err) {
    await mf?.dispose();
    throw err;
  }
}

/**
 * Start the CAS middleware standalone (no gateway / doc type workers) with
 * the given stacks registered in its CAS_CONTROL_DB. Returns the runtime
 * with `urls.edge` as the public service endpoint. Reused by the Cloudflare dev
 * command, integration tests, and the Azure local runtime.
 */
export async function startLocalMiddleware({
  stacks,
  ports: portOverrides = {},
  host = "127.0.0.1",
  logLevel = LogLevel.WARN,
} = {}) {
  return startLocalRuntime({
    host,
    docTypes: [],
    ports: portOverrides,
    logLevel,
    casMiddlewareOnly: true,
    casMiddleware: true,
    middlewareStacks: stacks,
  });
}

async function createEphemeralStackFixture() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const kid = `stack-local-${crypto.randomUUID()}`;
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    stackId: "unidocs-cloudflare",
    issuer: `unidocs-stack:local:${crypto.randomUUID()}`,
    audience: `unidocs-cas-stack:${crypto.randomUUID()}`,
    kid,
    privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: {
      keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }],
    },
    refDomains: [
      { refDomain: "doc", status: "active" },
      { refDomain: "asset", status: "active" },
    ],
  };
}
async function createEphemeralCapabilityFixture() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const kid = `local-${crypto.randomUUID()}`;
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    issuer: `unidocs-gateway:local:${crypto.randomUUID()}`,
    kid,
    privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: {
      keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }],
    },
  };
}

/**
 * Seed the middleware's CAS_CONTROL_DB with the locally registered stacks
 * (issuer + rotation key + refDomains). Callers keep the private keys and
 * issue stack capabilities with service-auth against the same public JWK.
 */
export async function seedMiddlewareStacks(
  db,
  stacks,
) {
  await migrateControlSchema(db);
  for (const stack of stacks) {
    await db.batch([
      db.prepare(
        "INSERT INTO cas_stack_issuer (stack_id, issuer, audience, revision) VALUES (?, ?, ?, 1) ON CONFLICT(stack_id) DO UPDATE SET issuer = excluded.issuer, audience = excluded.audience",
      ).bind(stack.stackId, stack.issuer, stack.audience),
      db.prepare(
        "INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES (?, ?, ?, ?, 'active', 1) ON CONFLICT(stack_id, kid) DO UPDATE SET public_jwk = excluded.public_jwk, state = 'active'",
      ).bind(stack.stackId, stack.kid, stack.algorithm ?? "ES256", JSON.stringify(stack.publicJwk)),
    ]);
  }
}
