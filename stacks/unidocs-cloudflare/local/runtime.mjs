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
import { serviceWorkers } from "./services.mjs";
import { openDevLog } from "./dev-log.mjs";
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
    // 内置字体：Workers 没有文件系统，字节必须内联进产物。生产侧对应的是
    // packages/cloudflare-psd/wrangler.toml 的 [[rules]] type = "Data"。
    // 漏了这一项是构建期报错（esbuild 不认识 .ttf 扩展名），不是运行时静默失效。
    loader: { ".ttf": "binary", ".otf": "binary" },
    // Both entries run under `compatibilityFlags: ["nodejs_compat"]` (see
    // doc-types.mjs), so workerd resolves `node:*` specifiers itself at
    // runtime — esbuild only needs to leave them alone rather than trying
    // (and failing, on `platform: "browser"`) to bundle them. The portal
    // needs this for `node:crypto`'s `timingSafeEqual` (auth.ts).
    ...(entry.replaceAll("\\", "/").includes("unicas-packages/service-cloudflare/")
      || entry.replaceAll("\\", "/").includes("packages/cloudflare-portal/")
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

/**
 * 一个 doc type 最终拿到的额外绑定。参数顺序就是优先级：调用方给的默认值垫底,
 * `.dev.vars` 压过它,进程环境变量最高。
 *
 * 单独抽成一个函数只为把这个顺序钉住。顺序反了不会报错 —— 它只会让用户在
 * `.dev.vars` 里亲手写的那一行悄悄不生效,而 `.dev.vars.example` 正是那些变量
 * 的文档位置,那里写了就该赢。(第一个撞上这条的是 `PSD_FONT_FALLBACKS`;
 * 内置字体随包发行之后 `scripts/dev.mjs` 不再给它传默认值了 —— 默认值住在
 * `@unidocs/fonts-builtin` 的 `BUILTIN_FALLBACKS` 里 —— 但这条顺序对下一个
 * 用 `bindingDefaults` 的变量照样成立。)
 */
export function mergeDocBindings({ defaults = {}, devVars = {}, processEnv = {} } = {}) {
  return { ...defaults, ...devVars, ...processEnv };
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

/**
 * Apply a service's committed D1 migrations. Same ledger shape as
 * `migrateSnapshotsDb`, minus its bootstrap-inference branch: the gateway has
 * local databases that predate its ledger and must have their generation
 * inferred, while a service database here has no such history — a fresh one
 * simply applies every file.
 */
async function migrateServiceDb(mf, component, root) {
  const db = await mf.getD1Database(component.d1Binding, component.worker);
  const directory = join(root, component.migrations);
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS _unidocs_service_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);
  const appliedResult = await db.prepare("SELECT name FROM _unidocs_service_migrations ORDER BY name").all();
  const applied = new Set((appliedResult.results ?? []).map(row => row.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(directory, file), "utf8");
    await db.exec(sql);
    await db.prepare(
      "INSERT INTO _unidocs_service_migrations (name, applied_at) VALUES (?, ?)",
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
 * Miniflare 自己那条日志通道的分流器。
 *
 * Worker 的 `console.*` 走的是 workerd 的 stdout/stderr,由
 * `handleStructuredLogs` 接;而 Miniflare 运行时自己的行(`[mf:inf]` 请求行、
 * 启动就绪、内部告警)走 `Log` 实例。两条通道互不相通,所以要落盘就得两边
 * 都接一下。
 *
 * 覆盖的是 `log()` 而不是 `logWithLevel()`:后者会调前者,两个都覆盖就会把
 * 每条日志写两遍。`log()` 是所有级别的唯一出口(error/warn/info/debug/verbose
 * 全部经由 `logWithLevel` 落到它),接住这一个方法就等于接住了整条通道。
 */
class TeeLog extends Log {
  #devLog;

  constructor(level, devLog) {
    super(level);
    this.#devLog = devLog;
  }

  log(message) {
    this.#devLog.write({ src: "miniflare", message });
    super.log(message);
  }
}

/**
 * 复刻 Miniflare 对 workerd 结构化日志的默认打印行为(error/warn 走 stderr
 * 并标红,其余走 stdout)。
 *
 * 一旦我们提供了自己的 `handleStructuredLogs`,Miniflare 的默认实现就整个
 * 不再执行——终端输出全归我们负责。这个函数存在的唯一目的就是让"开了日志
 * 文件"和"没开"在终端里看起来完全一样。
 *
 * 颜色按 `NO_COLOR` 和 stderr 是否 TTY 决定,而不是无条件加转义序列:输出被
 * 重定向到文件或管道时,裸转义序列只会变成一堆垃圾字符。
 */
function printStructuredLog({ level, message }) {
  if (level !== "error" && level !== "warn") {
    console.log(message);
    return;
  }
  const colour = process.env.NO_COLOR === undefined && process.stderr.isTTY === true;
  console.error(colour ? `\u001b[31m${message}\u001b[39m` : message);
}

/**
 * Start the gateway plus the selected document type workers in one Miniflare
 * runtime. The Gateway receives a static registry containing only the selected
 * document types, so it 404s on the rest.
 */
export async function startLocalRuntime({
  host = "127.0.0.1",
  docTypes = Object.keys(DOC_TYPES),
  services = [],
  ports: portOverrides = {},
  persistPath,
  casFault = false,
  capabilityFixture,
  stackFixture,
  logLevel = LogLevel.WARN,
  // 落盘的 JSONL 日志路径,见 dev-log.mjs。**默认关闭**:集成测试也走这个
  // 函数,不该因为跑了个测试就在仓库根上留下一个文件。只有 `pnpm dev`
  // (scripts/dev.mjs)会显式传它。
  logFile,
  casAdminPublicOrigin,
  casMiddlewareOnly = false,
  casMiddleware = false,
  middlewareStacks,
  casOrigin,
  gatewayOAuth,
  // 按 doc type 给的绑定默认值(`{ psd: { PSD_FONT_FALLBACKS: "…" } }`)。
  // 排在 .dev.vars 前面合并,所以它只是"没人显式配时的兜底"—— 那些变量的
  // 文档位置是 .dev.vars.example,那里写了就该赢。
  // **默认空**:集成测试也走这个函数,不该凭空多出一条谁也没要求过的绑定。
  // `pnpm dev` 现在一个都不传(回退链的默认值随内置字体走,见 scripts/dev.mjs);
  // 眼下唯一的调用方是想钉死某条回退链的集成测试。
  bindingDefaults = {},
  bundleEntryOverrides = {},
} = {}) {
  validateGatewayOAuthFixture(gatewayOAuth);
  const resolvedStackFixture = stackFixture
    ?? await createEphemeralStackFixture(gatewayOAuth?.issuer);
  if (gatewayOAuth && gatewayOAuth.issuer !== resolvedStackFixture.issuer) {
    throw new Error("gatewayOAuth.issuer must exactly equal stackFixture.issuer");
  }
  const ports = resolvePorts(docTypes, portOverrides, services);
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
    bundleTargets(docTypes, { casMiddlewareOnly, casMiddleware: casMiddleware || !casOrigin, services }).map(({ entry, outfile }) =>
      bundleWorker(join(ROOT, bundleEntryOverrides[entry] ?? entry), join(bundleDir, outfile)),
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
    extraBindings[name] = mergeDocBindings({
      defaults: bindingDefaults[name],
      devVars: devVars ? await readDevVars(join(ROOT, devVars)) : {},
      processEnv: processDocBindings,
    });
  }
  const resolvedCapabilityFixture = capabilityFixture ?? await createEphemeralCapabilityFixture();

  const devLog = logFile ? openDevLog(logFile) : null;

  let mf;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        host,
        port: ports.gateway,
        log: devLog ? new TeeLog(logLevel, devLog) : new Log(logLevel),
        logRequests: logLevel >= LogLevel.INFO,
        // 只在开了日志文件时接管;不接管时 Miniflare 用它自己的默认打印,
        // 一行代码都不受影响。
        ...(devLog
          ? {
            handleStructuredLogs: (entry) => {
              devLog.write({ src: "worker", level: entry.level, message: entry.message, timestamp: entry.timestamp });
              printStructuredLog(entry);
            },
          }
          : {}),
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
          gatewayOAuth,
          services,
        }),
      }),
    );

    await mf.ready;

    if (!casMiddlewareOnly) {
      await migrateSnapshotsDb(mf);
      if (gatewayOAuth) {
        const gatewayDb = await mf.getD1Database("GATEWAY_DB", GATEWAY_WORKER);
        await seedGatewayOAuthMemberships(gatewayDb, gatewayOAuth);
      }
    }
    for (const component of serviceWorkers(services)) {
      if (component.migrations) await migrateServiceDb(mf, component, ROOT);
    }
    if (!casOrigin) {
      const controlDb = await mf.getD1Database("CAS_CONTROL_DB", SERVICE_WORKER);
      if (!middlewareStacks) {
        // Register the local unidocs-cloudflare stack as a locally-activated
        // OAuth issuer (JWKS identical to what the gateway signs with).
        // Skipped when the caller provided explicit middlewareStacks (they own
        // the registration).
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
      ...(devLog ? { logFile: devLog.path } : {}),
      async dispose() {
        await mf.dispose();
        // 关在 dispose 之后:Miniflare 拆运行时的过程本身还会打日志,提前
        // 关掉就会把关停阶段的行(包括拆的时候抛的错)丢在文件外面。
        devLog?.close();
      },
    };
  } catch (err) {
    await mf?.dispose();
    devLog?.close();
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

async function createEphemeralStackFixture(issuer) {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const kid = `stack-local-${crypto.randomUUID()}`;
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    stackId: "unidocs-cloudflare",
    issuer: issuer ?? `unidocs-stack:local:${crypto.randomUUID()}`,
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

function validateGatewayOAuthFixture(fixture) {
  if (fixture === undefined) return;
  if (!fixture || typeof fixture !== "object") throw new TypeError("gatewayOAuth must be an object");
  const issuer = new URL(fixture.issuer);
  if (issuer.protocol !== "https:" || issuer.search || issuer.hash) {
    throw new TypeError("gatewayOAuth.issuer must be an HTTPS URL without query or fragment");
  }
  if (typeof fixture.principalId !== "string" || !fixture.principalId.trim()) {
    throw new TypeError("gatewayOAuth.principalId is required");
  }
  if (!Array.isArray(fixture.memberships) || fixture.memberships.length === 0) {
    throw new TypeError("gatewayOAuth.memberships must not be empty");
  }
}

async function seedGatewayOAuthMemberships(db, fixture) {
  const now = Math.floor(Date.now() / 1000);
  for (const membership of fixture.memberships) {
    if (typeof membership.tenantId !== "string" || !membership.tenantId
      || !Array.isArray(membership.scopes) || membership.scopes.length === 0
      || !membership.scopes.every(scope => ["cas:read", "cas:write", "cas:manage"].includes(scope))) {
      throw new TypeError("gatewayOAuth memberships require a tenantId and canonical CAS scopes");
    }
    await db.prepare(
      `INSERT INTO gateway_oauth_tenant_memberships
       (principal_id, tenant_id, scopes_json, ref_domain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal_id, tenant_id) DO UPDATE SET
         scopes_json = excluded.scopes_json,
         ref_domain = excluded.ref_domain,
         updated_at = excluded.updated_at`,
    ).bind(
      fixture.principalId,
      membership.tenantId,
      JSON.stringify(membership.scopes),
      membership.refDomain ?? null,
      now,
      now,
    ).run();
  }
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
 * Seed the middleware's CAS_CONTROL_DB with the locally registered stacks as
 * locally-activated Stack OAuth issuers. The local gateway signs stack
 * capabilities with the key exposed by each seeded jwks_uri, so the data
 * plane follows the same remote JWKS path as a discovered issuer.
 */
export async function seedMiddlewareStacks(
  db,
  stacks,
) {
  await migrateControlSchema(db);
  const now = Date.now();
  for (const stack of stacks) {
    const jwksUri = stack.jwksUri ?? `data:application/json,${encodeURIComponent(JSON.stringify({
      keys: [{
        ...stack.publicJwk,
        kid: stack.kid,
        alg: stack.algorithm ?? "ES256",
        use: "sig",
      }],
    }))}`;
    await db.batch([
      db.prepare(
        `INSERT INTO cas_stack_oauth_issuers
           (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint,
            jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported,
            status, verified_at, last_refresh_at, last_refresh_error, jwks_digest,
            capability_max_lifetime_seconds, revision)
         VALUES (?, ?, ?, '', 'oauth', '', '', ?, NULL, '[]', '[]', 'active', ?, ?, NULL, 'local-seed', 28800, 1)
         ON CONFLICT(stack_id) DO UPDATE SET
           issuer = excluded.issuer, audience = excluded.audience, status = 'active',
           verified_at = excluded.verified_at, last_refresh_at = excluded.last_refresh_at,
           jwks_uri = excluded.jwks_uri, jwks_digest = excluded.jwks_digest`,
      ).bind(stack.stackId, stack.issuer, stack.audience, jwksUri, now, now),
    ]);
  }
}
