/**
 * Azure 真实云部署的编排脚本。可重复执行:第二次跑不会重置 Postgres
 * 密码(它存在 Key Vault 里,存在则读、不存在则生成),两次 what-if
 * 都应无变更。
 *
 * 四个部署单元,各自独立的 deployment 名(DEPLOYMENT_NAMES):
 *   bootstrap.bicep   ACR / Key Vault / 存储 / 身份 / Log Analytics
 *   platform.bicep    Postgres(含 Gateway 与各 Doc service 的独占数据库)/ ACA 环境 / 三个迁移 Job
 *   service.bicep     单个 doc type 的 Container App(每个服务各自的 deployment 名 service-{docType})
 *   gateway.bicep     网关 Container App
 *
 * 用法(不传任何选择器 = 冷启动全量,顺序 bootstrap -> platform -> services -> gateway):
 *   node stacks/azure/deploy/deploy.mjs \
 *     --cas-base-url https://unidocs-cas.<account>.workers.dev \
 *     --cas-access-key <与 Cloudflare CAS worker 相同的 CAS_ACCESS_KEY>
 *
 * 用法(只部一个 target —— 见 parseArgs()):
 *   node stacks/azure/deploy/deploy.mjs --bootstrap
 *   node stacks/azure/deploy/deploy.mjs --platform
 *   node stacks/azure/deploy/deploy.mjs --service docx
 *   node stacks/azure/deploy/deploy.mjs --service docx,markdown
 *   node stacks/azure/deploy/deploy.mjs --gateway
 *
 * `--cas-base-url` 是可选的:不给时需要跨云 CAS 的 doc type(见
 * `doc-types.mjs` 的 `needsCas`,目前只有 docx)图片路径返回 501,其余功能
 * (含这些 doc type 除图片外的操作)不受影响,见 `packages/azure-gateway/src/main.ts`
 * 与 `packages/azure-sdk/src/doc-type-service.ts` 顶部注释。
 *
 * `--cas-access-key` 只在 Key Vault 里还没有该 secret 时才可能需要:
 * 配了 `--cas-base-url` 时必须显式传(要与 Cloudflare CAS worker 的
 * CAS_ACCESS_KEY 对齐,本脚本绝不会替你生成一个注定对不上的值)。
 * 其余服务密钥(每个 doc type 自己的 access key)由本脚本生成并存进 Key Vault。
 *
 * `--build-concurrency`(默认 2):ACR 镜像构建的有界并发数,见
 * `buildAndPushImages()` 顶部注释。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAzureDocTypes } from "../doc-types.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const DEFAULTS = {
  subscription: "24c9acbd-c2f5-4ef9-b9a2-486d90208b3e",
  resourceGroup: "Unidocs",
  location: "southeastasia",
};

/** 与 unicas-packages/control-plane/src/validation.ts 的 STACK_ID_PATTERN 一致。 */
const STACK_ID_PATTERN = /^cas_[A-Za-z0-9_-]{8,64}$/;

const PG_ADMIN_PASSWORD_SECRET = "pg-admin-password";
const CAS_ACCESS_KEY_SECRET = "cas-access-key";
const CAPABILITY_PRIVATE_KEY_SECRET = "capability-private-key-pkcs8";
const CAPABILITY_TRUSTED_JWKS_SECRET = "capability-trusted-jwks";
/** Stack 身份密钥：网关持私钥签 CAS 能力票，doc service 只拿公钥 JWKS 验签。 */
const CAS_STACK_PRIVATE_KEY_SECRET = "cas-stack-private-key-pkcs8";
const CAS_STACK_TRUSTED_JWKS_SECRET = "cas-stack-trusted-jwks";

/** Key Vault 里每个 Doc service 的 access key secret 名。 */
const accessKeySecretName = (docType) => `${docType}-access-key`;

/** 迁移轮询:每 5 秒查一次,10 分钟超时。 */
const MIGRATION_POLL_INTERVAL_MS = 5_000;
const MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;

/** 冒烟重试:新 revision 接管流量要几十秒,与注册表 30 秒 TTL 无关——即使
 *  没有注册表,不重试的冒烟在这段窗口里也会失败。总窗口 2 分钟,每 5 秒试一次。 */
const SMOKE_RETRY_TIMEOUT_MS = 120_000;
const SMOKE_RETRY_INTERVAL_MS = 5_000;

/**
 * 单次冒烟尝试的超时。`smoke.mjs` 里的 `fetch()` 没有自己的超时,一旦某次
 * 请求在网络层挂起,`smokeOnce()` 会无限期不返回——`retryUntil()` 的
 * `timeoutMs` 只在两次尝试**之间**检查,单次挂起完全不受它约束,总耗时会
 * 远超名义上限。30 秒留了充足的余量给一次正常但偏慢的冒烟(通常几秒),
 * 同时保证 120 秒的总窗口里至少能挂满 3 次(3 × (30 + 5) = 105s < 120s)
 * 才会被 `retryUntil()` 的总超时截断。
 */
const SMOKE_ATTEMPT_TIMEOUT_MS = 30_000;

/** 镜像构建的默认并发数,可用 `--build-concurrency` 覆盖。见 buildAndPushImages()。 */
const DEFAULT_BUILD_CONCURRENCY = 2;

/**
 * bootstrap.bicep 里这两个资源名是硬编码的字面量 var(不是随机生成、不带
 * 环境后缀),所以本脚本不需要每次都先跑一遍 bootstrap 或查询它的部署输出
 * 才知道 ACR/Key Vault 叫什么——只在本次真的选中了 `bootstrap` target 时才
 * 用 `deployBootstrap()` 的实时 output(顺便当作"这两个资源确实存在"的
 * 验证),否则直接用这份常量。
 */
const BOOTSTRAP_RESOURCE_NAMES = {
  acrName: "unidocsacr",
  keyVaultName: "unidocs-kv",
};

/**
 * 四个 target 用各自独立的 deployment 名。这既让
 * `az deployment operation group list` 能分辨是谁改的,也是并发部署安全的
 * 必要条件——两个 `--service` 进程同时跑时,它们写的是不同的 deployment
 * 记录,不会互相覆盖对方的 `az deployment group create` 记录。
 */
export const DEPLOYMENT_NAMES = {
  bootstrap: "bootstrap",
  platform: "platform",
  gateway: "gateway",
  service: (docType) => `service-${docType}`,
};

/**
 * 镜像清单:网关 + 网关迁移 + 每个 doc type 一个服务镜像 + 共用的 Doc 迁移。
 * doc type 那一段从 `packages/azure-<name>/azure.service.json` 展开,不是一份
 * 手写名单 —— 加一个 doc type 只该改那个包,不该改这里。Gateway 迁移的入口是
 * azure-gateway 自己的 dist/migrate-cli.js(目录 schema),Doc 迁移复用
 * azure-sdk 的 dist/migrate-cli.js(会话 schema)。
 */
export function azureImages(table = readAzureDocTypes(ROOT)) {
  return [
    { service: "azure-gateway", name: "azure-gateway", entry: "dist/main.js" },
    { service: "azure-gateway", name: "azure-gateway-migrate", entry: "dist/migrate-cli.js" },
    ...Object.keys(table).map((docType) => ({
      service: `azure-${docType}`,
      name: `azure-${docType}`,
      entry: "dist/main.js",
    })),
    { service: "azure-sdk", name: "azure-migrate", entry: "dist/migrate-cli.js" },
  ];
}

/**
 * registry 内的仓库路径 + tag。`az acr build --image` 要的就是这个形式
 * (不带 loginServer 前缀 —— 带上会建出名叫 `crxxx.azurecr.io/unidocs/...`
 * 的仓库)。
 */
export function imageRepoTag(name, tag) {
  return `unidocs/${name}:${tag}`;
}

/** 各 target 消费的完整镜像引用。与 `imageRepoTag()` 同源,不各写一份。 */
export function imageRef(loginServer, name, tag) {
  return `${loginServer}/${imageRepoTag(name, tag)}`;
}

/**
 * URL 安全的随机密钥。base64url 而非 base64:这个值会被拼进
 * `postgres://user:password@host/db`,标准字母表的 `/` `+` `=`
 * 都会破坏连接串。
 */
export function generateSecret(byteLength) {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * 与 `packages/azure-sdk/src/pool.ts` 里几个超时环境变量同一套校验风格:
 * 打错的配置必须响亮失败,而不是静默退回默认值——这类配置往往只在真正
 * 用到那天(这里是并发构建炸了排查半天)才会被验证。
 */
function parsePositiveInt(flagName, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * 读一个 `packages/{packageDir}/azure.service.json` 并 `JSON.parse`。不做
 * `docType` 之类的语义校验——那是调用方(`readServiceParams()`/
 * `readGatewayParams()`)的事,取决于是不是走 `--service` 路径。文件不存在
 * 时抛错并点名,不要留到 `az deployment group create` 才报一个不知所云的
 * 错误。
 */
function readAzureServiceJson(packageDir, context) {
  const path = join(ROOT, `packages/${packageDir}/azure.service.json`);
  if (!existsSync(path)) {
    throw new Error(`${context}: no packages/${packageDir}/azure.service.json found.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 读 `packages/azure-{name}/azure.service.json`(设计 §3.4),专给 `--service`
 * 路径用。文件不存在,或者存在但 `docType` 字段与 `name` 对不上——例如误把
 * `packages/azure-gateway/azure.service.json` 当成一个可 `--service` 的
 * doc type(那份 json 没有 `docType` 字段,是给 `--gateway` 自己用的,读它
 * 走 `readGatewayParams()`,不走这个函数)——都在这里响亮失败并点名。这条
 * `docType` 防呆只对 `--service` 路径成立,不要为了让网关也能复用这个函数
 * 而削弱它。
 */
export function readServiceParams(name) {
  const params = readAzureServiceJson(
    `azure-${name}`,
    `--service ${name}`,
  );
  if (params.docType !== name) {
    throw new Error(
      `--service ${name}: packages/azure-${name}/azure.service.json has docType=${JSON.stringify(params.docType)}, ` +
        `expected ${JSON.stringify(name)}. (packages/azure-gateway/azure.service.json has no docType field — ` +
        "it is not a --service target, use --gateway instead.)",
    );
  }
  return params;
}

/**
 * 读 `packages/azure-gateway/azure.service.json`,专给 `deployGateway()` 用。
 * 与 `readServiceParams()` 分开成两个函数,不是共用一个再加 if:那份 json
 * 没有 `docType` 字段(网关不是一个 `--service` 的 doc type,见上面的注释),
 * 硬塞同一条校验只会让 `--gateway` 路径也报出一个说不通的错误。
 */
export function readGatewayParams() {
  return readAzureServiceJson("azure-gateway", "--gateway");
}

export function parseArgs(argv) {
  const args = {
    ...DEFAULTS,
    casBaseUrl: "",
    casAccessKey: "",
    internalAuthMode: "stack",
    capabilityIssuer: "unidocs-gateway:azure-dev",
    capabilityKeyId: "",
    casStackId: "",
    casStackIssuer: "",
    casStackKeyId: "",
    casRefDomain: "doc",
    casCapabilityAudience: "",
    skipBuild: false,
    buildConcurrency: DEFAULT_BUILD_CONCURRENCY,
  };

  let bootstrapFlag = false;
  let platformFlag = false;
  let gatewayFlag = false;
  let serviceNames = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--subscription": args.subscription = argv[++i]; break;
      case "--resource-group": args.resourceGroup = argv[++i]; break;
      case "--location": args.location = argv[++i]; break;
      case "--cas-base-url": args.casBaseUrl = argv[++i]; break;
      case "--cas-access-key": args.casAccessKey = argv[++i]; break;
      case "--internal-auth-mode": args.internalAuthMode = argv[++i]; break;
      case "--capability-issuer": args.capabilityIssuer = argv[++i]; break;
      case "--capability-key-id": args.capabilityKeyId = argv[++i]; break;
      case "--cas-stack-id": args.casStackId = argv[++i]; break;
      case "--cas-stack-issuer": args.casStackIssuer = argv[++i]; break;
      case "--cas-stack-key-id": args.casStackKeyId = argv[++i]; break;
      case "--cas-ref-domain": args.casRefDomain = argv[++i]; break;
      case "--cas-capability-audience": args.casCapabilityAudience = argv[++i]; break;
      case "--skip-build": args.skipBuild = true; break;
      case "--bootstrap": bootstrapFlag = true; break;
      case "--platform": platformFlag = true; break;
      case "--gateway": gatewayFlag = true; break;
      case "--service":
        serviceNames = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--build-concurrency":
        args.buildConcurrency = parsePositiveInt("--build-concurrency", argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }

  // 没给任何选择器 = 冷启动全量,四个 target 按依赖顺序跑一遍(bootstrap ->
  // platform -> services -> gateway,见文件头注释与 main() 里的调用顺序)。
  // 给了任意一个选择器,就只跑被选中的那些——多个选择器可以同时给
  // (例如 `--platform --gateway`),按同样的固定顺序执行,与 argv 里出现
  // 的先后无关。
  const anySelector = bootstrapFlag || platformFlag || gatewayFlag || serviceNames !== null;
  const targets = [];
  if (anySelector) {
    if (bootstrapFlag) targets.push("bootstrap");
    if (platformFlag) targets.push("platform");
    if (serviceNames !== null) targets.push("services");
    if (gatewayFlag) targets.push("gateway");
  } else {
    targets.push("bootstrap", "platform", "services", "gateway");
  }
  if (serviceNames !== null) {
    // 校验放在 parseArgs 里,不是等到真的要部署那个 target 才发现——拼错
    // docType 应该在第一时间响亮失败,见 readServiceParams()。
    for (const name of serviceNames) {
      readServiceParams(name);
    }
    args.services = serviceNames;
  } else {
    args.services = null;
  }

  if (args.internalAuthMode !== "stack") {
    throw new Error("--internal-auth-mode must be stack (legacy/dual/capability retired with the legacy runtime)");
  }
  if (targets.includes("gateway") && !args.capabilityKeyId) {
    throw new Error("--capability-key-id is required for stack deployments (gateway identity kid)");
  }
  // Stack 身份。缺任何一个都不是"降级运行"——网关会在
  // createPkcs8CapabilityIssuer 抛错、doc service 会在 resolveDocAuthConfig
  // 抛错，容器起不来。所以在这里就响亮失败，而不是等 15 分钟部署完看崩溃日志。
  //
  // stackId 与 issuer 两个目标都要：网关用来签票并拼规范路由，doc service
  // 用来验签并拼自己的 CAS 调用路径。keyId 只有网关要——doc service 不签发。
  const needsStackIdentity = targets.includes("gateway") || targets.includes("services");
  if (needsStackIdentity && !args.casStackId) {
    throw new Error("--cas-stack-id is required (opaque control-plane stack id, e.g. cas_XXXXXXXX)");
  }
  if (needsStackIdentity && !args.casStackIssuer) {
    throw new Error("--cas-stack-issuer is required (the issuer registered for that stack)");
  }
  // 刻意没有默认值。bicep 那边 casCapabilityAudience 的默认值 'unidocs-cas'
  // 是个没有 stack 区分度的占位值:一旦与控制面里注册的 audience 不一致,
  // 网关签的票会被 CAS 以 aud 不匹配全量拒绝,而这要等部署完才暴露。
  if (needsStackIdentity && !args.casCapabilityAudience) {
    throw new Error("--cas-capability-audience is required (must equal the audience registered for that stack)");
  }
  if (targets.includes("gateway") && !args.casStackKeyId) {
    throw new Error("--cas-stack-key-id is required for the gateway (active signing key kid for that stack)");
  }
  if (!STACK_ID_PATTERN.test(args.casStackId) && needsStackIdentity) {
    throw new Error(
      `--cas-stack-id must be a control-plane stack id matching ${STACK_ID_PATTERN} `
      + "— names like 'unidocs-azure' are local fixture values and will fail CAS "
      + "authorization with resource_scope_mismatch",
    );
  }
  args.targets = targets;

  return args;
}

/**
 * 输出直接透传给终端(what-if 结果、az acr build 进度、az 登录提示……
 * 都是给人看的),非零退出即抛错并中止整条部署链。
 *
 * 失败时的错误信息绝不拼 `args.join(" ")`:好几个调用点(Key Vault 播种、
 * 各 target 的部署)把密码/token 直接当 `--value`/`--parameters` 的值传给
 * 子进程,若把完整 args 塞进 Error.message,顶层 `catch` 里的
 * `console.error(err.message)` 就会把密钥打进日志。所以这里只用调用方
 * 显式给的、不含密钥的 `label` 描述失败的是哪条命令;不传 label 时退化
 * 成裸的 `cmd`(比 args 安全,但更少信息 —— 逼着每个携带密钥的调用点都
 * 必须显式传 label)。
 */
function run(cmd, args, opts = {}, label = cmd) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`);
  }
  return result;
}

/**
 * `run()` 的异步版本(`spawn` 而不是 `spawnSync`)——服务两个场景,不写第
 * 二套:
 *
 * - `buildAndPushImages()` 的有界并发:`spawnSync` 会整个阻塞 Node 的事件
 *   循环,两个 `spawnSync` 调用不可能真正并发跑;换成 `spawn` + Promise 才
 *   谈得上"有界并发"而不是"看起来并发、实际串行"。这条路径不传
 *   `captureOutput`/`timeoutMs`,行为与原来逐字一致(`stdio:"inherit"`,
 *   不捕获、不超时)。
 * - `smokeOnce()` 的冒烟子进程:`opts.captureOutput: true` 时改走管道
 *   `stdio`,`stdout`/`stderr` 的每个 chunk 一到就立即 `process.stdout
 *   .write()`/`process.stderr.write()` 转发——**边跑边看**,不是等子进程
 *   退出才一次性刷出(`spawnSync` 完全同步阻塞,做不到这件事,这正是把
 *   `smokeOnce()` 从 `spawnSync` 换回 `spawn` 要修的问题)。同一份 chunk
 *   也累积进返回值/错误对象的 `stdout`/`stderr`,供调用方做失败分类。
 *   `opts.timeoutMs` 给单次尝试设上限,超时后 `SIGKILL` 子进程并以
 *   `err.timedOut = true` 拒绝——冒烟单次尝试不该无限期挂起,见
 *   `SMOKE_ATTEMPT_TIMEOUT_MS` 的注释。
 *
 * 同样的 label 安全规则:失败信息只用调用方给的 label,不拼完整 args。
 *
 * 用 `close` 而不是 `exit`:后者在 stdio 管道(以及上面两个 `data`
 * 监听器)真正读完之前就可能先触发,`close` 才保证 `stdout`/`stderr`
 * 缓冲区已经收全。
 */
function spawnAsync(cmd, args, opts = {}, label = cmd) {
  const { timeoutMs, captureOutput = false, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const stdio = captureOutput ? ["ignore", "pipe", "pipe"] : "inherit";
    const child = spawn(cmd, args, { cwd: ROOT, stdio, ...spawnOpts });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    if (captureOutput) {
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
        stderr += chunk;
      });
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    function settle(fn) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    }

    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code, signal) => {
      settle(() => {
        if (timedOut) {
          const err = new Error(
            `${label} timed out after ${timeoutMs}ms and was killed${signal ? ` (signal ${signal})` : ""}`,
          );
          err.timedOut = true;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const err = new Error(`${label} exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
        err.exitCode = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      });
    });
  });
}

/**
 * 与 `run()` 相对:需要把 stdout 读回程序里解析(JSON output、tsv 查询
 * 结果)的命令用这个。stdout 只回传给调用者当变量用,调用者要对含密钥
 * 的返回值自律 —— 绝不 console.log 它。错误信息同样只用 `label`,理由见
 * `run()` 的注释。
 */
function capture(cmd, args, opts = {}, label = cmd) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // az CLI 的 stderr 描述的是部署/资源错误,不是回显调用参数,转发它
    // 是安全的;真正会泄密的是下面这行 Error.message,所以那行只用 label。
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${label} exited with code ${result.status}`);
  }
  return result.stdout.trim();
}

/**
 * 同 `capture()`,但非零退出不抛错、只返回 null —— 专给「先查存在性,
 * 不存在就走另一支」这种场景用(Step 3 的 `az keyvault secret show`)。
 */
function tryCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * 有界并发的 map:同时在飞的 worker 数不超过 `concurrency`。**不是**无界
 * `Promise.all(items.map(worker))`——那样并发数恒等于 `items.length`。
 * ACR Tasks(我们用 Basic SKU)的并发构建数上限未经实测,超限的构建会
 * 排队而不是失败,但不该在没实测过上限之前就一次性把全部构建甩过去。
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const laneCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: laneCount }, lane));
  return results;
}

/**
 * 通用的"重试直到超时"循环,与冒烟(或任何幂等的探测式操作)解耦——
 * `attempt` 只需要是一个可能失败的 async 函数。这条重试本来就该有,
 * 与 Postgres 注册表无关:新 revision 接管流量要几十秒,不重试的冒烟在
 * 这段窗口里必然失败。`wait`/`log` 可注入,方便单测用极小的时钟。
 */
export async function retryUntil(attempt, opts = {}) {
  const { timeoutMs, intervalMs, wait = sleep, log = console.log } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      log(
        `retryUntil: attempt failed (${err.message}); waiting ${intervalMs}ms before retrying ` +
          `(deadline in ${Math.max(0, deadline - Date.now())}ms)...`,
      );
      await wait(intervalMs);
    }
  }
}

/**
 * 执行部署的身份必须能建**角色分配** —— `bootstrap.bicep` 里 UAMI 在 ACR 上
 * 的 `AcrPull` 与在 Storage 上的 `Storage Blob Data Contributor` 是两条
 * `Microsoft.Authorization/roleAssignments/write`。内置 `Contributor` 的
 * `notActions` 恰好含 `Microsoft.Authorization/*\/Write`,所以「有 Contributor
 * 就够」是错的:那样会在 **bootstrap 部署中途**失败,而此时 ACR / Storage /
 * Key Vault / Log Analytics 已经建出来了 —— 部分创建、需手工清理。
 */
const PRIVILEGED_ROLES = ["Owner", "User Access Administrator"];

/**
 * `--include-groups` **不可省**:本仓库当前账号的权限是经组继承的,缺了它
 * 查询返回空,会得出「完全没有任何权限」的错误结论(设计 §11 里那句话就是
 * 这么写错的)。`--include-inherited` 覆盖订阅之上的管理组层级。
 */
function roleNamesAtScope(assignee, scope) {
  const stdout = tryCapture("az", [
    "role", "assignment", "list",
    "--include-groups", "--include-inherited",
    "--assignee", assignee,
    "--scope", scope,
    "--query", "[].roleDefinitionName",
    "-o", "tsv",
  ]);
  if (stdout === null) return null;
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 服务主体登录时 `az ad signed-in-user show` 无结果,退回 `account show`
 * 的 user.name(`--assignee` 同时接受 objectId、SPN 和 UPN)。
 *
 * 这个值本轮多了第二个用途:`bootstrap.bicep` 的 `deployerObjectId` 参数,
 * 建 `Key Vault Secrets Officer` 角色分配时要填的 `principalId` 必须是真正
 * 的 AAD objectId。人类账号(本仓库当前唯一验证过的登录方式,PIM 激活的
 * 订阅级 Owner)走的正是第一个分支,`id` 本身就是 objectId,两个用途完全
 * 吻合。服务主体登录会退到第二个分支,那里的 `user.name` 不保证是
 * objectId(可能是 appId 或显示名)——这条路径此前只服务于
 * `az role assignment list --assignee` 的角色查询,该命令对标识符类型宽松;
 * 用作 `principalId` 会在 bootstrap 部署时报出 Azure 自己的校验错误,不是
 * 静默错误,但这是本轮已知未覆盖的场景(见 checkRbac() 调用点)。
 */
function resolveDeployerAssignee() {
  return (
    tryCapture("az", ["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"]) ||
    capture("az", ["account", "show", "--query", "user.name", "-o", "tsv"])
  );
}

/** 返回 `assignee`(见 `resolveDeployerAssignee()`)—— `preflight()` 把它转交给
 *  `deployBootstrap()` 当 `deployerObjectId`,只取一次,不重复查询。 */
function checkRbac(args) {
  const assignee = resolveDeployerAssignee();

  const scopes = [
    `/subscriptions/${args.subscription}`,
    `/subscriptions/${args.subscription}/resourceGroups/${args.resourceGroup}`,
  ];
  const found = new Set();
  let anyScopeQueried = false;
  for (const scope of scopes) {
    // 资源组尚不存在时这条会失败,返回 null —— 不是「没权限」,跳过即可。
    const roles = roleNamesAtScope(assignee, scope);
    if (roles === null) continue;
    anyScopeQueried = true;
    for (const role of roles) found.add(role);
  }

  if (!anyScopeQueried) {
    throw new Error(
      "preflight: could not read role assignments for the signed-in identity " +
      `(assignee ${assignee}). Cannot prove the deployment will be able to create ` +
      "role assignments; fix `az login` / directory read access and retry.",
    );
  }
  if (!PRIVILEGED_ROLES.some((role) => found.has(role))) {
    throw new Error(
      `preflight: the signed-in identity (${assignee}) has none of ${PRIVILEGED_ROLES.join(" / ")} ` +
      `on /subscriptions/${args.subscription} or resource group ${args.resourceGroup} ` +
      `(roles seen: ${[...found].join(", ") || "none"}).\n` +
      "stacks/azure/deploy/bootstrap.bicep creates two role assignments (UAMI -> AcrPull on ACR, " +
      "UAMI -> Storage Blob Data Contributor on the storage account). Contributor is NOT " +
      "enough: its notActions include Microsoft.Authorization/*/Write, so the bootstrap " +
      "deployment would fail halfway, after ACR / Storage / Key Vault / Log Analytics " +
      "already exist — leaving a partially created resource group to clean up by hand.\n" +
      "Ask for Owner (or User Access Administrator alongside Contributor) at subscription " +
      "or resource-group scope before rerunning.",
    );
  }
  return assignee;
}

/**
 * `stacks/azure/deploy/smoke.mjs`(冒烟)从 `unicas-packages/server-common/dist/index.js` import CAS
 * 哈希算法(仓库既有惯例,`scripts/cas-digest.mjs` 同样如此),而本脚本全程
 * **不在宿主机跑 `pnpm build`** —— 它只构建镜像,那是容器内编译,`.dockerignore`
 * 还排除了 `**\/dist`。干净检出上不自检的话,会一路成功到冒烟那一步,在十几分钟
 * 的镜像构建与真实资源创建之后才以 ERR_MODULE_NOT_FOUND 失败。
 */
function checkHostBuild() {
  const casDist = join(ROOT, "unicas-packages/server-common/dist/index.js");
  if (!existsSync(casDist)) {
    throw new Error(
      `preflight: ${casDist} is missing. stacks/azure/deploy/smoke.mjs imports the CAS ` +
      "hash algorithm from it, and this script never runs `pnpm build` on the host " +
      "(images compile inside the container). Run `pnpm build` first.",
    );
  }
}

/**
 * Step 1:预检 —— 订阅、RBAC、宿主机构建产物、资源提供者注册、资源组。
 * 返回 `deployerObjectId`:`checkRbac()` 里已经查过一次登录者的
 * objectId/assignee,`deployBootstrap()` 要把同一个值喂给
 * `bootstrap.bicep` 的 `deployerObjectId` 参数(见该文件顶部新增的角色
 * 分配),这里原样转交,不重新查询一遍。
 *
 * 这条预检对所有 target 都跑,不按选中的 target 精简——即便只选了
 * `--service docx`,RBAC/宿主机构建产物这些检查仍然便宜且是只读的
 * (`az group create` 对已存在的资源组是幂等 no-op)。
 */
function preflight(args) {
  console.log("[1/7] preflight: subscription + RBAC + host build + Microsoft.App registration + resource group");
  run("az", ["account", "set", "--subscription", args.subscription]);

  // 两条只读自检都排在任何写操作之前:它们要拦住的正是「建到一半才失败」。
  const deployerObjectId = checkRbac(args);
  checkHostBuild();

  const state = capture("az", [
    "provider", "show", "-n", "Microsoft.App", "--query", "registrationState", "-o", "tsv",
  ]);
  if (state !== "Registered") {
    run("az", ["provider", "register", "-n", "Microsoft.App", "--wait"]);
    const recheck = capture("az", [
      "provider", "show", "-n", "Microsoft.App", "--query", "registrationState", "-o", "tsv",
    ]);
    if (recheck !== "Registered") {
      throw new Error(`Microsoft.App registration state is ${recheck}, expected Registered`);
    }
  }

  run("az", ["group", "create", "-n", args.resourceGroup, "-l", args.location, "-o", "none"]);
  return deployerObjectId;
}

/**
 * bootstrap.bicep —— ACR / Key Vault / 存储 / 身份 / Log Analytics /
 * 部署者的 Key Vault Secrets Officer 角色分配(见 `bootstrap.bicep`
 * 顶部注释:RBAC 模式 Key Vault 的数据平面权限不含在订阅级 Owner 里,不建
 * 这条分配,后面第一次写 secret 就会被 Forbidden 拒绝)。
 */
function deployBootstrap(args, deployerObjectId) {
  console.log(`[2/7] bootstrap.bicep: what-if then create (deployment ${DEPLOYMENT_NAMES.bootstrap})`);
  run("az", [
    "deployment", "group", "what-if",
    "-g", args.resourceGroup,
    "-f", "stacks/azure/deploy/bootstrap.bicep",
    "--parameters", `deployerObjectId=${deployerObjectId}`,
  ]);

  const stdout = capture("az", [
    "deployment", "group", "create",
    "-g", args.resourceGroup,
    "-f", "stacks/azure/deploy/bootstrap.bicep",
    "-n", DEPLOYMENT_NAMES.bootstrap,
    "--parameters", `deployerObjectId=${deployerObjectId}`,
    "-o", "json",
  ]);
  const outputs = JSON.parse(stdout).properties.outputs;
  const bootstrap = {
    acrName: outputs.acrName.value,
    acrLoginServer: outputs.acrLoginServer.value,
    keyVaultName: outputs.keyVaultName.value,
    identityClientId: outputs.identityClientId.value,
    blobAccountUrl: outputs.blobAccountUrl.value,
  };
  // 这五个值都不是密钥(ACR/Key Vault 名字、client ID、blob 端点都是公开
  // 元数据),打印出来只是方便人核对这一步部署到了哪些资源。
  console.log(
    `[2/7] bootstrap done: acr=${bootstrap.acrLoginServer} keyVault=${bootstrap.keyVaultName} identityClientId=${bootstrap.identityClientId} blobAccountUrl=${bootstrap.blobAccountUrl}`,
  );
  return bootstrap;
}

/** 传播延迟重试:间隔 10 秒,最多 6 次尝试(首次 + 5 次重试,约 1 分钟)。 */
const KV_FORBIDDEN_RETRY_INTERVAL_MS = 10_000;
const KV_FORBIDDEN_MAX_ATTEMPTS = 6;

export function isKeyVaultForbidden(stderr) {
  return typeof stderr === "string" && /forbidden/i.test(stderr);
}

/**
 * 退避重试的核心循环,与 `spawnSync`/`az` 解耦(`attempt` 只需要返回
 * `{status, stdout, stderr}`)——这样能用单测直接喂假的 attempt/wait/log,
 * 覆盖"首次 Forbidden 后成功""非 Forbidden 立即失败""耗尽重试仍 Forbidden
 * 就中止"这几条分支,不用真的跑 `az`、也不用真的等 10 秒 × 6 次。生产路径
 * (`runKeyVaultSecretOp()`)只是拿真实的 `spawnSync` 调用喂给它。
 *
 * 有限次数、**不是**无限重试,耗尽仍是 Forbidden 就中止,不静默吞掉。非
 * Forbidden 的失败第一次就交给 `onNonForbiddenFailure` 处理,不重试、不
 * 拖慢——那种失败(密钥名打错、vault 不存在)重试也不会自己好。
 *
 * 背景:`bootstrap.bicep` 的 `deployerKvSecretsOfficer` 角色分配刚建出来,
 * 紧接着就要写 secret —— RBAC 模式 Key Vault 的数据平面权限生效有传播延迟,
 * 真实首次部署已经在这里撞过一次 Forbidden(见设计 §11、`cas-optional-report.md`)。
 */
export async function retryOnForbidden(label, attempt, onNonForbiddenFailure, opts = {}) {
  const {
    intervalMs = KV_FORBIDDEN_RETRY_INTERVAL_MS,
    maxAttempts = KV_FORBIDDEN_MAX_ATTEMPTS,
    wait = sleep,
    log = console.log,
  } = opts;
  for (let n = 1; n <= maxAttempts; n++) {
    const result = attempt();
    if (result.status === 0) return result.stdout.trim();
    if (!isKeyVaultForbidden(result.stderr)) {
      return onNonForbiddenFailure(result);
    }
    if (n === maxAttempts) {
      throw new Error(
        `${label}: still getting Forbidden from Key Vault after ${maxAttempts} attempts ` +
        `over ~${(maxAttempts * intervalMs) / 1000}s. This is very likely not a propagation delay ` +
        "any more — confirm the deployer identity actually holds \"Key Vault Secrets Officer\" on " +
        "this vault (bootstrap.bicep's deployerKvSecretsOfficer role assignment), and that its " +
        "principalId matches the identity running this script " +
        "(`az ad signed-in-user show --query id -o tsv`).",
      );
    }
    log(
      `[3/7] ${label}: got Forbidden (attempt ${n}/${maxAttempts}) — likely the Key Vault Secrets ` +
      `Officer role assignment hasn't propagated yet. Waiting ${intervalMs / 1000}s and retrying...`,
    );
    await wait(intervalMs);
  }
}

/**
 * 跑一个 `az keyvault secret ...` 子命令,套 `retryOnForbidden()`。不用
 * `run()`/`capture()`:两者都不把 `stderr` 文本交回调用者,而这里必须检查
 * `stderr` 里有没有 "Forbidden" 才能决定要不要重试。失败时仍然只让调用方
 * 看到不含参数的 `label`(经 `onNonForbiddenFailure`),不落回
 * `args.join(" ")`。
 */
async function runKeyVaultSecretOp(label, args, onNonForbiddenFailure) {
  return retryOnForbidden(
    label,
    () => {
      const result = spawnSync("az", args, { cwd: ROOT, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    },
    onNonForbiddenFailure,
  );
}

/**
 * 播种(或读回)Postgres 管理员密码与 internal token。存在则读、
 * 不存在则生成 —— 这是整条脚本可重复执行的关键:第二次跑绝不能重置
 * Postgres 密码,否则会让已经用旧密码建好的连接串全部失效。
 *
 * 读到的值只放进内存变量,绝不写文件、绝不 console.log —— 见 Step 5 的
 * 审查记录。
 */
async function seedSecret(keyVaultName, secretName, byteLength) {
  const showLabel = `az keyvault secret show --vault-name ${keyVaultName} -n ${secretName}`;
  const existing = await runKeyVaultSecretOp(
    showLabel,
    ["keyvault", "secret", "show", "--vault-name", keyVaultName, "-n", secretName, "--query", "value", "-o", "tsv"],
    // 非 Forbidden 的失败(最常见的就是 SecretNotFound——第一次部署,secret
    // 还不存在)当"不存在"处理,与原先 `tryCapture()` 的行为一致。
    () => null,
  );
  if (existing) {
    return existing;
  }
  const generated = generateSecret(byteLength);
  // label 显式给出,不落回默认的裸 `args.join(" ")`(已经删掉了那条路径)——
  // args 里的 `--value <generated>` 绝不能出现在 Error.message 里。
  const setLabel = `az keyvault secret set --vault-name ${keyVaultName} -n ${secretName}`;
  await runKeyVaultSecretOp(
    setLabel,
    ["keyvault", "secret", "set", "--vault-name", keyVaultName, "-n", secretName, "--value", generated, "-o", "none"],
    (result) => {
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`${setLabel} exited with code ${result.status}`);
    },
  );
  return generated;
}

/**
 * 需要跨云 CAS 才能工作的 doc type 名单(`azure-{docType}` 形式),从表按
 * `needsCas` 算出来 —— 只用于把下面两条报错/提示文案里"谁的图片路径会 401"
 * 说清楚,不参与任何控制流。加一个 `needsCas` 的 doc type 时这两条文案自动
 * 跟着变,不用回头改这个文件。
 */
function casDocTypeNames(table = readAzureDocTypes(ROOT)) {
  return Object.values(table)
    .filter((entry) => entry.needsCas)
    .map((entry) => `azure-${entry.docType}`)
    .join(" / ");
}

/**
 * `CAS_ACCESS_KEY` 与 Postgres 密码性质**不同**,不能一概共用 `seedSecret()`:
 * 它是栈模式迁移前的共享密钥遗留值。栈模式下鉴权走栈作用域 capability,
 * 但 gateway 与 doc 服务的 CasClient 仍携带该值作为兼容绑定。
 * 现场随机生成一个只会让所有跨云 CAS 请求 401 —— 所以这里 fail closed:
 * Key Vault 里没有、`--cas-access-key` 也没给,直接报错,绝不自动生成。
 *
 * (本地栈之所以看不出跨云不对齐的问题:`stacks/cloudflare/local/doc-types.mjs` 硬编码的
 * `CAS_ACCESS_KEY = "unidocs-dev-cas-key"` 被 Miniflare 与本地 Azure 栈共用。)
 */
async function resolveCasAccessKey(keyVaultName, provided) {
  const showLabel = `az keyvault secret show --vault-name ${keyVaultName} -n ${CAS_ACCESS_KEY_SECRET}`;
  const existing = await runKeyVaultSecretOp(
    showLabel,
    ["keyvault", "secret", "show", "--vault-name", keyVaultName, "-n", CAS_ACCESS_KEY_SECRET, "--query", "value", "-o", "tsv"],
    () => null,
  );
  if (existing) {
    // 已有则读用 —— 幂等,且第二次部署不需要再传 --cas-access-key。
    return existing;
  }
  if (!provided) {
    const casDocTypes = casDocTypeNames();
    throw new Error(
      `Key Vault ${keyVaultName} has no "${CAS_ACCESS_KEY_SECRET}" secret and --cas-access-key was not given.\n` +
      "This value is NOT generated by this deployment: it must equal the CAS_ACCESS_KEY used by the " +
      "Cloudflare-side middleware tenant worker (unicas-packages/server-cloudflare). A mismatch makes " +
      "every cross-cloud CAS request fail with 401 — the image path would break in production while " +
      "every local test stays green.\n" +
      "Confirm the Cloudflare-side secret exists with:\n" +
      "  cd unicas-packages/server-cloudflare && npx wrangler secret list\n" +
      "then rerun with --cas-access-key <that value>.",
    );
  }
  // label 显式给出:args 里的 `--value <provided>` 绝不能进 Error.message。
  const setLabel = `az keyvault secret set --vault-name ${keyVaultName} -n ${CAS_ACCESS_KEY_SECRET}`;
  await runKeyVaultSecretOp(
    setLabel,
    ["keyvault", "secret", "set", "--vault-name", keyVaultName, "-n", CAS_ACCESS_KEY_SECRET, "--value", provided, "-o", "none"],
    (result) => {
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`${setLabel} exited with code ${result.status}`);
    },
  );
  return provided;
}

async function requireExistingSecret(keyVaultName, secretName) {
  const showLabel = `az keyvault secret show --vault-name ${keyVaultName} -n ${secretName}`;
  const existing = await runKeyVaultSecretOp(
    showLabel,
    ["keyvault", "secret", "show", "--vault-name", keyVaultName, "-n", secretName, "--query", "value", "-o", "tsv"],
    () => null,
  );
  if (!existing) {
    throw new Error(
      `Key Vault ${keyVaultName} has no required capability secret "${secretName}". ` +
      "Provision it through the platform secret process before deploying; values are not accepted on this command line.",
    );
  }
  return existing;
}

/**
 * 只播种被选中 target 实际需要的密钥:`platform`/`services`/`gateway` 都
 * 要 `pgAdminPassword`(拼进各自的 Postgres 连接串)。`services`/`gateway`
 * 要服务级 access key:`casAccessKey`(必须与 Cloudflare 对齐,见
 * `resolveCasAccessKey()`)、每个 doc type 一个 `SERVICE_ACCESS_KEY`,名字是
 * `{docType}-access-key`,由本脚本生成。`--bootstrap` 单独跑时
 * (main() 根本不调用这个函数)不需要任何一个。
 */
export async function seedSecrets(keyVaultName, args, io = {}) {
  // IO 注入,不是为了"可测"这个抽象目标:这个函数的分支决定了真部署会不会
  // 在 [3/7] 索要一个整条链路根本不读的凭据,而那条分支只有 mock 掉子进程
  // 才测得到。
  const seed = io.seedSecret ?? seedSecret;
  const requireExisting = io.requireExistingSecret ?? requireExistingSecret;
  const resolveCasKey = io.resolveCasAccessKey ?? resolveCasAccessKey;
  console.log("[3/7] seeding/reading secrets from Key Vault (values withheld from logs)");
  const needsPg = args.targets.some((t) => t === "platform" || t === "services" || t === "gateway");
  const needsServiceKeys = args.targets.some((t) => t === "services" || t === "gateway");
  const stackMode = args.internalAuthMode === "stack";
  const pgAdminPassword = needsPg ? await seed(keyVaultName, PG_ADMIN_PASSWORD_SECRET, 48) : null;
  // Legacy 共享密钥随 legacy 运行时一起退役了。stack 模式下网关
  // (azure-gateway/src/main.ts) 与 doc service (azure-sdk/src/doc-type-service.ts)
  // 都显式跳过 CAS_ACCESS_KEY,所以这里也不能再索要它 —— 否则部署会卡在
  // 一个谁都不会读的凭据上。
  const casAccessKey = needsServiceKeys && !stackMode
    ? await resolveCasKey(keyVaultName, args.casAccessKey)
    : null;
  const table = readAzureDocTypes(ROOT);
  const accessKeys = {};
  if (needsServiceKeys) {
    for (const docType of Object.keys(table)) {
      accessKeys[docType] = await seed(keyVaultName, accessKeySecretName(docType), 48);
    }
  }
  const usesCapabilities = args.internalAuthMode !== "legacy";
  const capabilityPrivateKeyPkcs8 = usesCapabilities && args.targets.includes("gateway")
    ? await requireExisting(keyVaultName, CAPABILITY_PRIVATE_KEY_SECRET)
    : null;
  const capabilityTrustedJwks = usesCapabilities && args.targets.includes("services")
    ? await requireExisting(keyVaultName, CAPABILITY_TRUSTED_JWKS_SECRET)
    : null;
  // Stack 身份密钥。非对称地分发：只有网关拿私钥（它是唯一签发方），
  // doc service 拿公钥 JWKS（它只验签）。两者都从 Key Vault 里读既有值，
  // 不由本脚本生成——私钥的另一半在控制面注册时就已经定下了。
  const casStackPrivateKeyPkcs8 = stackMode && args.targets.includes("gateway")
    ? await requireExisting(keyVaultName, CAS_STACK_PRIVATE_KEY_SECRET)
    : null;
  const casStackTrustedJwks = stackMode && args.targets.includes("services")
    ? await requireExisting(keyVaultName, CAS_STACK_TRUSTED_JWKS_SECRET)
    : null;
  return {
    pgAdminPassword,
    casAccessKey,
    accessKeys,
    capabilityPrivateKeyPkcs8,
    capabilityTrustedJwks,
    casStackPrivateKeyPkcs8,
    casStackTrustedJwks,
  };
}

/** 按被选中的 target 选出真正要构建的镜像子集——`--service docx` 时不该
 *  顺带构建 markdown / gateway / migrate 镜像。 */
function imagesForTargets(args) {
  const images = azureImages();
  const selected = [];
  if (args.targets.includes("platform")) {
    // platform 部署三个迁移 Job(Gateway 目录 schema + 每个 Doc 的会话
    // schema),所以两个迁移镜像都要。
    selected.push(images.find((i) => i.name === "azure-migrate"));
    selected.push(images.find((i) => i.name === "azure-gateway-migrate"));
  }
  if (args.targets.includes("services")) {
    for (const docType of args.services ?? Object.keys(readAzureDocTypes(ROOT))) {
      const image = images.find((i) => i.name === `azure-${docType}`);
      if (!image) {
        throw new Error(`no azureImages() entry for service doc type ${docType} (expected name azure-${docType})`);
      }
      selected.push(image);
    }
  }
  if (args.targets.includes("gateway")) {
    selected.push(images.find((i) => i.name === "azure-gateway"));
  }
  return selected;
}

/**
 * 在 ACR 里构建被选中 target 需要的镜像;`--skip-build` 时跳过,只复用
 * 已有 tag。
 *
 * 用 `az acr build` 而不是本机 `docker build` + `docker push`,原因只有一个
 * 但足够硬:**Azure Container Apps 只接受 `linux/amd64`**,而开发机是 Apple
 * Silicon,`docker build` 产出的是 `linux/arm64`。那种镜像会推送成功、
 * 部署成功,然后副本 `exec format error` —— 报出来的错误是迁移那一步的
 * 「migration job did not finish within ...ms」,发生在镜像构建 + Postgres
 * + ACA 环境全部创建之后,且完全指不到根因。
 *
 * 本机加 `--platform linux/amd64` 交叉构建同样不行:在 arm64 上用 QEMU 模拟
 * 跑一遍完整的 `pnpm install` + `pnpm -r build` 慢到不可用。`az acr build` 在
 * ACR 中以原生 amd64 构建,不需要模拟。
 *
 * 它同时**取代**了 `az acr login` + `docker push`:构建产物直接落在 registry 里。
 * 构建上下文仍是仓库根(`.`),`.dockerignore` 继续生效;`--file` 指向
 * `stacks/azure/deploy/Dockerfile`,与上下文本就可以分离 —— 把上下文也搬进
 * `stacks/azure/deploy/` 会让它看不到 `packages/`。`Dockerfile` 本身不需要改,
 * 它是平台无关的。
 *
 * **有界并发**,默认 2,可用 `--build-concurrency` 覆盖——不用无界
 * `Promise.all`:ACR Tasks(我们用 Basic SKU)的并发构建数上限未经实测,
 * 超限的构建会排队而不是失败,但这个数字本身没有被验证过,见
 * `mapWithConcurrency()`。
 */
async function buildAndPushImages(args, bootstrap, tag) {
  const images = imagesForTargets(args);
  if (images.length === 0) {
    return;
  }
  if (args.skipBuild) {
    console.log(
      `[4/7] --skip-build: reusing existing images for tag ${tag} (${images.map((i) => i.name).join(", ")})`,
    );
    return;
  }

  console.log(`[4/7] building ${images.length} linux/amd64 images in ACR (concurrency ${args.buildConcurrency})`);

  await mapWithConcurrency(images, args.buildConcurrency, (item) =>
    // `az acr build` 的 --image 取的是 registry 内的相对路径,不带 loginServer
    // 前缀;`imageRef()` 拼出的完整引用留给各 target 的 bicep 部署消费。
    spawnAsync(
      "az",
      [
        "acr", "build",
        "--registry", bootstrap.acrName,
        "--platform", "linux/amd64",
        "--image", imageRepoTag(item.name, tag),
        "--build-arg", `SERVICE=${item.service}`,
        "--build-arg", `ENTRY=${item.entry}`,
        "--file", "stacks/azure/deploy/Dockerfile",
        ".",
      ],
      {},
      `az acr build --image ${imageRepoTag(item.name, tag)}`,
    ),
  );
}

/**
 * platform.bicep —— Postgres、Container Apps 环境、迁移 Job。`main.bicep`
 * 已经在 Task 3 被删除——`platform` 不是它的延续,是拆分出来的四个独立
 * target 之一,`-f`/deployment 名都不再指向那个已不存在的文件。
 */
function deployPlatform(args, secrets, tag) {
  console.log(`[5/7] platform.bicep: what-if then create (deployment ${DEPLOYMENT_NAMES.platform})`);
  // what-if 不接受 @secure() 参数以外的方式规避交互式确认,所以这里不吞输出。
  // 两条命令的 args 里都直接带着 pgAdminPassword 的明文(platform.bicep 的
  // @secure() 参数就是这么从 CLI 喂进去的),所以两处都必须显式传 label,
  // 绝不能落回默认的 `args.join(" ")`。
  const label = `az deployment group ... -g ${args.resourceGroup} -f stacks/azure/deploy/platform.bicep -n ${DEPLOYMENT_NAMES.platform}`;
  const docTypes = Object.keys(readAzureDocTypes(ROOT));
  const parameters = [
    `imageTag=${tag}`,
    `docTypes=${JSON.stringify(docTypes)}`,
    `pgAdminPassword=${secrets.pgAdminPassword}`,
  ];
  run(
    "az",
    [
      "deployment", "group", "what-if",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/platform.bicep",
      "--parameters", ...parameters,
    ],
    {},
    `${label} what-if`,
  );

  const stdout = capture(
    "az",
    [
      "deployment", "group", "create",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/platform.bicep",
      "-n", DEPLOYMENT_NAMES.platform,
      "-o", "json",
      "--parameters", ...parameters,
    ],
    {},
    `${label} create`,
  );
  const outputs = JSON.parse(stdout).properties.outputs;
  return {
    migrateJobNames: [
      outputs.gatewayMigrateJobName.value,
      ...outputs.docMigrateJobNames.value,
    ],
  };
}

/**
 * service.bicep —— 单个 doc type 的 Container App。deployment 名按 docType
 * 区分(`service-{docType}`,DEPLOYMENT_NAMES.service)——两个 `--service`
 * 进程同时跑时,它们必须写不同的 deployment 记录,否则会互相覆盖。
 */
function deployService(args, secrets, tag, docType) {
  const svc = readServiceParams(docType);
  const deploymentName = DEPLOYMENT_NAMES.service(docType);
  console.log(`[5/7] service.bicep (${docType}): what-if then create (deployment ${deploymentName})`);
  const label = `az deployment group ... -g ${args.resourceGroup} -f stacks/azure/deploy/service.bicep -n ${deploymentName}`;
  const parameters = [
    `docType=${docType}`,
    `imageTag=${tag}`,
    `targetPort=${svc.targetPort}`,
    `minReplicas=${svc.minReplicas}`,
    `maxReplicas=${svc.maxReplicas}`,
    ...(svc.cpu ? [`cpu=${svc.cpu}`] : []),
    ...(svc.memory ? [`memory=${svc.memory}`] : []),
    ...(svc.maxUploadBytes ? [`maxUploadBytes=${svc.maxUploadBytes}`] : []),
    `casBaseUrl=${args.casBaseUrl}`,
    `pgAdminPassword=${secrets.pgAdminPassword}`,
    `serviceAccessKey=${secrets.accessKeys[docType]}`,
    `casAccessKey=${secrets.casAccessKey}`,
    `internalAuthMode=${args.internalAuthMode}`,
    `capabilityIssuer=${args.capabilityIssuer}`,
    `casStackId=${args.casStackId}`,
    `casStackIssuer=${args.casStackIssuer}`,
    `casCapabilityAudience=${args.casCapabilityAudience}`,
    ...(secrets.capabilityTrustedJwks
      ? [`capabilityTrustedJwks=${secrets.capabilityTrustedJwks}`]
      : []),
    ...(secrets.casStackTrustedJwks
      ? [`casStackTrustedJwks=${secrets.casStackTrustedJwks}`]
      : []),
  ];
  run(
    "az",
    [
      "deployment", "group", "what-if",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/service.bicep",
      "--parameters", ...parameters,
    ],
    {},
    `${label} what-if`,
  );
  run(
    "az",
    [
      "deployment", "group", "create",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/service.bicep",
      "-n", deploymentName,
      "-o", "none",
      "--parameters", ...parameters,
    ],
    {},
    `${label} create`,
  );
}

/**
 * gateway.bicep —— 网关 Container App。`external`/`targetPort`/
 * `minReplicas`/`maxReplicas` 从 `packages/azure-gateway/azure.service.json`
 * 读出来传给模板(那四个 bicep 参数现在都带着与这份 json 逐字相同的默认值,
 * 见 gateway.bicep——传等于默认值的值不改变行为,只是让这份此前没人读的
 * 配置文件真正生效)。
 */
function deployGateway(args, secrets, tag) {
  const gw = readGatewayParams();
  console.log(`[5/7] gateway.bicep: what-if then create (deployment ${DEPLOYMENT_NAMES.gateway})`);
  const label = `az deployment group ... -g ${args.resourceGroup} -f stacks/azure/deploy/gateway.bicep -n ${DEPLOYMENT_NAMES.gateway}`;
  const parameters = [
    `imageTag=${tag}`,
    `casBaseUrl=${args.casBaseUrl}`,
    `external=${gw.external}`,
    `targetPort=${gw.targetPort}`,
    `minReplicas=${gw.minReplicas}`,
    `maxReplicas=${gw.maxReplicas}`,
    `pgAdminPassword=${secrets.pgAdminPassword}`,
    `casAccessKey=${secrets.casAccessKey}`,
    `docTypes=${JSON.stringify(Object.keys(readAzureDocTypes(ROOT)))}`,
    `docAccessKeysJson=${JSON.stringify(secrets.accessKeys)}`,
    `internalAuthMode=${args.internalAuthMode}`,
    `capabilityIssuer=${args.capabilityIssuer}`,
    `capabilityKeyId=${args.capabilityKeyId}`,
    `casStackId=${args.casStackId}`,
    `casStackIssuer=${args.casStackIssuer}`,
    `casStackKeyId=${args.casStackKeyId}`,
    `casRefDomain=${args.casRefDomain}`,
    `casCapabilityAudience=${args.casCapabilityAudience}`,
    ...(secrets.capabilityPrivateKeyPkcs8
      ? [`capabilityPrivateKeyPkcs8=${secrets.capabilityPrivateKeyPkcs8}`]
      : []),
    ...(secrets.casStackPrivateKeyPkcs8
      ? [`casStackPrivateKeyPkcs8=${secrets.casStackPrivateKeyPkcs8}`]
      : []),
  ];
  run(
    "az",
    [
      "deployment", "group", "what-if",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/gateway.bicep",
      "--parameters", ...parameters,
    ],
    {},
    `${label} what-if`,
  );

  const stdout = capture(
    "az",
    [
      "deployment", "group", "create",
      "-g", args.resourceGroup,
      "-f", "stacks/azure/deploy/gateway.bicep",
      "-n", DEPLOYMENT_NAMES.gateway,
      "-o", "json",
      "--parameters", ...parameters,
    ],
    {},
    `${label} create`,
  );
  const outputs = JSON.parse(stdout).properties.outputs;
  return { gatewayFqdn: outputs.gatewayFqdn.value };
}

/**
 * `--service` 单独跑时(本次 target 不含 gateway)冒烟仍要打公网网关——
 * 网关这次没被重新部署,拿不到 `deployGateway()` 的 output,只能查已经
 * 存在的 Container App。`unidocs-gateway` 是 `gateway.bicep` 里的固定
 * 资源名(`name: 'unidocs-gateway'`),不是本脚本猜的。
 */
function resolveExistingGatewayFqdn(args) {
  return capture(
    "az",
    [
      "containerapp", "show",
      "-g", args.resourceGroup,
      "-n", "unidocs-gateway",
      "--query", "properties.configuration.ingress.fqdn",
      "-o", "tsv",
    ],
    {},
    `az containerapp show -g ${args.resourceGroup} -n unidocs-gateway (resolve gateway fqdn for smoke)`,
  );
}

/**
 * 触发迁移 Job,轮询直到 Succeeded/Failed,超时 10 分钟。
 *
 * `jobName` 来自 `deployPlatform()` 的 `migrateJobNames` output,不
 * 在这里另起一个字面量常量 —— 那会造成两个真相来源(job 的真实名字只由
 * `stacks/azure/deploy/platform.bicep` 的 `migrateJob` 模块决定)。
 */
async function runMigration(args, jobName) {
  console.log("[6/7] starting migration job", jobName);
  const startStdout = capture("az", [
    "containerapp", "job", "start",
    "-g", args.resourceGroup,
    "-n", jobName,
    "-o", "json",
  ]);
  const execution = JSON.parse(startStdout).name;
  if (!execution) {
    throw new Error("could not determine migration job execution name from `az containerapp job start` output");
  }

  const deadline = Date.now() + MIGRATION_TIMEOUT_MS;
  for (;;) {
    const status = capture("az", [
      "containerapp", "job", "execution", "show",
      "-g", args.resourceGroup,
      "--job-execution-name", execution,
      "-n", jobName,
      "--query", "properties.status",
      "-o", "tsv",
    ]);
    if (status === "Succeeded") {
      console.log("[6/7] migration succeeded:", execution);
      return;
    }
    if (status === "Failed") {
      run("az", [
        "containerapp", "job", "logs", "show",
        "-g", args.resourceGroup,
        "-n", jobName,
        "--execution", execution,
        "--container", "migrate",
      ]);
      throw new Error(`migration job execution ${execution} failed`);
    }
    if (Date.now() > deadline) {
      throw new Error(`migration job execution ${execution} did not finish within ${MIGRATION_TIMEOUT_MS}ms (last status: ${status})`);
    }
    await sleep(MIGRATION_POLL_INTERVAL_MS);
  }
}

/** 依次跑完 `jobNames` 里的每个迁移 Job —— P0 下每个独占数据库一个。 */
async function runMigrations(args, jobNames) {
  for (const jobName of jobNames) {
    await runMigration(args, jobName);
  }
}

/** 取最后 `n` 行非空文本,trim 过、`" | "` 拼起来——`classifySmokeFailure()`
 *  与超时错误信息共用,不重复写两遍。 */
function tailLines(text, n) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ");
}

/**
 * 冒烟子进程的失败分类。`smoke.mjs` 的 `check()` 把每条失败的断言写成
 * `  FAIL ...`(stderr,见 smoke.mjs);网络不通/网关还没接管流量时,
 * `fetch()` 会抛,顶层 `catch` 把 `err.stack ?? err.message` 打到 stderr,
 * 形状是 `ECONNREFUSED`/`ENOTFOUND`/`fetch failed`/`AggregateError` 这类
 * Node 网络错误,不会有任何 `FAIL` 行(压根没跑到断言那一步)。
 *
 * 只要抓到至少一行 `FAIL`,就判定为 "assertion"——即使同时也有网络类
 * 关键词(例如某条断言本身就在描述一个连接失败),因为这说明冒烟已经
 * 跑到了断言阶段,单纯"还没就绪"解释不通。
 *
 * 子进程被 `spawnAsync()` 的 `timeoutMs` 杀掉(挂起,不是退出)不走这个
 * 函数——那种情况连"退出码"都没有,`smokeOnce()` 单独处理并归为独立的
 * `"timeout"` kind,不混进这里的 `"unknown"`(挂起和"分类不出来"是两回事)。
 */
const SMOKE_NETWORK_ERROR_PATTERN = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|AggregateError|network/i;

export function classifySmokeFailure(stdout, stderr) {
  const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
  const failLines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FAIL"));
  if (failLines.length > 0) {
    return { kind: "assertion", detail: failLines.join(" | ") };
  }
  if (SMOKE_NETWORK_ERROR_PATTERN.test(combined)) {
    return { kind: "network", detail: tailLines(combined, 3) || "(matched a network error pattern but no output captured)" };
  }
  return { kind: "unknown", detail: tailLines(combined, 3) || "(no output captured)" };
}

/**
 * 跑一次冒烟子进程。`--no-cas` 是否传给 `smoke.mjs` 由**这次部署自己
 * 有没有配 CAS** 决定(`casBaseUrl` 是否为空),不是从这个脚本的调用者
 * 手上再透传一个独立开关——这样人为选择影响不到它。`only` 非空时加
 * `--only <docType>`,把冒烟收窄到刚被重新部署的那一个 doc type
 * (`--service docx` 不该因为 markdown 冒烟失败而报红)。
 *
 * 用 `spawnAsync(..., {captureOutput:true, timeoutMs: SMOKE_ATTEMPT_TIMEOUT_MS})`
 * ——**不是** `spawnSync`:后者完全同步阻塞,父进程在子进程退出前拿不到
 * 任何数据,冒烟在重试窗口里跑几十秒的输出会在终端上完全静止,直到最后
 * 一次性刷出,人没法分辨"还在跑"还是"卡死了"。`spawnAsync()` 的
 * `captureOutput` 边收到 chunk 边转发到父进程的流(边跑边看),同时把同一份
 * chunk 攒起来供失败时分类;`timeoutMs` 顶住"`smoke.mjs` 的 `fetch()` 没有
 * 自己的超时,单次尝试可能无限期挂起"这个口子——`retryUntil()` 的总超时
 * 只在两次尝试*之间*检查,单次挂起不受它约束。
 *
 * `retryUntil()` 耗尽后抛出的最终 Error 必须能让人**只看这一行报错**就
 * 分清「revision 还没接管流量,再等等」「网络层直接挂起,再等等」和
 * 「服务起来了但功能是坏的」——三种失败分别是 `[network]`/`[timeout]`/
 * `[assertion]`。
 */
async function smokeOnce(gatewayFqdn, casBaseUrl, only) {
  const smokeArgs = ["stacks/azure/deploy/smoke.mjs", "--gateway", `https://${gatewayFqdn}`];
  if (!casBaseUrl) {
    smokeArgs.push("--no-cas");
  }
  if (only) {
    smokeArgs.push("--only", only);
  }
  const label = `node stacks/azure/deploy/smoke.mjs (only=${only ?? "all"})`;
  try {
    await spawnAsync(
      "node",
      smokeArgs,
      { captureOutput: true, timeoutMs: SMOKE_ATTEMPT_TIMEOUT_MS },
      label,
    );
  } catch (err) {
    if (err.timedOut) {
      const tail = tailLines(`${err.stdout ?? ""}\n${err.stderr ?? ""}`, 3);
      throw new Error(
        `${label} [timeout]: ${err.message} — likely the gateway/revision is still not ready ` +
          "(smoke.mjs's fetch() calls have no timeout of their own and can hang indefinitely). " +
          `Last output before kill: ${tail || "(none)"}`,
      );
    }
    const { kind, detail } = classifySmokeFailure(err.stdout, err.stderr);
    throw new Error(`${label} exited with code ${err.exitCode} [${kind}]: ${detail}`);
  }
}

/**
 * 冒烟测试,套 `retryUntil()` 重试。**这条重试与 Postgres 注册表无关** ——
 * 新 revision 接管流量本来就要几十秒,没有重试的话冒烟在那段窗口里必然
 * 失败;注册表的 30 秒 TTL 只是让这个窗口稍微长一点。
 *
 * 重试耗尽时 `retryUntil()` 原样重新抛出最后一次 `attempt()` 的 Error——
 * 也就是 `smokeOnce()` 里那条带 `[assertion]`/`[network]`/`[unknown]` 分类
 * 与失败摘要的 Error,不是某个泛化的"重试耗尽"包装错误。`main()` 顶层
 * `catch` 打的 `err.message` 因此直接就是可判断的那一行。
 */
async function runSmoke(gatewayFqdn, casBaseUrl, only) {
  console.log(`[7/7] smoke testing ${gatewayFqdn}${only ? ` (only=${only})` : ""}`);
  await retryUntil(() => smokeOnce(gatewayFqdn, casBaseUrl, only), {
    timeoutMs: SMOKE_RETRY_TIMEOUT_MS,
    intervalMs: SMOKE_RETRY_INTERVAL_MS,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const touchesCasConsumers = args.targets.includes("services") || args.targets.includes("gateway");
  if (touchesCasConsumers && !args.casBaseUrl) {
    const casDocTypes = casDocTypeNames();
    console.log(
      "[0/7] no --cas-base-url given: deploying without the Cloudflare CAS worker. " +
      `${casDocTypes} image endpoints will 501; every other endpoint is unaffected.`,
    );
  }

  const deployerObjectId = preflight(args);

  const bootstrap = args.targets.includes("bootstrap")
    ? deployBootstrap(args, deployerObjectId)
    : { acrName: BOOTSTRAP_RESOURCE_NAMES.acrName, keyVaultName: BOOTSTRAP_RESOURCE_NAMES.keyVaultName };

  const needsSecrets = args.targets.some((t) => t !== "bootstrap");
  const secrets = needsSecrets
    ? await seedSecrets(bootstrap.keyVaultName, args)
    : {
      pgAdminPassword: null,
      casAccessKey: null,
      accessKeys: {},
      capabilityPrivateKeyPkcs8: null,
      capabilityTrustedJwks: null,
      casStackPrivateKeyPkcs8: null,
      casStackTrustedJwks: null,
    };

  const tag = capture("git", ["rev-parse", "--short", "HEAD"]);

  await buildAndPushImages(args, bootstrap, tag);

  if (args.targets.includes("platform")) {
    const platformOutputs = deployPlatform(args, secrets, tag);
    await runMigrations(args, platformOutputs.migrateJobNames);
  }

  const deployedServiceDocTypes = [];
  if (args.targets.includes("services")) {
    for (const docType of args.services ?? Object.keys(readAzureDocTypes(ROOT))) {
      deployService(args, secrets, tag, docType);
      deployedServiceDocTypes.push(docType);
    }
  }

  let gatewayFqdn = null;
  if (args.targets.includes("gateway")) {
    gatewayFqdn = deployGateway(args, secrets, tag).gatewayFqdn;
  }

  if (deployedServiceDocTypes.length > 0 || args.targets.includes("gateway")) {
    if (!gatewayFqdn) {
      // 这次没重新部署网关(纯 `--service` 跑),但服务变了,仍然要证明
      // 公网网关能路由到新 revision —— 查已存在的网关 FQDN。
      gatewayFqdn = resolveExistingGatewayFqdn(args);
    }
    const only = deployedServiceDocTypes.length === 1 ? deployedServiceDocTypes[0] : null;
    await runSmoke(gatewayFqdn, args.casBaseUrl, only);
  }

  if (gatewayFqdn) {
    console.log(`deployed: https://${gatewayFqdn}`);
  } else {
    console.log(`deployed: targets=${args.targets.join(",")} (bootstrap/platform only — no gateway URL to report)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
