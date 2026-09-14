import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TYPES, parseTargets } from "../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { assertServicesAvailable, serviceFrontends, serviceWorkers } from "../stacks/unidocs-cloudflare/local/services.mjs";
import { azureDocTypePortBases, readAzureDocTypes } from "../stacks/unidocs-azure/doc-types.mjs";
import { loadRemoteCasConfig, parseDevArgs, writeLocalCredentials } from "./unidocs-dev-config.mjs";
import { DEFAULT_FONT_TENANT, ensurePsdFonts } from "./psd-font-bootstrap.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const USAGE =
  "Usage: pnpm dev <unidocs-cloudflare|unidocs-azure> [docType|service ...] [--cas <remote|local>] [--fonts <auto|off>]\n" +
  "  document types: markdown, docx, psd    services: portal";

// 两套栈可以同时跑(docx/psd 的 CAS 过渡形态正需要这一点),那时两个 Vite
// 都想要同一个端口。给 Azure 侧加一个固定偏移，与端口段本身的分离
// (Azure 41787 对 Miniflare 8787)同一个思路。偏移只与后端有关、与 doc
// type 无关，所以留在这里，不进 azure.service.json。
const AZURE_WEB_PORT_OFFSET = 1000;

const rawArgs = process.argv.slice(2);
const platform = process.env.UNIDOCS_LOCAL_PLATFORM;
if (platform !== "cloudflare" && platform !== "azure") {
  console.error("UNIDOCS_LOCAL_PLATFORM must be cloudflare or azure. Start this through `pnpm dev <stack>`. ");
  process.exit(1);
}
const useAzure = platform === "azure";
let devOptions;
try {
  devOptions = parseDevArgs(rawArgs);
} catch (error) {
  console.error(error.message);
  console.error(USAGE);
  process.exit(1);
}
const positional = devOptions.docTypes;

let docTypes;
let services;
try {
  ({ docTypes, services } = parseTargets(positional));
  // Runs here and nowhere later: it decides on argv alone, so an unsupported
  // selection (`pnpm dev unidocs-azure portal`) must cost nothing — no Docker
  // probe, no port probe, no heavy import. See the ordering note below.
  assertServicesAvailable(platform, services);
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}

// Everything below is validation that must happen before we pay for
// starting anything (Docker containers, node processes, or — on the
// Miniflare side — the esbuild + Miniflare import graph). Order goes
// cheapest-first: pure argv checks, then a `docker info` probe, then a
// port probe, and only once all of those pass do we import the modules
// that actually pull in heavy dependencies (pg, @azure/storage-blob,
// esbuild, miniflare).

// Populated below when `useAzure` — hoisted out of that block so the port
// check and the `startAzureRuntime()` call further down can both reuse the
// same validated selection instead of recomputing it.
let azureDocTypes;
// Populated below when `useAzure`, same reason as `azureDocTypes` above:
// this is assigned inside one `if (useAzure)` block but read from another,
// further down, so it has to be hoisted out here rather than declared with
// `const` inside either block.
let azureDocTypeTable;
// Set only when docx is part of the Azure selection (see the reachability
// probe below); passed through to `startAzureRuntime()` so the gateway and
// docx services get `CAS_BASE_URL` wired up the same way the e2e test does.
let azureCasBaseUrl;
let remoteCas;

if (devOptions.casMode === "remote") {
  try {
    remoteCas = await loadRemoteCasConfig({ root });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const reachable = await fetch(`${remoteCas.origin}/health`, {
    headers: { Connection: "close" },
  }).then((response) => response.ok, () => false);
  if (!reachable) {
    console.error(`Remote UniCAS is not reachable at ${remoteCas.origin}; use --cas local only when local isolation is intentional.`);
    process.exit(1);
  }
  azureCasBaseUrl = remoteCas.origin;
}

if (useAzure) {
  // 无参数意为「起全部 doc type」。取的必须是 **Azure 自己的**表:
  // `DOC_TYPES` 是 Cloudflare 的(stacks/unidocs-cloudflare/local/doc-types.mjs),
  // 两边的 doc type 集合可以不一样,拿 CF 的表当 Azure 的默认值会在 CF 先
  // 支持某个类型时直接把 `pnpm dev unidocs-azure` 打挂。
  azureDocTypeTable = readAzureDocTypes(root);
  // 判据是**解析后的** `docTypes`,不是原始的 `positional`:后者把 service 也
  // 算进"用户选过东西了",于是一条只点名 service 的命令(将来某个 service 被
  // Azure 支持之后就会出现)会让这里拿到空表,静默地一个 doc type 都不起。
  // `parseTargets([])` 对空参数返回全部 doc type,所以 `docTypes` 为空只可能
  // 是"只点了 service",而那正是该退回"起全部"的那一种。
  azureDocTypes = docTypes.length === 0 ? Object.keys(azureDocTypeTable) : docTypes;

}

// 本次真正要起的 doc type。Azure 侧「无参数 = 起全部」取的是它自己那张表,
// 与 `docTypes`(Cloudflare 的表)可以不一样,所以下面判断「选了 psd 吗」必须
// 用这个,不能用 `docTypes`。
const selectedDocTypes = useAzure ? azureDocTypes : docTypes;

// 字体预置对**两个栈**都做:`/tenants/{t}/fonts` 已经下沉成中立路由,两个栈
// 都挂着它,预置脚本指向哪个 service 就灌哪个(设计裁定 D4)。判据只剩「这次
// 起了 psd 吗」和「没被 --fonts off 关掉吗」。
const psdFontsEnabled = devOptions.fontsMode === "auto" && selectedDocTypes.includes("psd");

/** Matches `docker compose -f packages/azure-sdk/docker-compose.yml up -d` failing for the same reason, but with an actionable message instead of the raw compose error. */
function assertDockerRunning() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error(
      "Azure local stack requires Docker. Please start Docker Desktop, then retry `pnpm dev unidocs-azure`.",
    );
    process.exit(1);
  }
}

// Mirrors `assertPortFree()` in local-runtime.mjs (same probe-by-listening
// technique, same error shape). Duplicated rather than imported because
// local-runtime.mjs doesn't export it and this task is entry-layer wiring
// only — see the report for the follow-up note.
//
// `describeConflict` lets callers give a port-specific hint about *why* the
// port might be taken: for the Node services (41787/41788) it's almost
// always a leftover process from a previous `pnpm dev unidocs-azure`, but for the
// container ports (5433/10000) the far more common cause in practice is a
// completely unrelated project's `docker compose` stack squatting on the
// same host port — that's what actually happened during review of this
// change, on this very machine.
function assertPortFree(host, port, describeConflict) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use${describeConflict ? ` (${describeConflict})` : ""}. Stop the leftover process occupying it, then retry \`pnpm dev unidocs-azure\`.`,
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
    // Always probe 0.0.0.0, regardless of `host` — see
    // `assertPortFree()`'s comment in stacks/unidocs-azure/local/runtime.mjs (around line
    // 308-323) for why a probe bound to a specific address (127.0.0.1)
    // fails to detect a pre-existing wildcard bind on BSD/Darwin.
    server.listen(port, "0.0.0.0");
  });
}

// Kept deliberately apart from Miniflare's 8787/8788 band so both backends
// can run at once. The Node-service ports themselves come from
// `stacks/unidocs-azure/local/ports.mjs`'s layout below, not a local copy — that module has no
// imports at all, so pulling it in here is cheap and keeps this file from
// drifting out of sync with `stacks/unidocs-azure/local/runtime.mjs`'s own port math.
const LOCAL_HOST = process.env.UNIDOCS_LOCAL_HOST ?? "127.0.0.1";

// The host ports `packages/azure-sdk/docker-compose.yml` maps Postgres onto, and the port
// the spawned `azurite-blob` process listens on (see that file and
// `packages/azure-sdk/tests/containers.ts`). CLAUDE.md promises "occupied
// port fails fast" for the local runtime; before this check existed, the
// Azure path only honoured that promise for the two Node services and let
// `docker compose up -d` / the azurite-blob spawn hit these two silently,
// which either wedges on something unrelated already bound to the port or —
// worse — quietly attaches to whatever stack got there first.
const AZURE_CONTAINER_PORTS = {
  postgres: {
    port: 5433,
    hint: "needed by the local Azure stack's Postgres container — likely either a leftover `docker compose` stack from this repo, or an unrelated project's Postgres container bound to the same host port",
  },
  azurite: {
    port: 10000,
    hint: "needed by the local Azure stack's azurite-blob process — likely either a leftover `pnpm dev unidocs-azure` / test run from this repo, or an unrelated process bound to the same host port",
  },
};

// 本次 dev 的 JSONL 日志落到哪。默认开着,因为它存在的理由就是「不用事先
// 想起来加参数,agent 也能直接去查」——要事先记得开的日志等于没有。
//
// 名字必须命中 .gitignore 里的 `.dev-*.log`:那条规则是在一份手动 tee 的
// dev 日志被 `git add -A` 连着提交了两次之后加的(88517ba),而本地日志会
// 带上网关签发的能力票据。落在这个模式外面的文件名等于把那次教训作废。
//
// UNIDOCS_DEV_LOG=off 关掉;给别的值就当路径用(相对仓库根,也接受绝对路径)。
const devLogSetting = process.env.UNIDOCS_DEV_LOG;
const devLogFile = devLogSetting === "off"
  ? null
  : resolve(root, devLogSetting || ".dev-cloudflare.log");

let runtime;
let backend;

if (useAzure) {
  assertDockerRunning();

  // `stacks/unidocs-azure/local/ports.mjs` has no imports at all, so this can go ahead of the
  // heavier imports further down (mirrors `doc-types.mjs`'s same
  // dependency-free convention) — argv validation has already happened
  // above, so this is just cheap port math before the port probe.
  const { azurePortLayout, allAzurePorts, describeAzurePorts } = await import("../stacks/unidocs-azure/local/ports.mjs");
  const layout = azurePortLayout({
    docTypes: azureDocTypes,
    portBases: azureDocTypePortBases(azureDocTypeTable),
    replicas: 2,
  });
  const described = describeAzurePorts(layout);
  // 5433 上如果坐着的是我们自己那个 compose 容器,就别拦——`docker compose
  // up -d` 幂等,下面 startAzureRuntime() 会原地复用它。见 compose-status.mjs:
  // 这条检查防的是"认错人"(连上陌生人的 Postgres 并往上跑 migrations),
  // 不是"重复启动",而 Ctrl-C 之后的稳态恰恰就是我们的容器还在那儿。
  const { composeOwnsPortNow } = await import("../stacks/unidocs-azure/local/compose-status.mjs");
  const postgresIsOurs = composeOwnsPortNow(5433);
  await Promise.all([
    ...allAzurePorts(layout).map((port) => assertPortFree(LOCAL_HOST, port, described[port])),
    ...(postgresIsOurs ? [] : [assertPortFree(LOCAL_HOST, 5433, AZURE_CONTAINER_PORTS.postgres.hint)]),
    assertPortFree(LOCAL_HOST, 10000, AZURE_CONTAINER_PORTS.azurite.hint),
  ]);
  if (postgresIsOurs) {
    console.log("Postgres 5433: reusing the running azure-sdk compose container.");
  }

  const {
    startAzureRuntime,
    GATEWAY_DATABASE_URL,
    docDatabaseUrl,
    BLOB_CONNECTION_STRING,
  } = await import(
    "../stacks/unidocs-azure/local/runtime.mjs"
  );

  // 这里**不再**替 psd 设 `PSD_FONT_FALLBACKS`:默认值住在
  // `@unidocs/fonts-builtin` 的 `BUILTIN_FALLBACKS` 里,由
  // `parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS)` 接线
  // (packages/azure-psd/src/agent-deps.ts)。不设 ≠ 空链。
  //
  // 下面那次本地预置照做,而且**不需要**再传一遍回退链:它灌进租户索引的是
  // 同名的全量版(NotoSans-Regular / NotoSansSC-Regular),而
  // `createFontRegistry` 的 providers 顺序是"内置在前、租户在后、后者按
  // postScriptName 覆盖前者",所以同一条内置默认回退链在本地解析到的就是刚
  // 灌进去的那两套全量字体。在这里再写一份名字只会多一个会分叉的来源。

  runtime = await startAzureRuntime({
    host: LOCAL_HOST,
    docTypes: azureDocTypes,
    replicas: 2,
    ...(azureCasBaseUrl ? { casBaseUrl: azureCasBaseUrl } : {}),
    ...(remoteCas ? { stackFixture: remoteCas.stackFixture } : {}),
  });
  backend = {
    name: "Azure (Postgres + Azurite)",
    gatewayDatabaseUrl: GATEWAY_DATABASE_URL,
    docDatabaseUrls: Object.fromEntries(azureDocTypes.map(name => [name, docDatabaseUrl(name)])),
    BLOB_CONNECTION_STRING,
  };
} else {
  // Imported after argv validation so a typo fails fast instead of paying for
  // the esbuild + Miniflare import graph first.
  const { LogLevel } = await import("miniflare");
  const { startLocalRuntime } = await import("../stacks/unidocs-cloudflare/local/runtime.mjs");

  runtime = await startLocalRuntime({
    host: LOCAL_HOST,
    docTypes,
    services,
    persistPath: join(root, ".wrangler", "miniflare"),
    logLevel: LogLevel.INFO,
    // 这里**不再**传 `bindingDefaults` 给 psd 配回退链 —— 理由同 Azure 那一支
    // (见上面那段注释):默认值住在 `BUILTIN_FALLBACKS`,而本地预置灌的是同名
    // 全量版,租户那一档按 postScriptName 盖掉内置那一档。不设 ≠ 空链,所以
    // 也不再需要"绑定必须在 Miniflare 起来之前定下来"这个时序约束。
    ...(devLogFile ? { logFile: devLogFile } : {}),
    ...(remoteCas ? {
      casOrigin: remoteCas.origin,
      stackFixture: remoteCas.stackFixture,
    } : {}),
  });
  backend = { name: "Miniflare" };

  // An empty portal database has no document type, so a tenant can create
  // nothing. The seed registers markdown through the admin API and points the
  // markdown Operator at it; it is idempotent, so it runs on every boot (the
  // Operator's document type is not persisted, only the registration is).
  // Best effort: a failed seed leaves the rest of the stack usable, so it only
  // warns. Skipped without `mf` — the unit test's stub runtime has none.
  if (services.includes("portal") && runtime.mf) {
    try {
      const { seedPortalCatalog } = await import("../stacks/unidocs-cloudflare/local/portal-seed.mjs");
      const { documentType } = await seedPortalCatalog(runtime, { log: (line) => console.log(line) });
      console.log(`Portal catalog: markdown is ${documentType}`);
    } catch (error) {
      console.warn(`⚠ Portal seed failed; tenants cannot create markdown documents until it succeeds (restart to retry).\n  ${error.message}`);
    }
  }
}

// 以下两步**两个栈同一条路径** —— 这正是字体登记表下沉成中立契约换来的东西。

// 本地运行时的两把签名密钥是每次启动现生成的,只落在这个进程的内存里。
// 绕过 gateway 直连 doc service 的本地工具(scripts/seed-psd-fonts.mjs)签不出
// 凭据,除非把它们写出来一份。见 writeLocalCredentials 的注释。
backend.credentialsPath = await writeLocalCredentials({
  root,
  runtime,
  platform,
  ...(remoteCas ? { casOrigin: remoteCas.origin } : {}),
});
// 挂在这里而不是更早:预置绕过 gateway 直连 doc service 和 CAS,签凭据靠的就是
// 上面这一步写出来的文件。它**从不抛** —— 没网/下载失败/预置失败一律只警告,
// `pnpm dev` 照常起来(见 psd-font-bootstrap.mjs 的裁定 2)。
if (psdFontsEnabled) {
  await ensurePsdFonts({
    root,
    credentialsPath: backend.credentialsPath,
    tenantId: process.env.UNIDOCS_PSD_FONT_TENANT || DEFAULT_FONT_TENANT,
  });
}

console.log(`UniDocs local runtime (${backend.name})`);
for (const [name, url] of Object.entries(runtime.urls)) {
  if (Array.isArray(url)) {
    // e.g. `markdownReplicas` — print each replica's own address so
    // "there are really two of these running" is visible in the terminal,
    // not just implied by a single proxy URL.
    url.forEach((replicaUrl, i) => {
      console.log(`  ${`${name} #${i + 1}`.padEnd(20)} ${replicaUrl}`);
    });
    continue;
  }
  console.log(`  ${name.padEnd(8)} ${url}`);
}

if (useAzure) {
  console.log(`  gateway db psql "${backend.gatewayDatabaseUrl}"`);
  for (const [name, url] of Object.entries(backend.docDatabaseUrls)) {
    console.log(`  ${name} db psql "${url}"`);
  }
  console.log(`  azurite  http://127.0.0.1:10000  (connection string: ${backend.BLOB_CONNECTION_STRING})`);
} else {
  // 同 `Services:` 一样的理由,对称处理:`pnpm dev portal` 一个 doc type 都
  // 没选,空列表("Static registrations: ")看起来正是「起了但没起来」。
  if (docTypes.length > 0) {
    console.log(
      `Static registrations: ${docTypes.join(" / ")}`,
    );
  }
  // 单独一行而不是并进上面那行:那行说的是"网关注册表里有哪些 doc type",
  // service 不在那张表里(它们不是 doc type,也不参与 docType 路由)。
  // 一个 service 都没选时整行不打,免得空列表看起来像"起了但没起来"。
  if (services.length > 0) {
    console.log(`Services: ${services.join(" / ")}`);
    // The WebUIs a service worker serves itself, under a base path. Printed
    // because the bare origin already on the URL list is a 404 for both — the
    // port alone does not tell you where to go.
    for (const component of serviceWorkers(services)) {
      for (const { label, path } of component.consoles ?? []) {
        console.log(`  ${(label + " console").padEnd(14)} ${runtime.urls[component.name]}${path}`);
      }
      // An unset bootstrap email is not a default — it is "nobody may sign
      // in": the worker turns "" into null and `requireBootstrapIdentity`
      // refuses every identity against a null. Said here because the only
      // other place it is said is the console telling you, after a complete
      // round trip through Google, that you have no permission — which reads
      // like an account problem rather than a missing local setting.
      //
      // Read off the running worker rather than recomputed, so it reports the
      // value that is actually bound however it got there (placeholder file,
      // `.dev.vars`, or the environment).
      // `mf` is the Miniflare instance — absent on the Azure path and under
      // the test stub. The warning is a convenience, so it is skipped rather
      // than reconstructed from the sources it would have to re-merge.
      if (!component.devVars || typeof runtime.mf?.getBindings !== "function") continue;
      const bindings = await runtime.mf.getBindings(component.worker);
      // The portal seed binds its own administrator and invites this address,
      // so an unset value no longer means "no administrator": it means no
      // human can sign in to the admin console. The tenant console needs no
      // sign-in, which the old wording, printed under it, left unclear.
      if (Object.hasOwn(bindings, "PORTAL_BOOTSTRAP_EMAIL") && !bindings.PORTAL_BOOTSTRAP_EMAIL) {
        console.log(`  ${"".padEnd(14)} ⚠ PORTAL_BOOTSTRAP_EMAIL is not set — nobody can sign in to the admin console (the tenant console needs no sign-in).`);
        console.log(`  ${"".padEnd(14)}   Set it in ${component.devVars} and restart; the portal seed invites that address.`);
      }
    }
  }
  // 从 runtime 上读而不是读上面那个变量:只有 Miniflare 这一路真的开了日志
  // 文件,`runtime.logFile` 是「确实开了」的唯一凭据。
  if (runtime.logFile) {
    console.log(`Log file (JSONL): ${runtime.logFile}`);
    console.log(`  jq 'select(.event == "http_call" and .ok == false)' ${runtime.logFile}`);
  }
}
// 两个栈各写各的一份,路径不同(见 LOCAL_CREDENTIALS_PATHS)——手工跑
// `seed-psd-fonts.mjs` 时要 `--credentials` 指的就是这里打出来的这一个。
console.log(`Local credentials (0600, direct-to-service tools): ${backend.credentialsPath}`);

// Start each selected doc type's dev frontend (if it declares one), with the
// gateway URL injected so its Vite proxy can forward API calls end-to-end.
// Runs on both backends: the proxy only needs a gateway URL, and `runtime.urls`
// has the same shape either way.
const webChildren = [];

// Every frontend runs behind a wrapper (`npx vite`, `pnpm --filter … dev:ui`),
// and signalling only the wrapper used to leave the real Vite server running
// on its port — the next `pnpm dev` then died on "Port 5174 is already in use".
// So on POSIX each frontend gets its own process group, and shutdown signals
// the whole group. Windows has no process groups; there `child.kill` is all
// there is.
const ownProcessGroups = process.platform !== "win32";

/** Spawns one frontend dev server and registers it for shutdown. */
function spawnFrontend(command, args, options) {
  // pnpm exports its own settings as npm_config_* to everything it runs, and
  // `npx` then warns "Unknown env config manage-package-manager-versions" on
  // every start. The setting means nothing to Vite, so it is not passed on.
  const env = { ...(options.env ?? process.env) };
  delete env.npm_config_manage_package_manager_versions;
  const child = spawn(command, args, { ...options, env, detached: ownProcessGroups });
  webChildren.push(child);
  return child;
}

/** Signals every frontend, wrapper and server alike. Never throws: it also runs
 *  from the `exit` handler, where an already-gone group is the normal case. */
function stopFrontends(signal) {
  for (const child of webChildren) {
    try {
      if (ownProcessGroups && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

/** One Vite dev server, with the gateway URL its proxy needs. Shared by the
 *  doc-type loop and the service loop below so a service frontend is started
 *  on exactly the same terms as a doc-type one — including GATEWAY_URL. */
function startWebFrontend(label, web, webPort) {
  const child = spawnFrontend("npx", ["vite", "--host", LOCAL_HOST, "--port", String(webPort), "--strictPort"], {
    cwd: join(root, web.dir),
    stdio: "inherit",
    env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
  });
  child.on("error", (err) => console.error(`[${label} web] failed to start:`, err.message));
  console.log(`  ${(label + " web").padEnd(8)} http://127.0.0.1:${webPort}`);
}

for (const name of docTypes) {
  const web = DOC_TYPES[name].web;
  if (!web) continue;
  startWebFrontend(name, web, web.port + (useAzure ? AZURE_WEB_PORT_OFFSET : 0));
}

// Service frontends (admin-portal-webui / tenant-portal-webui). Empty today —
// the loop exists so those packages need no wiring beyond a row in
// `SERVICE_TARGETS`. No Azure offset: services are Cloudflare-only, and
// `assertServicesAvailable` has already refused the Azure combination above.
for (const component of serviceFrontends(services)) {
  startWebFrontend(component.name, component.web, component.web.port);
}

// The gateway webui (OAuth client + document list) talks to the gateway over
// the /gw dev proxy, so it needs GATEWAY_URL like the doc-type frontends.
const gatewayWebChild = spawnFrontend("npx", ["vite", "--host", LOCAL_HOST, "--port", "5174", "--strictPort"], {
  cwd: join(root, "packages", "web-gateway"),
  stdio: "inherit",
  env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
});
gatewayWebChild.on("error", (err) => console.error("[web-gateway] failed to start:", err.message));
console.log(`  ${"web-gateway".padEnd(8)} http://127.0.0.1:5174/ui/`);

// The CAS admin console ships with the Miniflare stack's admin worker; spawn
// its Vite dev server too so `pnpm dev` runs the whole middleware + apps.
if (!useAzure && devOptions.casMode === "local") {
  const adminWeb = spawnFrontend("pnpm", ["--filter", "@unicas/admin-webui", "dev:ui", "--", "--host", LOCAL_HOST], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  adminWeb.on("error", (err) => console.error("[cas-admin web] failed to start:", err.message));
  console.log(`  ${"cas-admin web".padEnd(8)} http://127.0.0.1:4070`);
}

// A frontend in its own process group no longer hears the terminal's Ctrl+C or
// hang-up, and none of the handlers below run if this process is SIGKILLed. The
// watchdog covers that last case: it outlives us, notices we are gone and stops
// the groups (see scripts/dev-frontend-watchdog.mjs).
const frontendGroups = ownProcessGroups ? webChildren.map(child => child.pid).filter(Boolean) : [];
if (frontendGroups.length > 0) {
  spawn(process.execPath, [join(root, "scripts", "dev-frontend-watchdog.mjs"), String(process.pid), ...frontendGroups.map(String)], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

console.log("Ctrl+C to stop.");

let stopping = false;
const shutdown = async () => {
  // A second Ctrl+C while the runtime is still disposing forces the exit.
  if (stopping) process.exit(1);
  stopping = true;
  stopFrontends("SIGTERM");
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Closing the terminal window: the frontends are outside our process group and
// would not get the hang-up themselves.
process.on("SIGHUP", shutdown);
// Any other way out — an uncaught error, a `process.exit` elsewhere — still
// takes the frontends down. Synchronous by necessity; a repeat signal is harmless.
process.on("exit", () => stopFrontends("SIGTERM"));
