import { createServer } from "node:net";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
} from "miniflare";
import {
  buildWorkers,
  bundleTargets,
  CAS_PORT,
  CAS_WORKER,
  DOC_TYPES,
  GATEWAY_WORKER,
  resolvePorts,
} from "./doc-types.mjs";
import { resolveWorkspaceAliases } from "./workspace-aliases.mjs";

export { CAS_ACCESS_KEY, DOC_TYPES, parseDocTypes } from "./doc-types.mjs";

export const DEFAULT_PORTS = resolvePorts(Object.keys(DOC_TYPES));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
 * files in filename order and exec each statement ourselves. The gateway and every doc-type
 * worker uses the `GATEWAY_DB` binding.
 */
async function migrateSnapshotsDb(mf) {
  const db = await mf.getD1Database("GATEWAY_DB", GATEWAY_WORKER);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(file => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
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
 * behavior tests used to make directly; `azure/local/runtime.mjs` provides
 * the Postgres/Azurite equivalent behind the same two methods so the test
 * bodies in `tests/integration/shared/behavior-suite.mjs` don't need to know which backend
 * they're running against.
 */
function createStorageProbe(mf) {
  const tenantByHash = new Map();
  return {
    async snapshotIndex(docType, docId) {
      const db = await mf.getD1Database("GATEWAY_DB", GATEWAY_WORKER);
      const directory = await db
        .prepare(
          `SELECT session_id, tenant_id FROM gateway_documents
           WHERE doc_type = ? AND doc_id = ?`,
        )
        .bind(docType, docId)
        .first();
      if (!directory) return [];
      const spec = DOC_TYPES[docType];
      const namespace = await mf.getDurableObjectNamespace(spec.editor, spec.worker);
      const id = namespace.idFromName(directory.session_id);
      const response = await namespace.get(id).fetch(
        "https://editor.internal/_internal/snapshot-index",
        {
          headers: {
            "X-Tenant-Id": directory.tenant_id,
            "X-Session-Id": directory.session_id,
          },
        },
      );
      const body = await response.json();
      if (!response.ok || body.success !== true) return [];
      return body.data.map((row) => {
        tenantByHash.set(row.hash, directory.tenant_id);
        return { version: row.version, hash: row.hash };
      });
    },
    async blobExists(hash) {
      // CAS_WORKER is always started regardless of which doc types were
      // selected, and it's the one that binds the shared bucket as "CAS_R2".
      const bucket = await mf.getR2Bucket("CAS_R2", CAS_WORKER);
      const tenantId = tenantByHash.get(hash);
      if (!tenantId) return false;
      const object = await bucket.get(`tenants/${tenantId}/nodes/${hash}`);
      return object !== null;
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
  logLevel = LogLevel.WARN,
} = {}) {
  const ports = resolvePorts(docTypes, portOverrides);
  // 过渡形态(阶段 4 删除):CAS worker 的直连端口,供 Azure 栈的
  // CAS_BASE_URL 从进程外访问(见 doc-types.mjs 里 CAS_PORT 的注释)。
  // 并入 ports 后 urls 会自动多出一项 "cas"(urls 是从 ports 映射来的)。
  ports.cas = portOverrides.cas ?? CAS_PORT;

  await Promise.all(
    Object.values(ports).map((port) => assertPortFree(host, port)),
  );

  const bundleDir = join(ROOT, ".wrangler", "local-bundles", String(ports.gateway));

  await Promise.all(
    bundleTargets(docTypes).map(({ entry, outfile }) =>
      bundleWorker(join(ROOT, entry), join(bundleDir, outfile)),
    ),
  );

  const urls = Object.fromEntries(
    Object.entries(ports).map(([name, port]) => [name, workerUrl(host, port)]),
  );

  // Load per-doc-type secrets from .dev.vars into that worker's bindings.
  // Never log these — they are API keys.
  const extraBindings = {};
  for (const name of docTypes) {
    const devVars = DOC_TYPES[name].devVars;
    if (devVars) extraBindings[name] = await readDevVars(join(ROOT, devVars));
  }

  let mf;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        host,
        port: ports.gateway,
        log: new Log(logLevel),
        logRequests: logLevel >= LogLevel.INFO,
        ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
        workers: buildWorkers({ docTypes, host, ports, bundleDir, casFault, extraBindings }),
      }),
    );

    await mf.ready;

    await migrateSnapshotsDb(mf);

    return {
      mf,
      urls,
      docTypes,
      storage: createStorageProbe(mf),
      async dispose() {
        await mf.dispose();
      },
    };
  } catch (err) {
    await mf?.dispose();
    throw err;
  }
}
