/**
 * Azure 真实云部署的编排脚本。可重复执行:第二次跑不会重置 Postgres
 * 密码(它存在 Key Vault 里,存在则读、不存在则生成),两次 what-if
 * 都应无变更。
 *
 * 顺序是有依赖的,不能重排:
 *   1 预检(订阅、Microsoft.App 注册)
 *   2 bootstrap.bicep     —— ACR 必须先于推镜像存在,Key Vault 必须先于播种存在
 *   3 播种/读取密钥        —— 幂等的关键
 *   4 构建并推四个镜像
 *   5 main.bicep          —— 消费 @secure() 参数与镜像 tag
 *   6 触发迁移 Job 并等它成功
 *   7 冒烟(scripts/azure-smoke.mjs)
 *
 * 用法:
 *   node scripts/azure-deploy.mjs --cas-base-url https://unidocs-cas.<account>.workers.dev
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  subscription: "24c9acbd-c2f5-4ef9-b9a2-486d90208b3e",
  resourceGroup: "rg-unidocs-dev",
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

export function imageRef(loginServer, service, tag) {
  return `${loginServer}/unidocs/${service}:${tag}`;
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
  const args = { ...DEFAULTS, casBaseUrl: "", skipBuild: false, requireCas: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--subscription": args.subscription = argv[++i]; break;
      case "--resource-group": args.resourceGroup = argv[++i]; break;
      case "--location": args.location = argv[++i]; break;
      case "--cas-base-url": args.casBaseUrl = argv[++i]; break;
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
 * 输出直接透传给终端(what-if 结果、docker build 进度、az 登录提示……
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

/** Step 1:预检 —— 订阅、资源提供者注册、资源组(全部幂等)。 */
function preflight(args) {
  console.log("[1/7] preflight: subscription + Microsoft.App registration + resource group");
  run("az", ["account", "set", "--subscription", args.subscription]);

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
    "-f", "infra/bootstrap.bicep",
  ]);

  const stdout = capture("az", [
    "deployment", "group", "create",
    "-g", args.resourceGroup,
    "-f", "infra/bootstrap.bicep",
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

function seedSecrets(keyVaultName) {
  console.log("[3/7] seeding/reading secrets from Key Vault (values withheld from logs)");
  const pgAdminPassword = seedSecret(keyVaultName, PG_ADMIN_PASSWORD_SECRET, 48);
  const internalToken = seedSecret(keyVaultName, INTERNAL_TOKEN_SECRET, 32);
  return { pgAdminPassword, internalToken };
}

/** Step 4:构建并推四个镜像;`--skip-build` 时跳过,只复用已有 tag。 */
function buildAndPushImages(args, bootstrap, tag) {
  if (args.skipBuild) {
    console.log("[4/7] --skip-build: reusing existing images for tag", tag);
    return;
  }

  console.log("[4/7] building and pushing 4 images for tag", tag);
  run("az", ["acr", "login", "-n", bootstrap.acrName]);

  for (const item of IMAGES) {
    const ref = imageRef(bootstrap.acrLoginServer, item.name, tag);
    run("docker", [
      "build",
      "--build-arg", `SERVICE=${item.service}`,
      "--build-arg", `ENTRY=${item.entry}`,
      "-t", ref,
      ".",
    ]);
    run("docker", ["push", ref]);
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
  const mainDeployLabel = `az deployment group ... -g ${args.resourceGroup} -f infra/main.bicep`;
  run(
    "az",
    [
      "deployment", "group", "what-if",
      "-g", args.resourceGroup,
      "-f", "infra/main.bicep",
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
      "-f", "infra/main.bicep",
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
 * `infra/main.bicep` 的 `migrateJob` 资源决定)。
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
  run("node", ["scripts/azure-smoke.mjs", "--gateway", `https://${gatewayFqdn}`]);
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
  const secrets = seedSecrets(bootstrap.keyVaultName);
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
