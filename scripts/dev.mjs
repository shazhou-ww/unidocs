import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TYPES, parseDocTypes } from "../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { azureDocTypePortBases, readAzureDocTypes } from "../stacks/unidocs-azure/doc-types.mjs";
import { loadRemoteCasConfig, parseDevArgs, writeLocalCredentials } from "./unidocs-dev-config.mjs";
import { DEFAULT_FONT_TENANT, ensurePsdFonts, psdFontFallbacks } from "./psd-font-bootstrap.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const USAGE =
  "Usage: pnpm dev <unidocs-cloudflare|unidocs-azure> [docType ...] [--cas <remote|local>] [--fonts <auto|off>]";

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
try {
  docTypes = parseDocTypes(positional);
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

// 字体预置只对 Miniflare 这一路的 psd 有意义:索引住在 psd worker 的租户级
// `PsdFonts` DO 里,Azure 栈根本没有那个 worker,没选 psd 时也没有。
const psdFontsEnabled = !useAzure
  && devOptions.fontsMode === "auto"
  && docTypes.includes("psd");

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
  azureDocTypes = positional.length === 0 ? Object.keys(azureDocTypeTable) : docTypes;

}

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
  await Promise.all([
    ...allAzurePorts(layout).map((port) => assertPortFree(LOCAL_HOST, port, described[port])),
    assertPortFree(LOCAL_HOST, 5433, AZURE_CONTAINER_PORTS.postgres.hint),
    assertPortFree(LOCAL_HOST, 10000, AZURE_CONTAINER_PORTS.azurite.hint),
  ]);

  const {
    startAzureRuntime,
    GATEWAY_DATABASE_URL,
    docDatabaseUrl,
    BLOB_CONNECTION_STRING,
  } = await import(
    "../stacks/unidocs-azure/local/runtime.mjs"
  );

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
    persistPath: join(root, ".wrangler", "miniflare"),
    logLevel: LogLevel.INFO,
    // 回退链的默认值必须**在 Miniflare 起来之前**就定下来 —— 它是 worker 的
    // 一个绑定,而下面那次预置是运行时起来之后才跑的。只灌索引不配这个变量
    // 的话回退链是空的:中文一个字都画不出来,而且不报错。
    ...(psdFontsEnabled ? { bindingDefaults: { psd: { PSD_FONT_FALLBACKS: psdFontFallbacks() } } } : {}),
    ...(devLogFile ? { logFile: devLogFile } : {}),
    ...(remoteCas ? {
      casOrigin: remoteCas.origin,
      stackFixture: remoteCas.stackFixture,
    } : {}),
  });
  backend = { name: "Miniflare" };
  // 本地运行时的两把签名密钥是每次启动现生成的,只落在这个进程的内存里。
  // 绕过 gateway 直连 worker 的本地工具(scripts/seed-psd-fonts.mjs)签不出
  // 凭据,除非把它们写出来一份。见 writeLocalCredentials 的注释。
  backend.credentialsPath = await writeLocalCredentials({
    root,
    runtime,
    ...(remoteCas ? { casOrigin: remoteCas.origin } : {}),
  });
  // 挂在这里而不是更早:预置绕过 gateway 直连 worker 和 CAS,签凭据靠的就是
  // 上面这一步写出来的文件。它**从不抛** —— 没网/下载失败/预置失败一律只警告,
  // `pnpm dev` 照常起来(见 psd-font-bootstrap.mjs 的裁定 2)。
  if (psdFontsEnabled) {
    await ensurePsdFonts({
      root,
      credentialsPath: backend.credentialsPath,
      tenantId: process.env.UNIDOCS_PSD_FONT_TENANT || DEFAULT_FONT_TENANT,
    });
  }
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
  console.log(
    `Static registrations: ${docTypes.join(" / ")}`,
  );
  // 从 runtime 上读而不是读上面那个变量:只有 Miniflare 这一路真的开了日志
  // 文件,`runtime.logFile` 是「确实开了」的唯一凭据。
  if (runtime.logFile) {
    console.log(`Log file (JSONL): ${runtime.logFile}`);
    console.log(`  jq 'select(.event == "http_call" and .ok == false)' ${runtime.logFile}`);
  }
  console.log(`Local credentials (0600, direct-to-worker tools): ${backend.credentialsPath}`);
}

// Start each selected doc type's dev frontend (if it declares one), with the
// gateway URL injected so its Vite proxy can forward API calls end-to-end.
// Runs on both backends: the proxy only needs a gateway URL, and `runtime.urls`
// has the same shape either way.
const webChildren = [];
for (const name of docTypes) {
  const web = DOC_TYPES[name].web;
  if (!web) continue;
  const webPort = web.port + (useAzure ? AZURE_WEB_PORT_OFFSET : 0);
  const child = spawn("npx", ["vite", "--host", LOCAL_HOST, "--port", String(webPort), "--strictPort"], {
    cwd: join(root, web.dir),
    stdio: "inherit",
    env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
  });
  child.on("error", (err) => console.error(`[${name} web] failed to start:`, err.message));
  webChildren.push(child);
  console.log(`  ${(name + " web").padEnd(8)} http://127.0.0.1:${webPort}`);
}

// The gateway webui (OAuth client + document list) talks to the gateway over
// the /gw dev proxy, so it needs GATEWAY_URL like the doc-type frontends.
const gatewayWebChild = spawn("npx", ["vite", "--host", LOCAL_HOST, "--port", "5174", "--strictPort"], {
  cwd: join(root, "packages", "web-gateway"),
  stdio: "inherit",
  env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
});
gatewayWebChild.on("error", (err) => console.error("[web-gateway] failed to start:", err.message));
webChildren.push(gatewayWebChild);
console.log(`  ${"web-gateway".padEnd(8)} http://127.0.0.1:5174/ui/`);

// The CAS admin console ships with the Miniflare stack's admin worker; spawn
// its Vite dev server too so `pnpm dev` runs the whole middleware + apps.
if (!useAzure && devOptions.casMode === "local") {
  const adminWeb = spawn("pnpm", ["--filter", "@unicas/admin-webui", "dev:ui", "--", "--host", LOCAL_HOST], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  adminWeb.on("error", (err) => console.error("[cas-admin web] failed to start:", err.message));
  webChildren.push(adminWeb);
  console.log(`  ${"cas-admin web".padEnd(8)} http://127.0.0.1:4070`);
}

console.log("Ctrl+C to stop.");

const shutdown = async () => {
  for (const child of webChildren) child.kill("SIGINT");
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
