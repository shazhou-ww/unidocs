# Azure 真实云部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 gateway / markdown / docx 三个服务部署到 Azure Container Apps,用 PostgreSQL Flexible Server 与 Blob Storage 承载数据,通过公网网关跑通两种文档类型的完整读写导出链路。

**Architecture:** 两份 Bicep(`bootstrap` 建身份与不消费密钥的长寿资源,`main` 建消费 `@secure()` 参数的计算与数据库),一份参数化 Dockerfile 产出四个镜像,一个 Node 脚本串起"预检 → bootstrap → 播种密钥 → 构建推送 → main → 迁移 → 冒烟"。Blob 访问因订阅策略从连接字符串改为托管标识,这是本轮唯一的产品代码改动。

**Tech Stack:** Bicep、Azure CLI 2.88、Container Apps、PostgreSQL Flexible Server v17、Blob Storage、`@azure/identity`、esbuild、pnpm 11.22.0、Node 24、vitest

**设计文档:** `docs/superpowers/specs/2026-08-22-azure-cloud-deployment-design.md`(下称"设计")。本计划的每个任务都注明它实现设计的哪一节。**当本计划与设计冲突时,以设计为准并停下来报告冲突。**

## Global Constraints

- **npm 源**:公网 npm registry 在本机被 SNI 拦截。任何 `pnpm install` / `npm install` 必须带 `--registry=https://repo.huaweicloud.com/repository/npm/`(命令行参数,不是环境变量)。
- **Node ≥ 24,pnpm 11.22.0**(由根 `package.json` 的 `packageManager` 钉死)。镜像里的 pnpm 版本必须从该字段读取,不得硬编码 —— 照抄 `e2e/Dockerfile` 已验证的写法。
- **订阅与位置**:订阅 `24c9acbd-c2f5-4ef9-b9a2-486d90208b3e`(`Societas-MSIT-NonProd`),资源组 `rg-unidocs-dev`,region `southeastasia`。这三个值必须是脚本/Bicep 的参数,默认值取上述,不得散落硬编码。
- **策略红线(不得绕过)**:存储账户 `allowSharedKeyAccess` 必须为 `false`,ACR `adminUserEnabled` 必须为 `false`。若某步因这两条策略失败,正确反应是改设计,不是关掉策略或换用密钥认证。
- **不要删除或清理 `postgres:18` Docker 镜像** —— 另一个项目(Societas)有容器在用它。
- **不得提交 `CLAUDE.md`**(由 `.git/info/exclude` 忽略),也不得把它写进 `.gitignore`。任何提交的文件都不得引用 `.superpowers/` 下的路径。
- **不得把 Gitea token 或 Azure 密钥写进任何文件**。密钥只在进程内存与 Key Vault 中存在。
- **每个任务结束时** `pnpm build`、`pnpm typecheck`、`pnpm test` 必须通过。
- **`pnpm test:local` 的基线是「不新增失败」,不是「全绿」** —— 分支起点 `fb2b773` 上已有两个与本轮无关的失败,已独立核实:
  1. `scripts/doc-types.test.mjs` 断言 `["markdown","docx"]`,而 `psd` 已注册进 `DOC_TYPES`
  2. `scripts/local-runtime.test.mjs` 的 "registry seed works with a persist directory" —— 一次 `startLocalRuntime` 调用内重复绑定端口 8790
  除这两条外的任何失败都属于当前任务,必须修。**不要顺手修这两条** —— 它们是独立问题,混进本分支会让评审无法分辨。

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `packages/azure-sdk/src/env.ts` | 新增 `resolveBlobConfig()` —— Blob 两种模式的互斥契约,判定点在启动 | 1 |
| `packages/azure-sdk/src/pool.ts` | `AzureConfig` 两个 blob 字段改可选;`createBlobService()` 改双分支 | 1 |
| `packages/azure-sdk/src/doc-type-service.ts` | `DocTypeServiceConfig` 增 `blobAccountUrl?`;`runDocTypeService()` 改用 `resolveBlobConfig()` | 1 |
| `packages/azure-sdk/src/migrate-cli.ts` | 去掉残留的 blob 参数 | 1 |
| `packages/azure-sdk/tests/env.test.ts` | 契约表五种情形的测试 | 1 |
| `scripts/workspace-aliases.mjs` | `EXTERNAL_NPM_PACKAGES` 的文档更新 | 2 |
| `packages/azure-{gateway,markdown}/scripts/bundle.mjs`、`packages/azure-sdk/scripts/bundle-migrate-cli.mjs` | 从 `packages: "external"` 统一到 `external: EXTERNAL_NPM_PACKAGES` | 2 |
| `packages/azure-{gateway,markdown,docx}/package.json` | 声明 `EXTERNAL_NPM_PACKAGES` 的全部条目 | 2 |
| `scripts/bundle-deps.test.mjs` | 静态测试:防止声明与外部化列表再次漂移 | 2 |
| `Dockerfile` | 参数化服务镜像(`ARG SERVICE`) | 3 |
| `.dockerignore` | 已存在,按需补充 | 3 |
| `infra/bootstrap.bicep` | Key Vault、UAMI、ACR、Storage、Log Analytics + 两条角色分配 | 4 |
| `infra/main.bicep` | Postgres、防火墙规则、Container Apps 环境、三个 App、迁移 Job | 5 |
| `scripts/azure-deploy.mjs` | 部署编排(可重复执行) | 6 |
| `scripts/azure-deploy.test.mjs` | 部署脚本纯逻辑部分的单测 | 6 |
| `scripts/azure-smoke.mjs` | 对已部署网关的验收断言 | 7 |
| `README.md` | 部署章节 | 8 |

---

### Task 1: Blob 改托管标识 + 启动期配置契约

实现设计 §6.1 与 §4.3。这是唯一的产品代码改动,也是后续所有任务的前提。

**背景(实施者需要知道的)**:目标订阅上有一条生效的策略 `SFI-ID4.2.1 — deny storage accounts with shared key access`,使得存储账户的 `allowSharedKeyAccess` 被强制为 `false`。连接字符串就是 shared key,所以云上必须改用托管标识。本地的 Azurite 不支持托管标识,因此连接字符串分支必须保留 —— 两条路径都要活着。

**Files:**
- Modify: `packages/azure-sdk/src/env.ts`
- Modify: `packages/azure-sdk/src/pool.ts:11-14`(`AzureConfig`)、`:66-68`(`createBlobService`)
- Modify: `packages/azure-sdk/src/doc-type-service.ts:29-42`(`DocTypeServiceConfig`)、`:150-156`(`runDocTypeService` 读环境变量处)
- Modify: `packages/azure-sdk/src/migrate-cli.ts:34-37`
- Modify: `packages/azure-sdk/package.json`(依赖)
- Test: `packages/azure-sdk/tests/env.test.ts`(新建)

**Interfaces:**
- Produces: `resolveBlobConfig(env?: NodeJS.ProcessEnv): { blobConnectionString: string; blobAccountUrl: string }`,从 `@unidocs/azure-sdk` 的 `env.ts` 导出。Task 6 的部署脚本不直接用它,但 Task 5 的 Bicep 必须按它的契约注入环境变量。
- Produces: `AzureConfig` 的两个字段均为可选:`{ databaseUrl: string; blobConnectionString?: string; blobAccountUrl?: string }`

- [ ] **Step 1: 安装 `@azure/identity`**

```bash
pnpm --filter @unidocs/azure-sdk add @azure/identity --registry=https://repo.huaweicloud.com/repository/npm/
```

装完确认 `packages/azure-sdk/package.json` 的 `dependencies` 里出现了 `@azure/identity`,且 `pnpm-lock.yaml` 有对应改动。

- [ ] **Step 2: 写失败的测试**

新建 `packages/azure-sdk/tests/env.test.ts`。注意本包的 `vitest.config.ts` 有 `globalSetup`,会起 docker 容器 —— 这是本包既有行为,本测试不依赖容器但会被它带起来,属正常。

```ts
/**
 * `resolveBlobConfig()` 的启动期契约。两种 Blob 模式互斥,判定必须发生在
 * 进程启动,不能推迟到第一次 Blob 操作 —— 那时容器已经通过健康检查、
 * 已经在接流量了。见设计 §6.1 的契约表。
 */
import { afterEach, describe, expect, test } from "vitest";
import { resolveBlobConfig } from "../src/env.js";

const KEYS = ["BLOB_CONNECTION_STRING", "BLOB_ACCOUNT_URL", "AZURE_CLIENT_ID"] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("resolveBlobConfig", () => {
  test("只有连接串:本地/Azurite 模式", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    expect(resolveBlobConfig()).toEqual({
      blobConnectionString: "UseDevelopmentStorage=true",
      blobAccountUrl: "",
    });
  });

  test("只有账户 URL 且有 client id:云上托管标识模式", () => {
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    process.env.AZURE_CLIENT_ID = "00000000-0000-0000-0000-000000000000";
    expect(resolveBlobConfig()).toEqual({
      blobConnectionString: "",
      blobAccountUrl: "https://stunidocs.blob.core.windows.net",
    });
  });

  test("两者都有:启动失败,错误里同时点名两个变量", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    expect(() => resolveBlobConfig()).toThrow(/BLOB_CONNECTION_STRING.*BLOB_ACCOUNT_URL/s);
  });

  test("两者都无:启动失败", () => {
    expect(() => resolveBlobConfig()).toThrow(/BLOB_CONNECTION_STRING|BLOB_ACCOUNT_URL/);
  });

  // 这条是本次改动的核心风险:用**用户分配**的托管标识时,
  // DefaultAzureCredential 缺了 AZURE_CLIENT_ID 照样能构造成功,
  // 失败会推迟到第一次 Blob 操作。所以它必须在启动就炸。
  test("有账户 URL 但无 AZURE_CLIENT_ID:启动失败,错误点名 AZURE_CLIENT_ID", () => {
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    expect(() => resolveBlobConfig()).toThrow(/AZURE_CLIENT_ID/);
  });

  // 连接串模式不需要 AZURE_CLIENT_ID —— 否则本地栈会被这条契约误伤。
  test("连接串模式不要求 AZURE_CLIENT_ID", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    expect(() => resolveBlobConfig()).not.toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/env.test.ts
```

预期:FAIL,报 `resolveBlobConfig` 不存在(`does not provide an export named 'resolveBlobConfig'`)。

- [ ] **Step 4: 实现 `resolveBlobConfig()`**

在 `packages/azure-sdk/src/env.ts` 末尾追加:

```ts
/**
 * Blob 存储的两种互斥配置模式,判定点在**进程启动**。
 *
 * 云上因订阅策略(deny storage accounts with shared key access)不能用
 * 连接字符串,只能用账户 URL + 托管标识;本地 Azurite 不支持托管标识,
 * 只能用连接字符串。两者同时给出是配置错误,静默优先某一个会让它潜伏
 * 到运行时。
 *
 * `AZURE_CLIENT_ID` 在账户 URL 模式下是必填的,不是可选优化:用
 * **用户分配**的托管标识时,`DefaultAzureCredential` 缺了它照样能构造
 * 成功,失败会推迟到第一次 Blob 操作 —— 那时容器已经通过健康检查并
 * 开始接流量。
 */
export interface BlobEnvConfig {
  blobConnectionString: string;
  blobAccountUrl: string;
}

export function resolveBlobConfig(env: NodeJS.ProcessEnv = process.env): BlobEnvConfig {
  const blobConnectionString = env.BLOB_CONNECTION_STRING ?? "";
  const blobAccountUrl = env.BLOB_ACCOUNT_URL ?? "";

  if (blobConnectionString && blobAccountUrl) {
    throw new Error(
      "BLOB_CONNECTION_STRING and BLOB_ACCOUNT_URL are mutually exclusive; set exactly one",
    );
  }
  if (!blobConnectionString && !blobAccountUrl) {
    throw new Error("Set either BLOB_CONNECTION_STRING (local/Azurite) or BLOB_ACCOUNT_URL (Azure)");
  }
  if (blobAccountUrl && !env.AZURE_CLIENT_ID) {
    throw new Error(
      "BLOB_ACCOUNT_URL requires AZURE_CLIENT_ID (the user-assigned managed identity's client id)",
    );
  }

  return { blobConnectionString, blobAccountUrl };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/env.test.ts
```

预期:6 个测试全部 PASS。

- [ ] **Step 6: 改 `createBlobService()` 与 `AzureConfig`**

`packages/azure-sdk/src/pool.ts`,顶部 import 增加:

```ts
import { DefaultAzureCredential } from "@azure/identity";
```

`AzureConfig` 改为:

```ts
export interface AzureConfig {
  databaseUrl: string;
  /** 本地/Azurite 模式。与 `blobAccountUrl` 互斥,见 `resolveBlobConfig()`。 */
  blobConnectionString?: string;
  /** 云上模式:账户端点 URL,配合用户分配的托管标识。 */
  blobAccountUrl?: string;
}
```

`createBlobService()` 改为:

```ts
export function createBlobService(cfg: AzureConfig): BlobServiceClient {
  if (cfg.blobConnectionString) {
    return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
  }
  if (cfg.blobAccountUrl) {
    return new BlobServiceClient(cfg.blobAccountUrl, new DefaultAzureCredential());
  }
  throw new Error("neither blobConnectionString nor blobAccountUrl is set");
}
```

`createPool()` **不动** —— 它只用 `databaseUrl`。

- [ ] **Step 7: 改 `doc-type-service.ts`**

`DocTypeServiceConfig`(约 `:29`)的 `blobConnectionString: string;` 改为:

```ts
  blobConnectionString?: string;
  /** 云上模式:Blob 账户端点 URL,与 `blobConnectionString` 互斥。 */
  blobAccountUrl?: string;
```

`runDocTypeService()` 里读环境变量处(约 `:150`),把 `blobConnectionString: requireEnv("BLOB_CONNECTION_STRING"),` 替换为展开:

```ts
    config: {
      databaseUrl: requireEnv("DATABASE_URL"),
      ...resolveBlobConfig(),
      internalToken: requireEnv("INTERNAL_TOKEN"),
      casBaseUrl: process.env.CAS_BASE_URL,
    },
```

并在该文件的 import 中加入 `resolveBlobConfig`(它与 `requireEnv` 同在 `./env.js`)。

- [ ] **Step 8: 清掉 `migrate-cli.ts` 的残留 blob 参数**

`migrate-cli.ts` 只调 `createPool()` 与 `runMigrations(pool)`,从不构造 `BlobServiceClient`。把:

```ts
  const pool = createPool({
    databaseUrl,
    blobConnectionString: process.env.BLOB_CONNECTION_STRING ?? "",
  });
```

改为:

```ts
  const pool = createPool({ databaseUrl });
```

同时把文件头注释里 "Reads `DATABASE_URL` (required) and `BLOB_CONNECTION_STRING` (optional — this script never touches Blob Storage)" 改成 "Reads `DATABASE_URL` (the only variable it needs — this script never touches Blob Storage)"。

- [ ] **Step 9: 全量验证**

```bash
pnpm build && pnpm typecheck && pnpm test
```

预期:全绿。`pool.test.ts` 传的 `{ databaseUrl, blobConnectionString }` 仍然合法(字段变可选不影响)。

- [ ] **Step 10: 本地栈验证 —— 连接串分支必须毫发无伤**

```bash
pnpm test:local
```

预期:全绿。这一步是本任务的关键验收 —— 设计 §10 第 1 条要求本改动不得影响本地栈与 e2e 树。若 `azure-behavior` / `azure-multi-replica` / `azure-docx-image` 任一失败,说明连接串分支被破坏了,必须修好再提交。

- [ ] **Step 11: Commit**

```bash
git add packages/azure-sdk pnpm-lock.yaml
git commit -m "feat(azure-sdk): Blob 改托管标识,配置契约提前到启动期"
```

---

### Task 2: 统一四个 bundler 的外部化策略 + 补依赖声明

实现设计 §6.2。

**背景**:仓库里有五个 esbuild 打包点,外部化策略已经分成两派:

| 打包点 | 当前 |
|---|---|
| `packages/azure-markdown/scripts/bundle.mjs:49` | `packages: "external"` |
| `packages/azure-gateway/scripts/bundle.mjs:28` | `packages: "external"` |
| `packages/azure-sdk/scripts/bundle-migrate-cli.mjs:35` | `packages: "external"` |
| `packages/azure-docx/scripts/bundle.mjs:59` | `external: EXTERNAL_NPM_PACKAGES` |
| `scripts/azure-runtime.mjs:202`(`bundleService()`) | `external: EXTERNAL_NPM_PACKAGES` |

这个分叉已经造成过一次生产级 bug:`packages: "external"` 把**所有**裸导入留在外面,用它的包因此必须声明 `pg` / `@azure/storage-blob`,markdown 与 gateway 确实声明了;docx 用显式列表,同样把这两个留在外面,却漏了声明 —— monorepo 里靠根 `node_modules` 提升能解析,生产安装会 `ERR_MODULE_NOT_FOUND`。Task 3 的 `pnpm deploy` 严格按声明裁剪,会让这个漏洞直接变成容器起不来。

统一到 `external: EXTERNAL_NPM_PACKAGES`,即向已经在跑整个本地 Azure 栈、已被验证的 `scripts/azure-runtime.mjs` 对齐。

**关于 `@azure/identity`(Task 1 的实测结论,已推翻本计划最初的假设)**:它**不能**被 esbuild 内联 —— 内联会把它的 CJS 传递依赖(`jsonwebtoken` / `jws`)一起打进产物,运行时崩在 `Dynamic require of "buffer"`,`azure-markdown` / `azure-docx` 的本地进程启动即死。Task 1 因此已经把 `@azure/identity` 加进 `EXTERNAL_NPM_PACKAGES` 与根 `package.json` 的 `devDependencies`(后者提供本地开发所需的根 `node_modules` 提升)。

**本任务因此要做的是**:让三个服务包的 `dependencies` 都声明 `@azure/identity`(它现在是外部化列表的第三项,不声明就会在 `pnpm deploy --prod` 裁剪时消失)。这条由 Step 1 的测试自动覆盖 —— 该测试断言的是"声明了 `EXTERNAL_NPM_PACKAGES` 的**全部**条目",列表变长时断言自动跟着变严。

**Files:**
- Modify: `packages/azure-markdown/scripts/bundle.mjs`、`packages/azure-gateway/scripts/bundle.mjs`、`packages/azure-sdk/scripts/bundle-migrate-cli.mjs`
- Modify: `packages/azure-docx/package.json`(补 `pg`、`@azure/storage-blob`)
- Modify: `scripts/workspace-aliases.mjs`(更新 `EXTERNAL_NPM_PACKAGES` 的文档)
- Test: `scripts/bundle-deps.test.mjs`(新建)
- Modify: `package.json`(把新测试加进 `test:local`)

**Interfaces:**
- Consumes: Task 1 给 `azure-sdk` 加的 `@azure/identity` 依赖
- Produces: 不变量 —— **每个 azure 服务包的 `dependencies` 必须包含 `EXTERNAL_NPM_PACKAGES` 的全部条目**。Task 3 的镜像方案依赖这条。

- [ ] **Step 1: 写失败的测试**

新建 `scripts/bundle-deps.test.mjs`:

```js
/**
 * 防漂移:凡是被 esbuild 留在 bundle 外面的 npm 包,都必须出现在使用
 * 该 bundle 的服务包的 `dependencies` 里,否则产物在生产安装(只装本包
 * 声明的生产依赖)时会 `ERR_MODULE_NOT_FOUND`。
 *
 * 这不是假设性风险:`azure-docx` 曾经正是这样漏了 `pg` 与
 * `@azure/storage-blob` —— monorepo 里靠根 node_modules 提升掩盖了,
 * 只有真正做镜像时才会暴露。
 *
 * 第二条断言同样重要:所有 azure 打包脚本必须用同一种外部化策略。
 * 两派并存正是上面那个 bug 的根因。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXTERNAL_NPM_PACKAGES } from "./workspace-aliases.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const SERVICE_PACKAGES = ["azure-gateway", "azure-markdown", "azure-docx"];

const BUNDLERS = [
  "packages/azure-gateway/scripts/bundle.mjs",
  "packages/azure-markdown/scripts/bundle.mjs",
  "packages/azure-docx/scripts/bundle.mjs",
  "packages/azure-sdk/scripts/bundle-migrate-cli.mjs",
];

describe("bundle 外部化与依赖声明", () => {
  test.each(SERVICE_PACKAGES)("%s 声明了全部外部化的 npm 包", (pkg) => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
    );
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const external of EXTERNAL_NPM_PACKAGES) {
      expect(declared).toContain(external);
    }
  });

  // azure-sdk 自己也是迁移镜像的来源,同样要声明。
  test("azure-sdk 声明了全部外部化的 npm 包", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/azure-sdk/package.json"), "utf8"),
    );
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const external of EXTERNAL_NPM_PACKAGES) {
      expect(declared).toContain(external);
    }
  });

  test.each(BUNDLERS)("%s 用显式外部化列表,不用 packages: \"external\"", (rel) => {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    // 去掉块注释,避免命中文档里对该写法的讨论
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("external: EXTERNAL_NPM_PACKAGES");
    expect(code).not.toContain('packages: "external"');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run scripts/bundle-deps.test.mjs
```

预期:FAIL。`azure-docx` 那条报缺 `pg` / `@azure/storage-blob`;三个 bundler 那条报仍在用 `packages: "external"`。

- [ ] **Step 3: 给 `azure-docx` 补依赖**

`packages/azure-docx/package.json` 的 `dependencies` 改为:

```json
  "dependencies": {
    "@unidocs/azure-sdk": "workspace:*",
    "@unidocs/doctype-docx": "workspace:*",
    "@azure/identity": "^4.13.2",
    "@azure/storage-blob": "^12.33.0",
    "pg": "^8.23.0"
  },
```

同时给 `devDependencies` 补 `"@types/pg": "^8.23.1"`(与 markdown 一致)。

**`azure-gateway` 与 `azure-markdown` 也要补 `@azure/identity`** —— 它们原先只声明了 `pg` 与 `@azure/storage-blob`,而 Task 1 把 `@azure/identity` 加进了外部化列表。版本号一律用 `^4.13.2`,与 `packages/azure-sdk/package.json` 里 Task 1 装进去的那个一致(去那个文件里读实际值,不要照抄本段 —— 若两者不符,以该文件为准)。

依赖改动后必须跑一次 `pnpm install --registry=https://repo.huaweicloud.com/repository/npm/` 让 lockfile 跟上,并把 `pnpm-lock.yaml` 一并提交。

- [ ] **Step 4: 三个 bundler 改用显式列表**

对 `packages/azure-markdown/scripts/bundle.mjs`、`packages/azure-gateway/scripts/bundle.mjs`、`packages/azure-sdk/scripts/bundle-migrate-cli.mjs` 三个文件各做同样两处修改。

import 改为(路径按各文件相对深度,markdown/gateway 是 `../../../scripts/`,`azure-sdk/scripts/bundle-migrate-cli.mjs` 也是 `../../../scripts/`):

```js
import {
  EXTERNAL_NPM_PACKAGES,
  resolveWorkspaceAliases,
} from "../../../scripts/workspace-aliases.mjs";
```

esbuild 配置里的 `packages: "external",` 替换为:

```js
  // 全仓统一用这一份显式列表:`packages: "external"` 会把每一个裸导入
  // 都留在外面,包括 `@azure/identity` 这种没有被提升到根 node_modules
  // 的包,产物只有在生产安装时才会以 ERR_MODULE_NOT_FOUND 暴露。
  external: EXTERNAL_NPM_PACKAGES,
```

同时把三个文件头部注释里描述 `packages: "external"` 行为的段落改写为指向 `scripts/workspace-aliases.mjs` 的 `EXTERNAL_NPM_PACKAGES` 文档,不要留下与代码矛盾的注释。

- [ ] **Step 5: 更新 `EXTERNAL_NPM_PACKAGES` 的文档**

`scripts/workspace-aliases.mjs` 里 `EXTERNAL_NPM_PACKAGES` 上方的长注释,当前写的是"`packages/azure-docx/scripts/bundle.mjs` 和 `scripts/azure-runtime.mjs` 的 `bundleService()` 都 import 这个"。改为说明**全部五个打包点**都用它(Task 1 已把 `@azure/identity` 加进列表并同步改过一部分措辞,在此基础上改,不要推倒重写)。

同时补上 `@azure/identity` **为什么必须外部化**的记录:内联会把它的 CJS 传递依赖(`jsonwebtoken` / `jws`)打进产物,运行时崩在 `Dynamic require of "buffer"`。这是实测结论,写下来是为了让下一个想"少一个外部依赖"的人不必再踩一遍。

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm exec vitest run scripts/bundle-deps.test.mjs
```

预期:全部 PASS。

- [ ] **Step 7: 确认产物里真的没有裸的 `@azure/identity`**

```bash
pnpm build
for f in packages/azure-gateway/dist/main.js packages/azure-markdown/dist/main.js packages/azure-docx/dist/main.js; do
  echo "$f: identity=$(grep -c 'from "@azure/identity"' $f) pg=$(grep -c 'from "pg"' $f) blob=$(grep -c 'from "@azure/storage-blob"' $f)"
done
```

预期:三个文件的 `identity` / `pg` / `blob` **都不是 0** —— 三个包都在外部化列表里,产物应保留裸导入,而它们现在都已被 `dependencies` 声明。

**同时验证产物真的能被 node 加载**(裸导入是否可解析,`grep` 看不出来):

```bash
node -e "import('./packages/azure-docx/dist/main.js').catch(e => { console.log(e.constructor.name + ': ' + e.message.split('\n')[0]); process.exit(0); })"
```

预期:打印一条**缺环境变量**的错误(形如 `Set either BLOB_CONNECTION_STRING ... or BLOB_ACCOUNT_URL ...`)。若打印的是 `ERR_MODULE_NOT_FOUND` 或 `Dynamic require of "buffer" is not supported`,**停下来报告** —— 前者说明外部化的包没被声明或没被提升,后者说明某个 CJS 包被误内联了。

- [ ] **Step 8: 把新测试加进 `test:local`**

根 `package.json` 的 `test:local` 脚本,在 `scripts/doc-types.test.mjs` 之后插入 `scripts/bundle-deps.test.mjs`。

- [ ] **Step 9: 全量验证**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm test:local
```

预期:全绿。

- [ ] **Step 10: Commit**

```bash
git add packages/azure-gateway packages/azure-markdown packages/azure-docx packages/azure-sdk scripts/workspace-aliases.mjs scripts/bundle-deps.test.mjs package.json
git commit -m "fix(azure): 统一四个 bundler 的外部化策略,补齐 azure-docx 缺失的依赖声明"
```

---

### Task 3: 服务镜像 Dockerfile

实现设计 §7。

**背景**:一份 Dockerfile 通过 `ARG SERVICE` 产出四个镜像 —— `azure-gateway`、`azure-markdown`、`azure-docx`、`azure-sdk`(第四个是迁移 Job 的镜像,它已经有自己的 `scripts/bundle-migrate-cli.mjs` 产出 `dist/migrate-cli.js`)。

裁剪用 `pnpm deploy --prod`,它产出**真实(非软链)**的 `node_modules`,并且**严格按 package.json 的声明**裁剪。这正是选它的主要理由:Task 2 修掉的那类"声明与产物不一致"会在这里直接变成容器起不来,而不是等到生产。

`e2e/Dockerfile` 里已经有一段被验证过的 pnpm 安装写法(公网 npm 源被 SNI 拦截,`corepack prepare` 走不通,版本从 `packageManager` 字段读取),照抄它,不要另创写法。

**Files:**
- Create: `Dockerfile`(仓库根)
- Modify: `.dockerignore`(已存在)
- Modify: `packages/azure-sdk/package.json`(`files` 加上 `migrations`,见 Step 1)

**Interfaces:**
- Consumes: Task 1 的 `resolveBlobConfig()` 启动契约(Step 6 的验证依赖它的错误信息);Task 2 保证的依赖声明完整性
- Produces: 镜像构建命令 `docker build --build-arg SERVICE=<name> --build-arg ENTRY=<path> -t <ref> .`,Task 6 的部署脚本按此调用

- [ ] **Step 1: 补上 `azure-sdk` 的 `files`,否则迁移镜像必然崩**

这一条是本任务的前置修复,**不做的话 Step 7 一定失败**。

`runMigrations()` 通过 `MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url))` 定位 SQL 文件(`packages/azure-sdk/src/migrate.ts`)。打包产物 `dist/migrate-cli.js` 落在包根下一层,`../migrations` 因此指向包根的 `migrations/` —— 在仓库里成立。

但 `packages/azure-sdk/package.json` 的 `files` 只有 `["dist"]`,而下面用的 `pnpm deploy` **严格按 `files` 裁剪**:产出里不会有 `migrations/`,容器里 `readdirSync` 直接 ENOENT。

把 `files` 改成:

```json
  "files": [
    "dist",
    "migrations"
  ],
```

**这个修法已实测验证**:改完后 `pnpm deploy` 的产出里 `dist/` 与 `migrations/` 是兄弟目录,正是 `dist/migrate-cli.js` 的 `../migrations` 所需的相对深度。

- [ ] **Step 1b: 确认 `pnpm deploy` 的可用调用形式(结论已实测,照用即可)**

pnpm 10 起 `pnpm deploy` 对不启用 `inject-workspace-packages` 的工作区会直接报 `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`,而且它会**重新向 registry 解析依赖**,因此本机还必须带镜像源。两个开关缺一不可,已实测:

```bash
pnpm -r build
rm -rf /tmp/deploy-probe
pnpm deploy --legacy --filter @unidocs/azure-sdk --prod   --registry=https://repo.huaweicloud.com/repository/npm/ /tmp/deploy-probe
```

验证产物:

```bash
ls -1 /tmp/deploy-probe                       # 必须含 dist / migrations / node_modules
test -f /tmp/deploy-probe/dist/migrate-cli.js && echo "entry ok"
for p in pg @azure/storage-blob @azure/identity; do
  test -d "/tmp/deploy-probe/node_modules/$p" && echo "  $p ok" || echo "  $p 缺失"
done
```

`dist`、`migrations`、`node_modules` 三者都要在,三个 npm 包都要 ok。若某个 npm 包缺失,说明 Task 2 建立的依赖声明不变量被破坏了 —— 回头查 `package.json`,**不要**在 Dockerfile 里补 `npm install` 绕过。

再对一个服务包验证一次(它比 `azure-sdk` 多一层 workspace 依赖):

```bash
rm -rf /tmp/deploy-probe2
pnpm deploy --legacy --filter @unidocs/azure-docx --prod   --registry=https://repo.huaweicloud.com/repository/npm/ /tmp/deploy-probe2
test -f /tmp/deploy-probe2/dist/main.js && echo "docx entry ok"
```

- [ ] **Step 1c: 跑完 `pnpm deploy --prod` 之后必须重置工作区安装状态**

**这一步是强制的,漏掉会让后续每一条 `pnpm` 命令都失败。**

宿主机上的 `pnpm deploy --prod` 会把 `node_modules/.pnpm-workspace-state-v1.json` 里的 `settings.dev` 写成 `false`,即把整个工作区的安装状态记成「production 安装」。此后任何 `pnpm <script>`(包括 `pnpm build`)都会先触发一次 `pnpm install --production`,而它想**删除整个 `node_modules`** 再重装 —— 在非 TTY 环境下会以

```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
```

中止(有 TTY 时会真的删)。这是实测踩到的,不是推测。

重置:

```bash
pnpm install --registry=https://repo.huaweicloud.com/repository/npm/
node -e "const s=require('./node_modules/.pnpm-workspace-state-v1.json');console.log('dev:',s.settings?.dev)"
pnpm build
```

第二条必须打印 `dev: true`,第三条必须退出码 0。

**不要**为了绕过那条报错去设 `CI=true` 或 `confirmModulesPurge=false` —— 那只会让它真的把 `node_modules` 删掉。


- [ ] **Step 2: 写 Dockerfile**

在仓库根创建 `Dockerfile`。把 Step 1 实测可用的 `pnpm deploy` 调用形式填进去(下面写的是不带 `--legacy` 的版本):

```dockerfile
# syntax=docker/dockerfile:1

# 一份 Dockerfile 产出四个镜像,由 SERVICE 选择:
#   azure-gateway / azure-markdown / azure-docx  -> ENTRY=dist/main.js
#   azure-sdk                                    -> ENTRY=dist/migrate-cli.js(迁移 Job)
#
# 裁剪用 `pnpm deploy --prod`:它产出真实(非软链)的 node_modules,并且
# 严格按 package.json 的声明裁剪 —— 一个漏声明的运行时依赖会让构建产出
# 一个起不来的镜像,而不是等到生产才 ERR_MODULE_NOT_FOUND。

ARG SERVICE
ARG ENTRY=dist/main.js

FROM node:24-alpine AS builder
ARG SERVICE
WORKDIR /repo

# 公网 npm registry 在本环境被 SNI 拦截,且 corepack 的按版本解析端点在
# 该镜像源上返回相对 tarball 路径导致失败 —— 与 e2e/Dockerfile 同源的
# 问题,用同样的解法:npm install -g 直接打 registry 根。版本从
# packageManager 字段读取,不硬编码(否则会是第二个真相来源)。
COPY package.json /tmp/package.json
RUN PNPM_VERSION=$(node -e "process.stdout.write(require('/tmp/package.json').packageManager.match(/^pnpm@([0-9.]+)/)[1])") \
    && rm /tmp/package.json \
    && npm install -g "pnpm@${PNPM_VERSION}" --registry=https://repo.huaweicloud.com/repository/npm/ \
    && [ "$(pnpm --version)" = "$PNPM_VERSION" ]

# 整个工作区一次性拷入:pnpm install --frozen-lockfile 需要每一个工作区
# 包的 package.json 都在场,分层拷贝在 monorepo 里要靠 find 拼,得不偿失。
COPY . .

RUN pnpm install --frozen-lockfile --registry=https://repo.huaweicloud.com/repository/npm/
RUN pnpm -r build
# --legacy:pnpm 10 起,未启用 inject-workspace-packages 的工作区不加这个
# 会直接 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE。
# --registry:deploy 会重新向 registry 解析依赖,不带镜像源会卡在被 SNI
# 拦截的公网源上。两个开关都是实测确认必需的,不要删。
RUN pnpm deploy --legacy --filter "@unidocs/${SERVICE}" --prod \
    --registry=https://repo.huaweicloud.com/repository/npm/ /out

FROM node:24-alpine AS runtime
ARG ENTRY
WORKDIR /app
COPY --from=builder /out ./
ENV NODE_ENV=production
ENV ENTRY=${ENTRY}
# exec 形式让 node 成为 PID 1,SIGTERM 才能到达进程自己的关停处理器
# (doc-type-service.ts 与 azure-gateway/src/main.ts 都装了 SIGTERM handler)。
CMD ["sh", "-c", "exec node $ENTRY"]
```

- [ ] **Step 3: 确认 `.dockerignore` 覆盖到位**

现有 `.dockerignore` 已排除 `.git`、`node_modules`、`**/node_modules`、`**/.wrangler`、`.treespec-output`。追加两行,避免把本地 Azure 栈的运行时产物带进构建上下文:

```
.azure-runtime
**/dist
**/*.tsbuildinfo
```

**三行必须一起加,`**/*.tsbuildinfo` 不是可选的。** 只排除 `**/dist` 会让构建在容器里失败:仓库每个包都有 `packages/*/tsconfig.tsbuildinfo`,而 `packages/core` 是 composite 项目(`compilerOptions.composite: true`)。`tsc` 读到被拷进容器的那份 tsbuildinfo 会认为输出已是最新、**跳过 emit**,于是 `packages/core/dist/` 根本不生成,接着 `packages/doctype-markdown` 报

```
src/markdown.ts(5,42): error TS6305: Output file '/repo/packages/core/dist/index.d.ts'
  has not been built from source file '/repo/packages/core/src/index.ts'.
```

后面一串 `TS7006 implicitly has an 'any' type` 都是它的下游。这是实测踩到的,不是推测。

排除这两类之后容器里 dist 与 tsbuildinfo 都不存在,`pnpm -r build` 做一次干净的完整构建。

- [ ] **Step 4: 构建四个镜像**

```bash
docker build --build-arg SERVICE=azure-gateway  -t unidocs/azure-gateway:probe  .
docker build --build-arg SERVICE=azure-markdown -t unidocs/azure-markdown:probe .
docker build --build-arg SERVICE=azure-docx     -t unidocs/azure-docx:probe     .
docker build --build-arg SERVICE=azure-sdk --build-arg ENTRY=dist/migrate-cli.js -t unidocs/azure-migrate:probe .
```

四条都要成功。

- [ ] **Step 5: 验证镜像能加载 bundle(不是只验证 docker build 成功)**

`docker build` 成功只证明装得上,不证明跑得起来 —— `ERR_MODULE_NOT_FOUND` 只在 `node` 真的去 import 时才发生。跑一次故意缺环境变量的启动:

```bash
docker run --rm -e DATABASE_URL=postgres://x/y -e INTERNAL_TOKEN=t unidocs/azure-markdown:probe 2>&1 | tail -5
```

预期:非零退出,输出里含 `Set either BLOB_CONNECTION_STRING (local/Azurite) or BLOB_ACCOUNT_URL (Azure)`。

**这条断言同时证明了三件事**:bundle 被成功加载(没有缺依赖)、Task 1 的启动契约在镜像里生效、容器不会带着坏配置进入健康检查。

若看到的是 `ERR_MODULE_NOT_FOUND`,说明依赖裁剪掉了本该在的包 —— 回 Task 2 查声明,不要在 Dockerfile 里补 `npm install`。

- [ ] **Step 6: 验证 `AZURE_CLIENT_ID` 那条契约在镜像里也生效**

```bash
docker run --rm -e DATABASE_URL=postgres://x/y -e INTERNAL_TOKEN=t \
  -e BLOB_ACCOUNT_URL=https://example.blob.core.windows.net unidocs/azure-docx:probe 2>&1 | tail -5
```

预期:非零退出,输出里含 `AZURE_CLIENT_ID`。

- [ ] **Step 7: 验证迁移镜像**

```bash
docker run --rm unidocs/azure-migrate:probe 2>&1 | tail -5
```

预期:非零退出,输出里同时含 `Missing required env var DATABASE_URL` **和 `migrate-cli.js`**(后者出现在栈帧路径 `at requireEnv (file:///app/dist/migrate-cli.js:...)` 里)。

**必须断言后者。** 只断言前半句是不够的:`requireEnv("DATABASE_URL")` 在 `doc-type-service.ts` 与 `migrate-cli.ts` 里都是第一个调用,抛的是逐字相同的字符串,单看它无法区分入口。它在本包上碰巧仍有区分力 —— `azure-sdk` 包里没有 `dist/main.js`,`ENTRY` 若回退到默认值会是 `ERR_MODULE_NOT_FOUND` —— 但那依赖一个未言明的事实,以后 `azure-sdk` 一旦有了 `main.js` 这条断言就会静默失效。直接断言栈帧里的文件名才是真正在测入口。

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(azure): 参数化服务镜像,四个服务共用一份 Dockerfile"
```

---

### Task 4: `infra/bootstrap.bicep`

实现设计 §4.1 中标注归属为 `bootstrap` 的资源,以及 §5 的第 1 步。

**背景**:两阶段拆分是被密钥的先后依赖逼出来的 —— ACR 必须先于镜像推送存在,Key Vault 必须先于密钥播种存在,而 `main` 消费的正是这两者的产物。本阶段的资源都**不消费任何密钥**。

**Files:**
- Create: `infra/bootstrap.bicep`

**Interfaces:**
- Produces(Task 5 与 Task 6 都依赖这些 output 名):`acrName`、`acrLoginServer`、`keyVaultName`、`storageAccountName`、`blobAccountUrl`、`identityId`、`identityClientId`、`nameSuffix`

- [ ] **Step 1: 写 `infra/bootstrap.bicep`**

```bicep
targetScope = 'resourceGroup'

@description('部署位置。默认取资源组自身的位置。')
param location string = resourceGroup().location

@description('全局唯一资源名的稳定后缀。同一资源组重复部署得到同一后缀,这是幂等的依据。')
param nameSuffix string = uniqueString(resourceGroup().id)

var acrName = 'crunidocs${nameSuffix}'
var kvName = 'kvunidocs${nameSuffix}'
var storageName = 'stunidocs${nameSuffix}'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-unidocs-dev'
  location: location
}

// adminUserEnabled 必须为 false:订阅上有生效的策略
// "SFI — deny container registries with the local admin account enabled"。
// 拉镜像走下面的 AcrPull 角色分配,推镜像走部署者自己的 az 身份。
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// allowSharedKeyAccess 必须为 false:订阅上有生效的策略
// "SFI-ID4.2.1 — deny storage accounts with shared key access"。
// 这条策略正是 azure-sdk 的 Blob 客户端改用托管标识的原因。
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// cas / snapshots 两个容器不在这里声明:ports-blob.ts 已经
// createIfNotExists() 懒建(packages/azure-sdk/src/ports-blob.ts:19,21),
// 而 Storage Blob Data Contributor 角色包含建容器的权限。
// 在这里再声明一遍会造成两个真相来源。

// Key Vault 只是部署脚本的幂等存储:生成一次的 Postgres 密码要能被后续
// 部署读回来,否则每次部署都会重置它。运行时不读它 —— 值经 @secure()
// 参数流进 Container App secret。
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    softDeleteRetentionInDays: 7
    enableSoftDelete: true
  }
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-unidocs-dev'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// AcrPull
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
// Storage Blob Data Contributor
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource blobData 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output nameSuffix string = nameSuffix
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = kv.name
output storageAccountName string = storage.name
output blobAccountUrl string = storage.properties.primaryEndpoints.blob
output identityId string = identity.id
output identityClientId string = identity.properties.clientId
```

- [ ] **Step 2: 语法校验**

```bash
az bicep build --file infra/bootstrap.bicep --stdout > /dev/null && echo "bicep ok"
```

预期:打印 `bicep ok`,没有 error。warning 若涉及本文件写法,读一遍再决定是否消除。

- [ ] **Step 3: 注册资源提供程序并建资源组**

这是本计划第一个真正在云上产生副作用的步骤,已获授权。

```bash
az account set --subscription 24c9acbd-c2f5-4ef9-b9a2-486d90208b3e
az provider show -n Microsoft.App --query registrationState -o tsv
```

若不是 `Registered`:

```bash
az provider register -n Microsoft.App --wait
az provider show -n Microsoft.App --query registrationState -o tsv   # 必须是 Registered
```

```bash
az group create -n rg-unidocs-dev -l southeastasia -o none && echo "rg ok"
```

若 `az group create` 报权限不足,**停下来报告** —— 设计 §11 记着这是唯一无法只读确认的前提。

- [ ] **Step 4: `what-if` 预览**

```bash
az deployment group what-if -g rg-unidocs-dev -f infra/bootstrap.bicep
```

预期:列出 7 个待创建资源(identity、acr、storage、kv、law,加两条 roleAssignment)。检查 ACR 的 `adminUserEnabled` 是 `false`、存储的 `allowSharedKeyAccess` 是 `false`。

- [ ] **Step 5: 部署并检查 output**

```bash
az deployment group create -g rg-unidocs-dev -f infra/bootstrap.bicep -n bootstrap -o json \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['properties']['outputs'], indent=2))"
```

预期:8 个 output 都有值,`blobAccountUrl` 形如 `https://stunidocs<suffix>.blob.core.windows.net/`。

若存储账户或 ACR 被策略拒绝,**停下来报告**并把策略的完整错误信息带上 —— 按全局约束,正确反应是改设计,不是关策略。

- [ ] **Step 6: 幂等性检查**

```bash
az deployment group what-if -g rg-unidocs-dev -f infra/bootstrap.bicep
```

预期:全部资源显示为 `NoChange` 或 `Ignore`,没有 `Create` / `Delete` / `Modify`。若有 `Modify`,说明某个属性不是幂等的,查明并修 Bicep,不要接受"每次都会变一点"。

- [ ] **Step 7: Commit**

```bash
git add infra/bootstrap.bicep
git commit -m "feat(infra): bootstrap Bicep —— 身份、ACR、存储、Key Vault、Log Analytics"
```

---

### Task 5: `infra/main.bicep` + Container App 模块

实现设计 §4.1(归属 `main` 的资源)、§4.2、§4.3、§4.4。

**背景**:三个 Container App 的差异只有 ingress 是否对外、端口、副本数和几个环境变量,其余(身份、镜像仓库认证、两个 secret、资源规格)完全一样。因此抽一个模块,三个调用点各自只写自己不同的部分 —— 三份近乎相同的资源块正是本轮已经修过一次的那类漂移。

**Files:**
- Create: `infra/container-app.bicep`(模块)
- Create: `infra/main.bicep`

**Interfaces:**
- Consumes: Task 4 的 output —— `nameSuffix`、`acrLoginServer`、`blobAccountUrl`、`identityId`、`identityClientId`
- Produces:`gatewayFqdn`(Task 6、Task 7 用它做冒烟入口)、`migrateJobName`(Task 6 触发迁移用)

- [ ] **Step 1: 写 `infra/container-app.bicep`**

```bicep
@description('Container App 名称。')
param name string
param location string
param environmentId string

@description('用户分配托管标识的资源 ID。同时用于拉镜像与访问 Blob。')
param identityId string

@description('完整镜像引用,形如 crunidocsxxx.azurecr.io/unidocs/azure-markdown:abc1234。')
param image string
param acrLoginServer string

param targetPort int
@description('true = 公网 ingress;false = 仅环境内可达。')
param external bool
param minReplicas int
param maxReplicas int

@description('明文环境变量,形如 [{ name: "PORT", value: "8788" }]。')
param extraEnv array = []

@secure()
param databaseUrl string
@secure()
param internalToken string

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      // ACR 的 admin 账号被策略禁用,拉镜像只能走托管标识 + AcrPull。
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'internal-token'
          value: internalToken
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(
            [
              {
                name: 'DATABASE_URL'
                secretRef: 'database-url'
              }
              {
                name: 'INTERNAL_TOKEN'
                secretRef: 'internal-token'
              }
            ],
            extraEnv
          )
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
```

- [ ] **Step 2: 写 `infra/main.bicep`**

```bicep
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param nameSuffix string = uniqueString(resourceGroup().id)

@description('镜像 tag,由部署脚本传入(git short sha)。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

@description('Cloudflare CAS worker 自身的基地址(不是 gateway 的)。过渡形态,阶段 4 删除。')
param casBaseUrl string

@secure()
param pgAdminPassword string

@secure()
param internalToken string

param pgAdminUser string = 'unidocs'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-unidocs-dev'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'crunidocs${nameSuffix}'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'stunidocs${nameSuffix}'
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: 'log-unidocs-dev'
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-unidocs-${nameSuffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    // 17:与本订阅现有 8 台 Flexible Server 一致。
    version: '17'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'unidocs'
}

// 设计 §4.4:显式的 dev 期妥协。0.0.0.0-0.0.0.0 是 Azure 约定的
// "允许 Azure 服务和资源访问此服务器" —— 放行整个 Azure 平台的出站
// 流量(不只本订阅),但不放行公网任意来源。唯一的实际屏障是强随机
// 管理员密码。本设计刻意不依赖"消费型 Container Apps 环境有稳定的
// 可枚举出口 IP"这一未验证前提。要做 IP 级限制需换环境形态(工作负载
// 配置文件 + VNet + NAT 网关或私有端点),那是前置条件而非延后加固。
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// sslmode=require:Flexible Server 强制 TLS,而 createPool() 不设 ssl
// 选项,行为完全由连接串决定(设计 §6.3 —— 这条需要实测确认)。
var databaseUrl = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/unidocs?sslmode=require'

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-unidocs-dev'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

var blobAccountUrl = storage.properties.primaryEndpoints.blob

// 用户分配的托管标识必须显式告诉 DefaultAzureCredential 用哪个身份。
// 缺了它容器能启动、能通过健康检查,失败推迟到第一次 Blob 操作 ——
// azure-sdk 的 resolveBlobConfig() 因此把它作为启动期硬性要求。
var blobEnv = [
  {
    name: 'BLOB_ACCOUNT_URL'
    value: blobAccountUrl
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: identity.properties.clientId
  }
]

module markdownApp 'container-app.bicep' = {
  name: 'markdown-app'
  params: {
    name: 'ca-unidocs-markdown'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-markdown:${imageTag}'
    targetPort: 8788
    external: false
    // minReplicas = 2 是刻意的:阶段 3 证明的是多副本拓扑下的并发
    // 正确性(条件写 + (doc_type, doc_id, version) 主键),生产上跑
    // 单副本等于把那份保证退回未验证状态。
    minReplicas: 2
    maxReplicas: 5
    databaseUrl: databaseUrl
    internalToken: internalToken
    extraEnv: concat([
      {
        name: 'PORT'
        value: '8788'
      }
    ], blobEnv)
  }
}

module docxApp 'container-app.bicep' = {
  name: 'docx-app'
  params: {
    name: 'ca-unidocs-docx'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-docx:${imageTag}'
    targetPort: 8789
    external: false
    minReplicas: 2
    maxReplicas: 5
    databaseUrl: databaseUrl
    internalToken: internalToken
    extraEnv: concat([
      {
        name: 'PORT'
        value: '8789'
      }
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
    ], blobEnv)
  }
}

module gatewayApp 'container-app.bicep' = {
  name: 'gateway-app'
  params: {
    name: 'ca-unidocs-gateway'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-gateway:${imageTag}'
    targetPort: 8787
    external: true
    minReplicas: 1
    maxReplicas: 3
    databaseUrl: databaseUrl
    internalToken: internalToken
    // 网关不碰 Blob,所以没有 blobEnv。它经内部 ingress 的 443 访问
    // 两个 doc type worker —— 不是容器端口,ingress 负责映射。
    // 这条路径复用 azure-gateway/src/main.ts 已有的 {TYPE}_WORKER_URL
    // 解析,不需要注册表服务。
    extraEnv: [
      {
        name: 'PORT'
        value: '8787'
      }
      {
        name: 'MARKDOWN_WORKER_URL'
        value: 'https://${markdownApp.outputs.fqdn}'
      }
      {
        name: 'DOCX_WORKER_URL'
        value: 'https://${docxApp.outputs.fqdn}'
      }
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
    ]
  }
}

// 迁移只需要 DATABASE_URL:migrate-cli.ts 只调 createPool() 与
// runMigrations(pool),从不构造 BlobServiceClient。
resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-unidocs-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
        }
      ]
    }
  }
}

output gatewayFqdn string = gatewayApp.outputs.fqdn
output migrateJobName string = migrateJob.name
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
```

- [ ] **Step 3: 语法校验**

```bash
az bicep build --file infra/main.bicep --stdout > /dev/null && echo "bicep ok"
```

预期:打印 `bicep ok`。

- [ ] **Step 4: 确认没有把密钥泄进部署历史**

```bash
grep -n "@secure()" infra/main.bicep infra/container-app.bicep
grep -n "output" infra/main.bicep infra/container-app.bicep
```

`pgAdminPassword` 与 `internalToken` 在两个文件里都必须带 `@secure()`;所有 `output` 里**不得**出现密码、连接串或 token。若 `databaseUrl` 出现在任何 output 中,删掉它 —— 那会把密码写进部署历史。

- [ ] **Step 5: Commit**

```bash
git add infra/main.bicep infra/container-app.bicep
git commit -m "feat(infra): main Bicep —— Postgres、Container Apps 环境、三个 App 与迁移 Job"
```

Task 5 到此不做 `what-if`:它需要镜像已经推到 ACR(否则 `imageTag` 无从取值),那属于 Task 6。

---

### Task 6: `scripts/azure-deploy.mjs`

实现设计 §8。

**背景**:Bicep 不负责跑数据库迁移(基础设施变更与数据变更分离)。这个脚本按序编排七步,并且**可重复执行** —— 第二次跑不得重置 Postgres 密码,`what-if` 不得有变更。

密码必须是 URL 安全的:它会被拼进 `postgres://user:password@host/db`,含 `/` `+` `@` 会破坏连接串。

**Files:**
- Create: `scripts/azure-deploy.mjs`
- Create: `scripts/azure-deploy.test.mjs`
- Modify: `package.json`(`test:local` 加入新测试)

**Interfaces:**
- Consumes: Task 3 的镜像构建命令、Task 4/5 的 Bicep 与其 output 名
- Produces:导出纯函数 `imageRef(loginServer, service, tag)`、`generateSecret(byteLength)`、`parseArgs(argv)` 供测试;导出 `main()` 供 CLI

- [ ] **Step 1: 写失败的测试**

新建 `scripts/azure-deploy.test.mjs`:

```js
/**
 * 部署脚本里能被纯逻辑覆盖的部分。其余(az 调用、docker 构建)由 Task 8
 * 的真实部署验收。
 */
import { describe, expect, test } from "vitest";
import { IMAGES, generateSecret, imageRef, parseArgs } from "./azure-deploy.mjs";

describe("imageRef", () => {
  test("拼出完整的 ACR 镜像引用", () => {
    expect(imageRef("crunidocsabc.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      "crunidocsabc.azurecr.io/unidocs/azure-markdown:a1b2c3d",
    );
  });
});

describe("IMAGES", () => {
  // 迁移镜像是唯一一个「构建参数」与「镜像名」不同名的:构建参数是
  // 工作区包名 azure-sdk,镜像名是 infra/main.bicep 引用的 azure-migrate。
  // 传错会让 main 部署时拉不到镜像,而那是个部署到一半才暴露的错误。
  test("迁移镜像的构建参数与镜像名刻意不同", () => {
    const migrate = IMAGES.find((i) => i.name === "azure-migrate");
    expect(migrate).toBeDefined();
    expect(migrate.service).toBe("azure-sdk");
    expect(migrate.entry).toBe("dist/migrate-cli.js");
  });

  test("三个服务镜像的构建参数与镜像名一致,入口都是 dist/main.js", () => {
    for (const name of ["azure-gateway", "azure-markdown", "azure-docx"]) {
      const img = IMAGES.find((i) => i.name === name);
      expect(img.service).toBe(name);
      expect(img.entry).toBe("dist/main.js");
    }
  });
});

describe("generateSecret", () => {
  // 密码会被拼进 postgres://user:password@host/db。base64 标准字母表里的
  // `/` `+` `=` 都会破坏连接串,所以必须是 URL 安全字母表且无填充。
  test("只含 URL 安全字符", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecret(24)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("每次都不同", () => {
    expect(generateSecret(24)).not.toBe(generateSecret(24));
  });

  test("长度随字节数增长", () => {
    expect(generateSecret(48).length).toBeGreaterThan(generateSecret(24).length);
  });
});

describe("parseArgs", () => {
  test("默认值指向设计里确定的订阅、资源组与位置", () => {
    const args = parseArgs([]);
    expect(args.subscription).toBe("24c9acbd-c2f5-4ef9-b9a2-486d90208b3e");
    expect(args.resourceGroup).toBe("rg-unidocs-dev");
    expect(args.location).toBe("southeastasia");
  });

  test("命令行参数覆盖默认值", () => {
    const args = parseArgs(["--resource-group", "rg-other", "--location", "japaneast"]);
    expect(args.resourceGroup).toBe("rg-other");
    expect(args.location).toBe("japaneast");
  });

  test("--cas-base-url 是必填的,缺失时报错点名它", () => {
    expect(() => parseArgs(["--require-cas"])).toThrow(/--cas-base-url/);
  });

  test("未知参数响亮失败,而不是被忽略", () => {
    expect(() => parseArgs(["--typo-flag", "x"])).toThrow(/--typo-flag/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run scripts/azure-deploy.test.mjs
```

预期:FAIL,模块不存在。

- [ ] **Step 3: 写 `scripts/azure-deploy.mjs`**

脚本结构如下。`run()` 用 `node:child_process` 的 `spawnSync`,`stdio: "inherit"`,非零退出即抛错并中止 —— 任何一步失败都不得继续。

```js
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

const DEFAULTS = {
  subscription: "24c9acbd-c2f5-4ef9-b9a2-486d90208b3e",
  resourceGroup: "rg-unidocs-dev",
  location: "southeastasia",
};

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
```

`main()` 的七步实现要点(全部写实,不留占位):

1. **预检**:`az account set --subscription <id>`;`az provider show -n Microsoft.App --query registrationState -o tsv`,若不是 `Registered` 则 `az provider register -n Microsoft.App --wait` 并复查。`az group create -n <rg> -l <loc> -o none`(幂等)。
2. **bootstrap**:先 `az deployment group what-if -g <rg> -f infra/bootstrap.bicep`(输出给人看),再 `az deployment group create -g <rg> -f infra/bootstrap.bicep -n bootstrap -o json`,解析 `properties.outputs` 拿 `acrName`、`acrLoginServer`、`keyVaultName`、`identityClientId`、`blobAccountUrl`。
3. **播种密钥**:对 `pg-admin-password`(48 字节)与 `internal-token`(32 字节)各做一次:
   ```
   az keyvault secret show --vault-name <kv> -n <name> --query value -o tsv
   ```
   成功则用返回值;失败(不存在)则 `generateSecret()` 后 `az keyvault secret set --vault-name <kv> -n <name> --value <v> -o none`,再用生成值。**读到的值只放在内存变量里,绝不写文件、绝不 `console.log`。**
4. **构建并推**:`tag = git rev-parse --short HEAD`。对 `IMAGES` 每一项 `item`:
   ```
   const ref = imageRef(loginServer, item.name, tag);
   docker build --build-arg SERVICE=<item.service> --build-arg ENTRY=<item.entry> -t <ref> .
   ```
   **注意 `item.service` 与 `item.name` 对迁移镜像是不同的两个值**:构建参数是 `azure-sdk`(工作区包名),镜像名是 `azure-migrate`(`infra/main.bicep` 里引用的名字)。传错会让 main 部署时拉不到镜像。
   然后 `az acr login -n <acrName>`(走 az 身份,不是 admin 密码),再 `docker push <ref>`。`--skip-build` 跳过构建与推送,只用已有 tag。
5. **main**:先 `what-if` 再 `create`,参数:
   ```
   az deployment group create -g <rg> -f infra/main.bicep -n main -o json \
     --parameters imageTag=<tag> casBaseUrl=<url> pgAdminPassword=<pw> internalToken=<token>
   ```
   解析 output 拿 `gatewayFqdn`、`migrateJobName`。
6. **迁移**:`az containerapp job start -g <rg> -n caj-unidocs-migrate -o json` 拿执行名,然后每 5 秒轮询
   ```
   az containerapp job execution show -g <rg> --job-name caj-unidocs-migrate -n <exec> --query properties.status -o tsv
   ```
   直到 `Succeeded`(继续)或 `Failed`(打印 `az containerapp job logs show` 的输出并以非零退出)。超时上限 10 分钟。
7. **冒烟**:`node scripts/azure-smoke.mjs --gateway https://<gatewayFqdn>`,非零退出即整体失败。

最后 `console.log` 打印网关 URL。

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm exec vitest run scripts/azure-deploy.test.mjs
```

预期:全部 PASS。

- [ ] **Step 5: 确认脚本不会把密钥打进日志**

```bash
grep -n "console.log\|console.error" scripts/azure-deploy.mjs
```

逐条看:任何一条都不得输出密码、token 或完整连接串。若某处为了排错想打印,改成只打印变量名。

- [ ] **Step 6: 把测试加进 `test:local`**

根 `package.json` 的 `test:local`,在 `scripts/bundle-deps.test.mjs` 之后插入 `scripts/azure-deploy.test.mjs`。

- [ ] **Step 7: Commit**

```bash
git add scripts/azure-deploy.mjs scripts/azure-deploy.test.mjs package.json
git commit -m "feat(azure): 可重复执行的部署编排脚本"
```

---

### Task 7: `scripts/azure-smoke.mjs`

实现设计 §10 第 5 条。

**背景 —— 真实的 wire 形状(不要凭 CLAUDE.md 里的记载写,那份是过时的)**:

路由是 `/users/{userId}/docs/{docType}/{docId}/{method}`,中间有一个 `docs` 命名空间段(`packages/server-core/src/gateway-handler.ts:44,61`)。

| 动作 | 请求 |
|---|---|
| 建文档 | `POST /users/{u}/docs/{type}/`,请求头 `X-Doc-Id: {id}`,**无 body** → `{ success: true }` |
| 应用 | `POST /users/{u}/docs/{type}/{id}/apply`,body `{ baseVersion, description, operations: [{ kind, payload }] }` → `{ success: true, version }` |
| 查询 | `POST /users/{u}/docs/{type}/{id}/query`,body `{ kind }` → `{ success: true, data }` |
| 导出 | `GET /users/{u}/docs/{type}/{id}/export` → 字节流 |
| CAS 上传 | `POST /users/{u}/cas/nodes/{hash}`,头 `Content-Type` 与 `X-CAS-Lease-Duration`,body 为原始字节 → `{ ready: true }` |

markdown 的操作是 `setContent`(payload `{ content }`),查询是 `getContent`。docx 的操作是 `appendParagraph`(payload `{ text }`,可选 `{ options: { style } }`)与 `insertImage`(payload `{ hash, widthPx, altText }`),查询是 `getText` 与 `getImages`。

内容哈希用仓库已有的 `scripts/cas-digest.mjs`:`node scripts/cas-digest.mjs image/png < file`。测试图片用现成的 `tests/bootstrap/create-new-docx/edit/image/tiny.png`。

**重跑安全**:文档 id 每次运行随机生成,否则第二次冒烟会在建文档处撞 `DocExists`。设计 §10 第 6 条要求重跑部署后冒烟仍然全绿。

**Files:**
- Create: `scripts/azure-smoke.mjs`

**Interfaces:**
- Consumes: Task 6 传入的 `--gateway https://<fqdn>`
- Produces: 进程退出码 —— 0 表示全部断言通过,非 0 表示失败并已打印失败的那条

- [ ] **Step 1: 写 `scripts/azure-smoke.mjs`**

脚本用 `node:fs` 读图片、全局 `fetch` 发请求,不引入任何依赖。骨架:

```js
/**
 * 对已部署的公网网关跑设计 §10 第 5 条的验收断言。
 *
 * 文档 id 每次运行随机:设计 §10 第 6 条要求重跑部署之后冒烟仍然全绿,
 * 固定 id 会在第二次运行时撞 DocExists。
 *
 * 用法:
 *   node scripts/azure-smoke.mjs --gateway https://ca-unidocs-gateway.<region>.azurecontainerapps.io
 *   node scripts/azure-smoke.mjs --gateway http://127.0.0.1:41787 --skip-cas
 *
 * `--skip-cas` 跳过第 3 组(docx 图片路径)。它只用于对本地 Azure 栈
 * 验证本脚本自身的 wire 形状 —— 本地栈默认没有 casBaseUrl。真实部署的
 * 验收**不得**带这个开关:第 3 组正是跨云 CAS 接线的唯一证明。
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUN = randomBytes(4).toString("hex");
const USER = `smoke-${RUN}`;

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
```

必须实现的断言,逐条对应设计 §10 第 5 条:

1. **markdown 全链路**
   - 建文档 → `success === true`
   - `apply` `baseVersion: 1`,一个 `setContent` 操作 → `success === true && version === 2`
   - `query` `getContent` → `data` 含刚写入的正文
   - `export` → HTTP 200 且响应体非空
2. **docx 全链路**
   - 建文档 → `success === true`
   - `apply` `baseVersion: 1`,一个 `appendParagraph`(`{ text: "smoke" }`)→ `version === 2`
   - `query` `getText` → `data` 含 `smoke`
   - `export` → 前两字节是 `0x50 0x4b`(zip 魔数)且长度大于 0
3. **docx 图片路径经 Cloudflare CAS**(设计 §10 明确要求的跨云接线证明)
   - 用 `tests/bootstrap/create-new-docx/edit/image/tiny.png` 算哈希(把 `scripts/cas-digest.mjs` 的算法以 `import` 方式复用,不要重新实现)
   - `POST /users/{u}/cas/nodes/{hash}`,头 `Content-Type: image/png`、`X-CAS-Lease-Duration: 900000`,body 为图片字节 → `ready === true`
   - `apply` 一个 `insertImage`(`{ hash, widthPx: 16, altText: "dot" }`)→ `version === 3`
   - `query` `getImages` → `data.length === 1 && data[0].format === "png" && data[0].altText === "dot"`
   - `export` → 仍是合法 zip
4. **并发冲突**
   - 对同一 docx 文档再发一次 `baseVersion: 1` 的 `apply`(此时实际版本已是 3)
   - 断言 HTTP 状态是 **409**,且响应体里带当前 `version`(值为 3)

结尾:

```js
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall smoke assertions passed");
```

**注意**:`check()` 不要在第一条失败时就退出 —— 一次跑完全部断言、把所有失败一起报出来,比一条一条挤牙膏有用得多。

- [ ] **Step 2: 先对本地 Azure 栈验证脚本本身是对的**

在真部署之前,先用本地栈确认脚本的 wire 形状没写错 —— 否则真部署失败时分不清是部署错了还是冒烟脚本错了。

```bash
node -e "import('./scripts/azure-runtime.mjs').then(m=>m.startAzureRuntime({docTypes:['markdown','docx']}).then(r=>{console.log(r.urls.gateway);}))" &
```

等它打印网关地址(约 30–60 秒),然后:

```bash
node scripts/azure-smoke.mjs --gateway http://127.0.0.1:41787 --skip-cas
```

预期:退出码 0,除第 3 组外全部通过。本地栈默认没有 `casBaseUrl`,所以第 3 组必须用 `--skip-cas` 跳过 —— 不带这个开关时它会失败并让整个脚本退出 1,那会掩盖其余断言是否真的通过。

若要连第 3 组一起在本地验证,按 `scripts/azure-docx-image.test.mjs` 的做法先起一个 Miniflare 栈提供 CAS,把它的 CAS 地址传给 `startAzureRuntime`,然后不带 `--skip-cas` 跑。

跑完记得把后台进程停掉。

- [ ] **Step 3: Commit**

```bash
git add scripts/azure-smoke.mjs
git commit -m "feat(azure): 部署后冒烟脚本"
```

---

### Task 8: 真实部署、验收与文档

实现设计 §10 的全部七条验收标准。

**背景**:前七个任务都没有在云上建过计算资源。这个任务第一次把全链路跑通,并逐条核对验收标准。这是唯一会产生持续费用的任务(粗估 $85–105/月)。

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-22-azure-cloud-deployment-design.md`(仅当实测推翻了设计里的某条假设时)

**Interfaces:**
- Consumes: 前七个任务的全部产物

- [ ] **Step 1: 确认 Cloudflare CAS worker 的基地址**

docx 的图片路径要经它。它必须是 **CAS worker 自身**的基地址,不是 gateway 的 —— `CasClient` 的 `updateRootRefs` 打的是 `${origin}/_internal/root-refs`,gateway 只路由 `/users/...`,不代理 `/_internal/*`。

```bash
cd packages/cloudflare-cas && npx wrangler deployments list 2>&1 | head -20
```

拿到形如 `https://unidocs-cas.<account>.workers.dev` 的地址。若 CAS worker 尚未部署到 Cloudflare,先 `npx wrangler deploy` 部署它 —— 没有它 docx 上不了云。

- [ ] **Step 1b: 先在宿主机跑一次 `pnpm build`(部署的隐式前置条件)**

```bash
pnpm build
test -f packages/cas/dist/index.js && echo "cas dist ok"
```

**为什么必须显式做这一步**:`scripts/azure-smoke.mjs`(部署脚本的第 7 步)从 `packages/cas/dist/index.js` import CAS 哈希算法 —— 这是仓库既有惯例,`scripts/cas-digest.mjs` 同样如此。而 `scripts/azure-deploy.mjs` **全程不在宿主机跑 `pnpm build`**:它只构建 docker 镜像,而那是在容器内编译的(`.dockerignore` 排除了 `**/dist`)。

后果:在干净检出(或 `pnpm clean` 之后)直接跑部署,会一路成功到第 7 步,**在十几分钟的镜像构建和真实资源创建之后**才以 `ERR_MODULE_NOT_FOUND` 失败。

这是 `azure-deploy.mjs` 的 preflight 应该自检的东西(记入最终评审的分诊清单);在它补上之前,这一步是人工前置条件。

- [ ] **Step 2: 跑第一次完整部署**

```bash
node scripts/azure-deploy.mjs --cas-base-url <上一步拿到的地址> 2>&1 | tee /tmp/azure-deploy-first.log
```

(`tee` 是为了 Step 2b 能回头搜这份输出里有没有密钥回显。)

这一步会:注册 RP(若未注册)、建资源组、跑 bootstrap、播种密钥、构建推送四个镜像、跑 main、触发迁移、跑冒烟。

**预期**:全部通过,最后打印网关 URL。

若在迁移 Job 处失败,先看它的日志:

```bash
az containerapp job logs show -g rg-unidocs-dev --name caj-unidocs-migrate --container migrate
```

若失败原因是 TLS/`sslmode`(设计 §6.3 标注为待实测的那条),**这是已知的可能性,不是意外**:退路是在 `packages/azure-sdk/src/pool.ts` 的 `createPool()` 中按连接串里的 `sslmode` 显式构造 `ssl` 选项。改完回到 Task 1 的验证步骤重跑 `pnpm test` 与 `pnpm test:local`,再重跑本步。

- [ ] **Step 2b: 人工过一遍首次部署的输出,确认没有密钥回显**

`scripts/azure-deploy.mjs` 已经保证**它自己**不会把密钥打进日志(带密钥的调用点显式传不含密钥的 `label`,顶层 `catch` 只输出 `err.message`)。但它用 `stdio: "inherit"` 与 `process.stderr.write(result.stderr)` 原样透传 `az` 自身的输出,而 `az` 在某些失败场景(ARM 部署校验失败、Key Vault 权限错误)下会不会把传入的参数值回显出来,脚本控制不了 —— 这是 Task 6 评审标记的残余风险。

Step 2 的完整输出里搜一遍:

```bash
grep -nE "pgAdminPassword=[^ ]|internalToken=[^ ]|postgres://[^ ]*:[^@]" /tmp/azure-deploy-first.log || echo "clean"
```

(Step 2 执行时把输出 `tee` 到 `/tmp/azure-deploy-first.log`。)

预期:`clean`。若命中,说明 `az` 确实会回显,需要在 `run()` / `capture()` 里对带 `label` 的调用点做 stderr 过滤,并**轮换已泄漏的密钥**(删掉 Key Vault 里对应的 secret 让脚本重新生成,再重跑部署)。

- [ ] **Step 3: 验收第 1、2 条 —— 本地栈与 e2e 树未被破坏**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm test:local
```

预期:全绿。这条证明设计 §6.1 的改动保住了连接串分支。

- [ ] **Step 4: 验收第 3 条 —— 资源齐全**

```bash
az resource list -g rg-unidocs-dev --query "[].{name:name,type:type}" -o table
```

对照设计 §4.1 的资源清单逐项核对:ACR、Log Analytics、Key Vault、Storage、UAMI、Postgres、Container Apps 环境、三个 Container App、迁移 Job。

- [ ] **Step 5: 验收第 4 条 —— 表结构正确**

```bash
az containerapp job logs show -g rg-unidocs-dev --name caj-unidocs-migrate --container migrate | tail -5
```

预期:含 `migrations applied`。

- [ ] **Step 6: 验收第 5 条 —— 冒烟(已在 Step 2 内跑过,这里单独复跑一次确认可重复)**

```bash
GW=$(az containerapp show -g rg-unidocs-dev -n ca-unidocs-gateway --query properties.configuration.ingress.fqdn -o tsv)
node scripts/azure-smoke.mjs --gateway "https://$GW"
```

预期:`all smoke assertions passed`,退出码 0。

- [ ] **Step 7: 验收第 6 条 —— 幂等**

```bash
node scripts/azure-deploy.mjs --cas-base-url <地址> 2>&1 | tee /tmp/second-deploy.log
```

三条都要成立:
1. 两次 `what-if` 输出里没有 `Create` / `Delete` / `Modify`(`Modify` 也不行 —— "每次都会变一点"不是幂等)
2. 冒烟仍然全绿
3. Postgres 密码未被重置 —— 由第 2 条间接证明(密码若变了,Container App 的连接串与实际密码就对不上,冒烟会失败)

若 `what-if` 有 `Modify`,查明是哪个属性并修 Bicep;不要接受"这个属性 Azure 每次都会改"这种解释,除非能指出具体是哪个只读属性被误写成了可写参数。

- [ ] **Step 7b: 核查密钥没有明文进入部署历史**

Bicep 评审提出、但在不部署的情况下无法确认的一项:`main.bicep` 的 `migrateJob` 把由 `@secure() pgAdminPassword` 拼出的 `var databaseUrl` **直接写进外层模板的资源属性**(三个 Container App 走的是模块边界,`expressionEvaluationOptions.scope: "inner"`,属已知安全模式;Job 没有这层边界)。Container Apps 的 `secrets[].value` 在设计上就是承载敏感值的字段,大概率被 RP 标注为敏感,但那个标注状态查不到,只能部署后实测。

```bash
az deployment operation group list -g rg-unidocs-dev -n main -o json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('HIT' if 'postgres://' in json.dumps(d) else 'clean')"
```

预期:`clean`。

若打印 `HIT`,说明密码明文落进了部署历史。**这是必须修的安全问题,不是可接受风险**:把 `migrateJob` 也改成走一个模块(与 `container-app.bicep` 同样的模式,让 secure 值跨越模块边界),重新部署,并**轮换 Postgres 密码**(删除 Key Vault 里的 `pg-admin-password` secret 让部署脚本重新生成,再重跑部署)—— 已经泄进历史的那个密码不能继续用。

- [ ] **Step 8: 验收第 7 条 —— 没有绕开策略**

```bash
az acr show -n $(az acr list -g rg-unidocs-dev --query "[0].name" -o tsv) --query adminUserEnabled -o tsv
az storage account show -g rg-unidocs-dev -n $(az storage account list -g rg-unidocs-dev --query "[0].name" -o tsv) --query allowSharedKeyAccess -o tsv
```

两条都必须输出 `false`。任一为 `true` 说明部署是靠绕开策略才成功的,该结果不算通过。

- [ ] **Step 9: 写 README 的部署章节**

在 `README.md` 增加一节 "Azure 部署",内容必须包含:

- 前置条件:`az` 已登录且有目标订阅权限、Docker 可用、Cloudflare CAS worker 已部署并知道其基地址
- 一条命令:`node scripts/azure-deploy.mjs --cas-base-url <url>`
- 七步都做了什么(照设计 §8 的顺序简述)
- 拓扑简图与资源清单(照设计 §4.1)
- **本轮明确不做的四项**:CI/CD、`azure-cas`、`azure-markdown`/`azure-docx` 合并、VNet 私有端点
- **一条必须写进去的知情提示**:docx 依赖 Cloudflare CAS worker,因此**当前的部署形态不可私有化交付**,要等 `azure-cas` 落地
- 成本粗估与 `minReplicas` 这个旋钮的含义(设计 §4.2:doc type 的 min 2 是为了让多副本并发正确性在生产上持续被验证,下调即放弃该验证)
- 拆除方式:`az group delete -n rg-unidocs-dev --yes`

不要把任何密钥、连接串、订阅 ID 之外的敏感值写进 README。

- [ ] **Step 10: 若实测推翻了设计里的任何假设,更新设计文档**

特别检查这两条:

- §6.3 的 `sslmode=require`:实测结果是什么?若需要显式 `ssl` 选项,把 §6.3 从"待实测"改成结论,并记下实际做法
- §4.4 的 `0.0.0.0` 防火墙规则:是否被策略拒绝?若被拒,按 §4.4 写的翻转条件,VNet + 私有端点变成前置条件,**停下来报告**而不是自行改方案

- [ ] **Step 11: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-22-azure-cloud-deployment-design.md
git commit -m "docs(azure): 部署说明与实测校正"
```
