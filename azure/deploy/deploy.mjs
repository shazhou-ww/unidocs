/**
 * Azure 真实云部署的编排脚本。可重复执行:第二次跑不会重置 Postgres
 * 密码(它存在 Key Vault 里,存在则读、不存在则生成),两次 what-if
 * 都应无变更。
 *
 * 顺序是有依赖的,不能重排:
 *   1 预检(订阅、Microsoft.App 注册)
 *   2 bootstrap.bicep     —— ACR 必须先于推镜像存在,Key Vault 必须先于播种存在
 *   3 播种/读取密钥        —— 幂等的关键
 *   4 在 ACR 里构建四个 linux/amd64 镜像
 *   5 main.bicep          —— 消费 @secure() 参数与镜像 tag
 *   6 触发迁移 Job 并等它成功
 *   7 冒烟(azure/deploy/smoke.mjs)
 *
 * 用法:
 *   node azure/deploy/deploy.mjs \
 *     --cas-base-url https://unidocs-cas.<account>.workers.dev \
 *     --internal-token <与 Cloudflare CAS worker 相同的 INTERNAL_TOKEN>
 *
 * `--internal-token` 只在 Key Vault 里还没有该 secret 时需要(首次部署)。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULTS = {
  subscription: "24c9acbd-c2f5-4ef9-b9a2-486d90208b3e",
  resourceGroup: "Unidocs",
  location: "southeastasia",
};

const PG_ADMIN_PASSWORD_SECRET = "pg-admin-password";
const INTERNAL_TOKEN_SECRET = "internal-token";

/** 迁移轮询:每 5 秒查一次,10 分钟超时。 */
const MIGRATION_POLL_INTERVAL_MS = 5_000;
const MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;

/** 四个镜像:三个服务 + 迁移。第四个的入口是 dist/migrate-cli.js。 */
export const IMAGES = [
  { service: "azure-gateway", name: "azure-gateway", entry: "dist/main.js" },
  { service: "azure-markdown", name: "azure-markdown", entry: "dist/main.js" },
  { service: "azure-docx", name: "azure-docx", entry: "dist/main.js" },
  { service: "azure-sdk", name: "azure-migrate", entry: "dist/migrate-cli.js" },
];

/**
 * registry 内的仓库路径 + tag。`az acr build --image` 要的就是这个形式
 * (不带 loginServer 前缀 —— 带上会建出名叫 `crxxx.azurecr.io/unidocs/...`
 * 的仓库)。
 */
export function imageRepoTag(name, tag) {
  return `unidocs/${name}:${tag}`;
}

/** main.bicep 消费的完整镜像引用。与 `imageRepoTag()` 同源,不各写一份。 */
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

export function parseArgs(argv) {
  const args = { ...DEFAULTS, casBaseUrl: "", internalToken: "", skipBuild: false, requireCas: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--subscription": args.subscription = argv[++i]; break;
      case "--resource-group": args.resourceGroup = argv[++i]; break;
      case "--location": args.location = argv[++i]; break;
      case "--cas-base-url": args.casBaseUrl = argv[++i]; break;
      case "--internal-token": args.internalToken = argv[++i]; break;
      case "--skip-build": args.skipBuild = true; break;
      case "--require-cas": args.requireCas = true; break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (args.requireCas && !args.casBaseUrl) {
    throw new Error("--cas-base-url is required");
  }
  return args;
}

/**
 * 输出直接透传给终端(what-if 结果、az acr build 进度、az 登录提示……
 * 都是给人看的),非零退出即抛错并中止整条部署链。
 *
 * 失败时的错误信息绝不拼 `args.join(" ")`:好几个调用点(Key Vault 播种、
 * main.bicep 部署)把密码/token 直接当 `--value`/`--parameters` 的值传给
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

function checkRbac(args) {
  // 服务主体登录时 `az ad signed-in-user show` 无结果,退回 `account show`
  // 的 user.name(`--assignee` 同时接受 objectId、SPN 和 UPN)。
  const assignee =
    tryCapture("az", ["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"]) ||
    capture("az", ["account", "show", "--query", "user.name", "-o", "tsv"]);

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
      "azure/deploy/bootstrap.bicep creates two role assignments (UAMI -> AcrPull on ACR, " +
      "UAMI -> Storage Blob Data Contributor on the storage account). Contributor is NOT " +
      "enough: its notActions include Microsoft.Authorization/*/Write, so the bootstrap " +
      "deployment would fail halfway, after ACR / Storage / Key Vault / Log Analytics " +
      "already exist — leaving a partially created resource group to clean up by hand.\n" +
      "Ask for Owner (or User Access Administrator alongside Contributor) at subscription " +
      "or resource-group scope before rerunning.",
    );
  }
}

/**
 * `azure/deploy/smoke.mjs`(第 7 步)从 `packages/cas-server-common/dist/index.js` import CAS
 * 哈希算法(仓库既有惯例,`scripts/cas-digest.mjs` 同样如此),而本脚本全程
 * **不在宿主机跑 `pnpm build`** —— 它只构建镜像,那是容器内编译,`.dockerignore`
 * 还排除了 `**\/dist`。干净检出上不自检的话,会一路成功到第 7 步,在十几分钟
 * 的镜像构建与真实资源创建之后才以 ERR_MODULE_NOT_FOUND 失败。
 */
function checkHostBuild() {
  const casDist = join(ROOT, "packages/cas-server-common/dist/index.js");
  if (!existsSync(casDist)) {
    throw new Error(
      `preflight: ${casDist} is missing. azure/deploy/smoke.mjs (step 7) imports the CAS ` +
      "hash algorithm from it, and this script never runs `pnpm build` on the host " +
      "(images compile inside the container). Run `pnpm build` first.",
    );
  }
}

/** Step 1:预检 —— 订阅、RBAC、宿主机构建产物、资源提供者注册、资源组。 */
function preflight(args) {
  console.log("[1/7] preflight: subscription + RBAC + host build + Microsoft.App registration + resource group");
  run("az", ["account", "set", "--subscription", args.subscription]);

  // 两条只读自检都排在任何写操作之前:它们要拦住的正是「建到一半才失败」。
  checkRbac(args);
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
}

/** Step 2:bootstrap.bicep —— ACR / Key Vault / 存储 / 身份 / Log Analytics。 */
function deployBootstrap(args) {
  console.log("[2/7] bootstrap.bicep: what-if then create");
  run("az", [
    "deployment", "group", "what-if",
    "-g", args.resourceGroup,
    "-f", "azure/deploy/bootstrap.bicep",
  ]);

  const stdout = capture("az", [
    "deployment", "group", "create",
    "-g", args.resourceGroup,
    "-f", "azure/deploy/bootstrap.bicep",
    "-n", "bootstrap",
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

/**
 * Step 3:播种(或读回)Postgres 管理员密码与 internal token。存在则读、
 * 不存在则生成 —— 这是整条脚本可重复执行的关键:第二次跑绝不能重置
 * Postgres 密码,否则会让已经用旧密码建好的连接串全部失效。
 *
 * 读到的值只放进内存变量,绝不写文件、绝不 console.log —— 见 Step 5 的
 * 审查记录。
 */
function seedSecret(keyVaultName, secretName, byteLength) {
  const existing = tryCapture("az", [
    "keyvault", "secret", "show",
    "--vault-name", keyVaultName,
    "-n", secretName,
    "--query", "value",
    "-o", "tsv",
  ]);
  if (existing) {
    return existing;
  }
  const generated = generateSecret(byteLength);
  // label 显式给出,不落回默认的裸 `args.join(" ")`(已经删掉了那条路径)——
  // args 里的 `--value <generated>` 绝不能出现在 Error.message 里。
  run(
    "az",
    ["keyvault", "secret", "set", "--vault-name", keyVaultName, "-n", secretName, "--value", generated, "-o", "none"],
    {},
    `az keyvault secret set --vault-name ${keyVaultName} -n ${secretName}`,
  );
  return generated;
}

/**
 * `INTERNAL_TOKEN` 与 Postgres 密码性质**不同**,不能共用 `seedSecret()`:
 * 它不是本轮新生成的密钥,而是**已经存在于 Cloudflare 侧、本轮必须对齐**的
 * 既有密钥。`packages/cloudflare-cas/src/worker.ts` 对每个请求校验
 * `token !== env.INTERNAL_TOKEN` 就 401,而 docx 的图片路径经
 * `packages/doctype-server-common/src/cas-client.ts` 发出去的正是 Azure 侧的这个值。
 * 现场随机生成一个只会让所有跨云 CAS 请求 401。
 *
 * (本地栈之所以看不出来:`scripts/doc-types.mjs` 硬编码的
 * `INTERNAL_TOKEN = "unidocs-dev-token"` 被 Miniflare 与本地 Azure 栈共用。)
 */
function resolveInternalToken(keyVaultName, provided) {
  const existing = tryCapture("az", [
    "keyvault", "secret", "show",
    "--vault-name", keyVaultName,
    "-n", INTERNAL_TOKEN_SECRET,
    "--query", "value",
    "-o", "tsv",
  ]);
  if (existing) {
    // 已有则读用 —— 幂等,且第二次部署不需要再传 --internal-token。
    return existing;
  }
  if (!provided) {
    throw new Error(
      `Key Vault ${keyVaultName} has no "${INTERNAL_TOKEN_SECRET}" secret and --internal-token was not given.\n` +
      "This value is NOT generated by this deployment: it must equal the INTERNAL_TOKEN of the " +
      "already-deployed Cloudflare CAS worker (packages/cloudflare-cas). That worker rejects every " +
      "request whose X-Internal-Token differs, so a mismatch makes every cross-cloud CAS request " +
      "from azure-docx fail with 401 — the docx image path would break in production while every " +
      "local test stays green.\n" +
      "Confirm the Cloudflare-side secret exists with:\n" +
      "  cd packages/cloudflare-cas && npx wrangler secret list\n" +
      "then rerun with --internal-token <that value>.",
    );
  }
  // label 显式给出:args 里的 `--value <provided>` 绝不能进 Error.message。
  run(
    "az",
    ["keyvault", "secret", "set", "--vault-name", keyVaultName, "-n", INTERNAL_TOKEN_SECRET, "--value", provided, "-o", "none"],
    {},
    `az keyvault secret set --vault-name ${keyVaultName} -n ${INTERNAL_TOKEN_SECRET}`,
  );
  return provided;
}

function seedSecrets(keyVaultName, args) {
  console.log("[3/7] seeding/reading secrets from Key Vault (values withheld from logs)");
  const pgAdminPassword = seedSecret(keyVaultName, PG_ADMIN_PASSWORD_SECRET, 48);
  const internalToken = resolveInternalToken(keyVaultName, args.internalToken);
  return { pgAdminPassword, internalToken };
}

/**
 * Step 4:在 ACR 里构建四个镜像;`--skip-build` 时跳过,只复用已有 tag。
 *
 * 用 `az acr build` 而不是本机 `docker build` + `docker push`,原因只有一个
 * 但足够硬:**Azure Container Apps 只接受 `linux/amd64`**,而开发机是 Apple
 * Silicon,`docker build` 产出的是 `linux/arm64`。那种镜像会推送成功、
 * `main.bicep` 部署成功,然后副本 `exec format error` —— 报出来的错误是第 6 步
 * 的「migration job did not finish within ...ms」,发生在四次镜像构建 + Postgres
 * + ACA 环境全部创建之后,且完全指不到根因。
 *
 * 本机加 `--platform linux/amd64` 交叉构建同样不行:在 arm64 上用 QEMU 模拟
 * 跑四遍完整的 `pnpm install` + `pnpm -r build` 慢到不可用。`az acr build` 在
 * ACR 中以原生 amd64 构建,不需要模拟。
 *
 * 它同时**取代**了 `az acr login` + `docker push`:构建产物直接落在 registry 里。
 * 构建上下文仍是仓库根(`.`),`.dockerignore` 继续生效;`--file` 指向
 * `azure/deploy/Dockerfile`,与上下文本就可以分离 —— 把上下文也搬进
 * `azure/deploy/` 会让它看不到 `packages/`。`Dockerfile` 本身不需要改,
 * 它是平台无关的。
 */
function buildAndPushImages(args, bootstrap, tag) {
  if (args.skipBuild) {
    console.log("[4/7] --skip-build: reusing existing images for tag", tag);
    return;
  }

  console.log("[4/7] building 4 linux/amd64 images in ACR for tag", tag);

  for (const item of IMAGES) {
    // `az acr build` 的 --image 取的是 registry 内的相对路径,不带 loginServer
    // 前缀;`imageRef()` 拼出的完整引用留给 main.bicep 消费。
    run("az", [
      "acr", "build",
      "--registry", bootstrap.acrName,
      "--platform", "linux/amd64",
      "--image", imageRepoTag(item.name, tag),
      "--build-arg", `SERVICE=${item.service}`,
      "--build-arg", `ENTRY=${item.entry}`,
      "--file", "azure/deploy/Dockerfile",
      ".",
    ]);
  }
}

/** Step 5:main.bicep —— Postgres、Container Apps 环境、三个 App、迁移 Job。 */
function deployMain(args, secrets, tag) {
  console.log("[5/7] main.bicep: what-if then create");
  // what-if 不接受 @secure() 参数以外的方式规避交互式确认,但 -o none
  // 之类的静默不适用于 what-if 本身的可读性目的,所以这里不吞输出。
  //
  // 两条命令的 args 里都直接带着 pgAdminPassword/internalToken 的明文
  // (main.bicep 的 @secure() 参数就是这么从 CLI 喂进去的,brief 定的
  // 形态)。所以两处都必须显式传 label,绝不能落回默认的
  // `args.join(" ")`——那样失败时 Error.message 会把密钥打进
  // console.error。label 本身只列 -g/-f/-n 这些非密钥信息。
  const mainDeployLabel = `az deployment group ... -g ${args.resourceGroup} -f azure/deploy/main.bicep`;
  run(
    "az",
    [
      "deployment", "group", "what-if",
      "-g", args.resourceGroup,
      "-f", "azure/deploy/main.bicep",
      "--parameters",
      `imageTag=${tag}`,
      `casBaseUrl=${args.casBaseUrl}`,
      `pgAdminPassword=${secrets.pgAdminPassword}`,
      `internalToken=${secrets.internalToken}`,
    ],
    {},
    `${mainDeployLabel} what-if`,
  );

  const stdout = capture(
    "az",
    [
      "deployment", "group", "create",
      "-g", args.resourceGroup,
      "-f", "azure/deploy/main.bicep",
      "-n", "main",
      "-o", "json",
      "--parameters",
      `imageTag=${tag}`,
      `casBaseUrl=${args.casBaseUrl}`,
      `pgAdminPassword=${secrets.pgAdminPassword}`,
      `internalToken=${secrets.internalToken}`,
    ],
    {},
    `${mainDeployLabel} -n main create`,
  );
  const outputs = JSON.parse(stdout).properties.outputs;
  return {
    gatewayFqdn: outputs.gatewayFqdn.value,
    migrateJobName: outputs.migrateJobName.value,
  };
}

/**
 * Step 6:触发迁移 Job,轮询直到 Succeeded/Failed,超时 10 分钟。
 *
 * `jobName` 来自 Step 5 里 main.bicep 部署的 `migrateJobName` output,不
 * 在这里另起一个字面量常量 —— 那会造成两个真相来源(job 的真实名字只由
 * `azure/deploy/main.bicep` 的 `migrateJob` 资源决定)。
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

/** Step 7:冒烟测试。 */
function runSmoke(gatewayFqdn) {
  console.log("[7/7] smoke testing", gatewayFqdn);
  run("node", ["azure/deploy/smoke.mjs", "--gateway", `https://${gatewayFqdn}`]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.casBaseUrl) {
    throw new Error("--cas-base-url is required");
  }

  preflight(args);
  const bootstrap = deployBootstrap(args);
  const secrets = seedSecrets(bootstrap.keyVaultName, args);
  const tag = capture("git", ["rev-parse", "--short", "HEAD"]);
  buildAndPushImages(args, bootstrap, tag);
  const mainOutputs = deployMain(args, secrets, tag);
  await runMigration(args, mainOutputs.migrateJobName);
  runSmoke(mainOutputs.gatewayFqdn);

  console.log(`deployed: https://${mainOutputs.gatewayFqdn}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
