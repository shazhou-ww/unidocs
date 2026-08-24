import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
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
  registryEntries,
  resolvePorts,
} from "./doc-types.mjs";
import { resolveWorkspaceAliases } from "./workspace-aliases.mjs";

export { DOC_TYPES, INTERNAL_TOKEN, parseDocTypes } from "./doc-types.mjs";

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

const MIGRATIONS_PATH = join(
  ROOT,
  "packages",
  "cloudflare-gateway",
  "migrations",
  "0001_init.sql",
);

/**
 * Apply the shared SNAPSHOTS_DB schema (owned by cloudflare-gateway). Real
 * Cloudflare D1 (via wrangler) gets this from `migrations_dir` in
 * wrangler.toml; local Miniflare has no migrations runner, so we read the
 * file and exec each statement ourselves. The gateway and every doc-type
 * worker bind the same underlying D1 database under the "SNAPSHOTS_DB"
 * name, so applying it once — against any one worker's binding — is enough
 * for all of them.
 */
async function migrateSnapshotsDb(mf) {
  const db = await mf.getD1Database("SNAPSHOTS_DB", GATEWAY_WORKER);
  const sql = await readFile(MIGRATIONS_PATH, "utf8");
  const statements = sql
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
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
 * behavior tests used to make directly; `scripts/azure-runtime.mjs` provides
 * the Postgres/Azurite equivalent behind the same two methods so the test
 * bodies in `tests/integration/shared/behavior-suite.mjs` don't need to know which backend
 * they're running against.
 */
function createStorageProbe(mf) {
  return {
    async snapshotIndex(docType, docId) {
      const worker = DOC_TYPES[docType].worker;
      const db = await mf.getD1Database("SNAPSHOTS_DB", worker);
      const rows = await db
        .prepare(
          "SELECT version, hash FROM snapshots WHERE doc_type = ? AND doc_id = ? ORDER BY version ASC",
        )
        .bind(docType, docId)
        .all();
      return rows.results.map((row) => ({ version: row.version, hash: row.hash }));
    },
    async blobExists(hash) {
      // CAS_WORKER is always started regardless of which doc types were
      // selected, and it's the one that binds the shared bucket as "CAS_R2".
      const bucket = await mf.getR2Bucket("CAS_R2", CAS_WORKER);
      const object = await bucket.get(hash);
      return object !== null;
    },
  };
}

/**
 * Start the gateway plus the selected document type workers in one Miniflare
 * runtime. Shared D1/R2; the KV registry is seeded only with the doc types
 * that are actually running, so the gateway 404s on the rest.
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

  let mf;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        host,
        port: ports.gateway,
        log: new Log(logLevel),
        logRequests: logLevel >= LogLevel.INFO,
        ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
        workers: buildWorkers({ docTypes, host, ports, bundleDir, casFault }),
      }),
    );

    await mf.ready;

    await migrateSnapshotsDb(mf);

    const registry = await mf.getKVNamespace("REGISTRY", "unidocs-gateway");
    for (const [key, value] of registryEntries(docTypes, urls)) {
      await registry.put(key, value);
    }

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
