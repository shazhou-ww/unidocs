# Azure psd 支持与 doc type 声明收敛 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在 6 处的 doc type 硬编码收敛到各包的 `azure.service.json`,然后新建 `packages/azure-psd`,使 psd 在本地 Azure 栈可运行、在云上可部署。

**Architecture:** 每个 `packages/azure-*/azure.service.json` 是该 doc type 的唯一声明;新模块 `stacks/azure/doc-types.mjs` 扫描并校验它们,产出一张表;本地栈(`ports.mjs`/`runtime.mjs`/`dev.mjs`)、部署脚本(`deploy.mjs`/`smoke.mjs`)、Bicep 模板(`platform.bicep`/`gateway.bicep`)全部从这张表展开,不再各存一份。

**Tech Stack:** Node 24 ESM(`.mjs`,无 TypeScript)、Vitest、Bicep 0.46.1、Azure CLI、esbuild、Miniflare、pnpm 11 workspace。

设计文档:`docs/superpowers/specs/2026-08-26-azure-psd-and-doc-type-convergence-design.md`
分支:`feat/azure-psd`,基于 `d01afd0`

## Global Constraints

- `stacks/azure/local/ports.mjs` **必须保持零依赖** —— 连 `node:` 内置模块都不许 import。理由写在该文件的模块注释里:`dev.mjs` 要在 import 任何重家伙(pg、`@azure/storage-blob`、esbuild、Miniflare)之前算出端口并探测占用,而纯逻辑也才能脱离 Docker 单测。读文件的逻辑放 `stacks/azure/doc-types.mjs`,不要放进 `ports.mjs`。
- `stacks/azure/deploy/migrate-job.bicep` **必须保持独立 module**,不得并入 `platform.bicep`。它存在的唯一理由是模块边界:`databaseUrl` 由 `@secure() pgAdminPassword` 拼出,直接落在外层模板的资源属性上会让 `az deployment group what-if` 对 Create 变更打印明文连接串,而部署脚本用 `stdio:"inherit"` 透传并 `tee` 进日志。
- `gateway.bicep` 里 **`json(docAccessKeysJson)` 必须内联进 lambda**,不得先存进 `var`。两种写法都编译得过,但 `var` 版本会在外层模板产生一个持有密钥派生值的变量。见设计 §3.3 的对照表。
- **不得把任何密钥、连接串写进文件或日志。** 部署脚本已有的 `label` 机制(显式传 label,绝不落回 `args.join(" ")`)必须保持。
- npm 公网源被 SNI 拦截:任何 `pnpm install` 必须带 `--registry=https://repo.huaweicloud.com/repository/npm/`(命令行参数,不是环境变量)。
- **不要执行任何 `az` 写操作**(`deployment group create`、`acr build`、`keyvault secret set`)。当前订阅角色只有 Reader。只读的 `az bicep build` 可以用。
- **不要删除或清理任何 Docker 镜像/容器** —— 本机有其他项目的 `postgres:18` 和 `redis:8` 在跑。
- 端口取值:psd 的 `targetPort` 是 **8790**(与 Cloudflare 侧一致,`CAS_PORT` 是 8791),`localPortBase` 是 **41820**,`defaultPort` 是 **41820**。
- 每个 `tests/integration/` 测试文件自带专用端口段(既有:18787 / 28787 / 29787 / 31787 / 32787),新增的测试必须照办,不得用默认端口。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `stacks/azure/doc-types.mjs` | 扫描 `packages/azure-*/azure.service.json`,校验,产出规范化的 doc type 表。唯一读文件的地方。 |
| `tests/unit/scripts/azure-doc-types.test.mjs` | 上面那个模块的单测(字段校验、点名报错、网关那份被排除) |
| `tests/unit/scripts/azure-bicep-secrets.test.mjs` | 对 `az bicep build` 产物断言 securestring 不变式 |
| `packages/azure-psd/{package.json,tsconfig.json,azure.service.json}` | psd 的 Azure 包 |
| `packages/azure-psd/src/main.ts` | 入口,只有 docType 与 defaultPort 与另两个不同 |
| `packages/azure-psd/scripts/bundle.mjs` | esbuild 打包(与 azure-docx 同形) |
| `tests/integration/azure/azure-psd.test.mjs` | psd 在本地 Azure 栈上的端到端 |

**修改**

| 文件 | 改什么 |
|---|---|
| `packages/azure-{markdown,docx}/azure.service.json` | 补 `localPortBase` / `needsCas` |
| `stacks/azure/local/ports.mjs` | 删 `AZURE_DOC_TYPE_PORT_BASE`,`azurePortLayout` 改收 `portBases` |
| `stacks/azure/local/runtime.mjs` | 删 `SUPPORTED_DOC_TYPES`,改查表 |
| `scripts/dev.mjs` | 无参默认值改用 Azure 的表;`includes("docx")` 改用 `needsCas`;web 端口偏移 |
| `stacks/azure/deploy/platform.bicep` | 数据库与迁移 Job 收成循环 |
| `stacks/azure/deploy/gateway.bicep` | 两个 key 参数 → `docTypes` + `docAccessKeysJson` |
| `stacks/azure/deploy/deploy.mjs` | 25 处字面量展开;适配 platform 的双 output |
| `stacks/azure/deploy/smoke.mjs` | `KNOWN_DOC_TYPES` 改查表 |
| `tests/unit/scripts/azure-ports.test.mjs` | 适配 `azurePortLayout` 新签名 |
| `tsconfig.json` | 加 `packages/azure-psd` reference |
| `README.md` | 「新增 doc type」步骤改写 |

---

### Task 1: `readAzureDocTypes()` 与 `azure.service.json` 的两个新字段

**Files:**
- Create: `stacks/azure/doc-types.mjs`
- Create: `tests/unit/scripts/azure-doc-types.test.mjs`
- Modify: `packages/azure-markdown/azure.service.json`
- Modify: `packages/azure-docx/azure.service.json`

**Interfaces:**
- Produces: `readAzureDocTypes(repoRoot?: string) => Record<string, AzureDocType>`,其中
  `AzureDocType = { docType: string, targetPort: number, localPortBase: number, minReplicas: number, maxReplicas: number, needsCas: boolean }`。
  返回对象的键按 `docType` 字典序排列。
- Produces: `azureDocTypePortBases(table) => Record<string, number>` —— 从表提取 `{ docType: localPortBase }`,给 Task 2 的 `azurePortLayout({ portBases })` 用。
- 本任务**不改任何消费方**,`ports.mjs` / `runtime.mjs` / `deploy.mjs` 一行不动。

- [ ] **Step 1: 先给两份既有 json 补字段**

`packages/azure-markdown/azure.service.json` 整份改成:

```json
{ "docType": "markdown", "targetPort": 8788, "localPortBase": 41800, "minReplicas": 2, "maxReplicas": 5, "needsCas": false }
```

`packages/azure-docx/azure.service.json` 整份改成:

```json
{ "docType": "docx", "targetPort": 8789, "localPortBase": 41810, "minReplicas": 2, "maxReplicas": 5, "needsCas": true }
```

`packages/azure-gateway/azure.service.json` **不要动** —— 它没有 `docType` 字段,这正是它被排除在 doc type 表之外的依据。

- [ ] **Step 2: 写失败的测试**

新建 `tests/unit/scripts/azure-doc-types.test.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { azureDocTypePortBases, readAzureDocTypes } from "../../../stacks/azure/doc-types.mjs";

/** 造一个只有 packages/azure-* 的假仓库根,用来测校验分支——真仓库里
 *  每份 json 都是合法的,构造不出缺字段的情形。 */
const roots = [];
function fakeRepo(services) {
  const root = mkdtempSync(join(tmpdir(), "azure-doc-types-"));
  roots.push(root);
  for (const [dir, json] of Object.entries(services)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "azure.service.json"), JSON.stringify(json));
  }
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const MARKDOWN = {
  docType: "markdown", targetPort: 8788, localPortBase: 41800,
  minReplicas: 2, maxReplicas: 5, needsCas: false,
};
const DOCX = {
  docType: "docx", targetPort: 8789, localPortBase: 41810,
  minReplicas: 2, maxReplicas: 5, needsCas: true,
};

describe("readAzureDocTypes", () => {
  test("真仓库里读出 markdown 与 docx,字段与 json 一致", () => {
    const table = readAzureDocTypes();
    expect(Object.keys(table)).toContain("markdown");
    expect(Object.keys(table)).toContain("docx");
    expect(table.markdown.localPortBase).toBe(41800);
    expect(table.docx.needsCas).toBe(true);
    expect(table.markdown.needsCas).toBe(false);
  });

  // 网关那份没有 docType 字段——它不是一个 doc type,是 --gateway 自己的
  // 参数。凭这一点被排除,不要改成按目录名硬编码排除。
  test("没有 docType 字段的 azure.service.json 被排除", () => {
    const root = fakeRepo({
      "azure-markdown": MARKDOWN,
      "azure-gateway": { external: true, targetPort: 8787, minReplicas: 1, maxReplicas: 3 },
    });
    expect(Object.keys(readAzureDocTypes(root))).toEqual(["markdown"]);
  });

  test("键按字典序排列,与目录扫描顺序无关", () => {
    const root = fakeRepo({ "azure-markdown": MARKDOWN, "azure-docx": DOCX });
    expect(Object.keys(readAzureDocTypes(root))).toEqual(["docx", "markdown"]);
  });

  // 缺字段必须点名报错,不能静默取默认值:这份 json 是唯一事实来源,
  // 静默默认值会让它名存实亡。
  test("缺字段时报错并点出文件与字段名", () => {
    const { needsCas, ...missing } = DOCX;
    const root = fakeRepo({ "azure-docx": missing });
    expect(() => readAzureDocTypes(root))
      .toThrow(/packages\/azure-docx\/azure\.service\.json.*needsCas/s);
  });

  test("字段类型不对时报错并点出文件与字段名", () => {
    const root = fakeRepo({ "azure-docx": { ...DOCX, localPortBase: "41810" } });
    expect(() => readAzureDocTypes(root))
      .toThrow(/packages\/azure-docx\/azure\.service\.json.*localPortBase/s);
  });

  // 目录名与 docType 对不上会让 deploy.mjs 的 --service 与镜像名错位,
  // 而那要到真部署才暴露。
  test("docType 与目录名不一致时报错", () => {
    const root = fakeRepo({ "azure-docx": { ...DOCX, docType: "psd" } });
    expect(() => readAzureDocTypes(root)).toThrow(/azure-docx.*psd/s);
  });

  test("localPortBase 撞车时报错并点出两个 doc type", () => {
    const root = fakeRepo({
      "azure-markdown": MARKDOWN,
      "azure-docx": { ...DOCX, localPortBase: 41800 },
    });
    expect(() => readAzureDocTypes(root)).toThrow(/41800.*(markdown.*docx|docx.*markdown)/s);
  });
});

describe("azureDocTypePortBases", () => {
  test("从表提取 docType -> localPortBase", () => {
    const root = fakeRepo({ "azure-markdown": MARKDOWN, "azure-docx": DOCX });
    expect(azureDocTypePortBases(readAzureDocTypes(root)))
      .toEqual({ docx: 41810, markdown: 41800 });
  });
});
```

- [ ] **Step 3: 运行,确认失败**

Run: `npx vitest run tests/unit/scripts/azure-doc-types.test.mjs`
Expected: FAIL,`Cannot find module '../../../stacks/azure/doc-types.mjs'`

- [ ] **Step 4: 实现模块**

新建 `stacks/azure/doc-types.mjs`:

```js
/**
 * Azure doc type 的唯一事实来源:扫 `packages/azure-<name>/azure.service.json`。
 *
 * 为什么读文件的逻辑在这里而不在 `local/ports.mjs`:后者刻意零依赖(连
 * `node:` 内置模块都不 import),`dev.mjs` 要在 import 任何重家伙之前就用
 * 它算出端口。所以分工是——本模块负责「有哪些 doc type、它们声明了什么」,
 * `ports.mjs` 负责「给定这些声明,端口怎么排」,后者收表不持有表。
 *
 * 每个字段缺失或类型不对都点名报错,绝不静默取默认值:这份 json 一旦可以
 * 被默默兜底,它就不再是唯一事实来源了。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 字段名 -> 校验器。顺序即报错时的检查顺序,保持与 json 里的书写顺序一致。 */
const FIELDS = {
  docType: (v) => typeof v === "string" && v.length > 0,
  targetPort: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  localPortBase: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  minReplicas: (v) => Number.isInteger(v) && v >= 1,
  maxReplicas: (v) => Number.isInteger(v) && v >= 1,
  needsCas: (v) => typeof v === "boolean",
};

/**
 * 读出全部 Azure doc type 的声明,按 docType 字典序返回。
 *
 * 排序不是审美:`platform.bicep` 的 `docTypes` 数组决定循环资源的
 * `copyIndex()` 顺序,而目录扫描顺序在不同文件系统上不保证一致。稳定排序
 * 让同一份仓库在任何机器上展开出同一个部署形状。
 */
export function readAzureDocTypes(repoRoot = DEFAULT_ROOT) {
  const packagesDir = join(repoRoot, "packages");
  const table = {};
  const dirs = readdirSync(packagesDir).filter((d) => d.startsWith("azure-")).sort();

  for (const dir of dirs) {
    const rel = `packages/${dir}/azure.service.json`;
    const path = join(packagesDir, dir, "azure.service.json");
    if (!existsSync(path)) continue;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${rel} is not valid JSON: ${err.message}`);
    }

    // 没有 docType 字段的不是 doc type —— packages/azure-gateway 那份就是
    // 这样,它是 --gateway 自己的参数。按字段而不是按目录名排除,这样加
    // 新的非 doc type 包不需要改这里。
    if (!("docType" in parsed)) continue;

    for (const [field, valid] of Object.entries(FIELDS)) {
      if (!(field in parsed)) {
        throw new Error(`${rel} is missing required field ${field}`);
      }
      if (!valid(parsed[field])) {
        throw new Error(
          `${rel} has an invalid ${field}: ${JSON.stringify(parsed[field])}`,
        );
      }
    }

    const expected = dir.slice("azure-".length);
    if (parsed.docType !== expected) {
      throw new Error(
        `${rel} has docType ${JSON.stringify(parsed.docType)} but lives in ` +
          `packages/${dir}, which implies ${JSON.stringify(expected)}. ` +
          "The directory name drives the image name, the Container App name and " +
          "the database name, so a mismatch only surfaces at real deployment.",
      );
    }

    table[parsed.docType] = {
      docType: parsed.docType,
      targetPort: parsed.targetPort,
      localPortBase: parsed.localPortBase,
      minReplicas: parsed.minReplicas,
      maxReplicas: parsed.maxReplicas,
      needsCas: parsed.needsCas,
    };
  }

  const seen = new Map();
  for (const entry of Object.values(table)) {
    const clash = seen.get(entry.localPortBase);
    if (clash) {
      throw new Error(
        `localPortBase ${entry.localPortBase} is claimed by both ${clash} and ` +
          `${entry.docType}; each doc type needs its own band.`,
      );
    }
    seen.set(entry.localPortBase, entry.docType);
  }

  return table;
}

/** `azurePortLayout({ portBases })` 要的形状。 */
export function azureDocTypePortBases(table) {
  return Object.fromEntries(
    Object.values(table).map((entry) => [entry.docType, entry.localPortBase]),
  );
}
```

- [ ] **Step 5: 运行,确认通过**

Run: `npx vitest run tests/unit/scripts/azure-doc-types.test.mjs`
Expected: PASS,9 个测试

- [ ] **Step 6: 确认没碰坏别的**

Run: `npx vitest run tests/unit`
Expected: PASS(既有 230 条 + 新增 9 条)

- [ ] **Step 7: 提交**

```bash
git add stacks/azure/doc-types.mjs tests/unit/scripts/azure-doc-types.test.mjs \
        packages/azure-markdown/azure.service.json packages/azure-docx/azure.service.json
git commit -m "feat(azure): doc type 声明的唯一事实来源 readAzureDocTypes()"
```

---

### Task 2: 本地栈改查表,修掉 `pnpm dev --azure` 无参的 bug

**Files:**
- Modify: `stacks/azure/local/ports.mjs`
- Modify: `stacks/azure/local/runtime.mjs:565-582`(`SUPPORTED_DOC_TYPES` 与 `assertDocTypesSupported`)、`:653-654`(调用处)
- Modify: `scripts/dev.mjs:45`(无参默认值)、`:53`(docx 特判)、`:158`(`azurePortLayout` 调用)
- Modify: `tests/unit/scripts/azure-ports.test.mjs`

**Interfaces:**
- Consumes: `readAzureDocTypes()` / `azureDocTypePortBases()`(Task 1)
- Produces: `azurePortLayout({ docTypes, portBases, replicas })` —— **新增必填的 `portBases`**,不再有模块内的 `AZURE_DOC_TYPE_PORT_BASE`。返回形状不变:`{ gateway, docTypes: { [name]: { proxy, replicas: number[] } } }`。
- `allAzurePorts(layout)` / `describeAzurePorts(layout)` 签名与行为不变。

- [ ] **Step 1: 先证明 bug 存在**

```bash
node -e "
const {DOC_TYPES}=await import('./stacks/cloudflare/local/doc-types.mjs');
const {azurePortLayout}=await import('./stacks/azure/local/ports.mjs');
try { azurePortLayout({docTypes:Object.keys(DOC_TYPES)}); console.log('NO BUG'); }
catch(e){ console.log('BUG:', e.message); }
" --input-type=module
```

Expected: `BUG: Unknown Azure doc type: psd. Known: markdown, docx`

这就是 `pnpm dev --azure` **不带任何参数**时走的那条路径(`scripts/dev.mjs:45` 取的是 Cloudflare 的表)。记下来,Step 8 要复验它消失。

- [ ] **Step 2: 改 `tests/unit/scripts/azure-ports.test.mjs`**

在 import 下方加一个共用常量,并给每个 `azurePortLayout` 调用补 `portBases`:

```js
import { describe, expect, test } from "vitest";
import {
  allAzurePorts,
  azurePortLayout,
  describeAzurePorts,
} from "../../../stacks/azure/local/ports.mjs";

// 这个模块刻意零依赖,所以测试里直接给字面量,不 import doc-types.mjs ——
// 那会把 node:fs 拖进一个专门用来证明"不需要 node:fs"的测试里。
const PORT_BASES = { markdown: 41800, docx: 41810 };
```

然后逐处替换:

```js
  test("defaults to markdown with two replicas", () => {
    expect(azurePortLayout({ portBases: PORT_BASES })).toEqual({
      gateway: 41787,
      docTypes: { markdown: { proxy: 41800, replicas: [41801, 41802] } },
    });
  });

  test("replica count drives the replica port list", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 3 });
    expect(layout.docTypes.markdown.replicas).toEqual([41801, 41802, 41803]);
  });

  test("each doc type gets its own non-overlapping band", () => {
    const layout = azurePortLayout({ docTypes: ["markdown", "docx"], portBases: PORT_BASES, replicas: 2 });
    expect(layout.docTypes.docx).toEqual({ proxy: 41810, replicas: [41811, 41812] });
    const ports = allAzurePorts(layout);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
  });

  test("a replica count that overflows the band throws", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 20 }))
      .toThrow(/replicas/);
  });

  test("an unknown doc type throws, naming it and what is known", () => {
    expect(() => azurePortLayout({ docTypes: ["psd"], portBases: PORT_BASES }))
      .toThrow(/psd.*markdown, docx/s);
  });

  // portBases 是必填的:忘了传会让每个 doc type 都"未知",报错必须指向
  // 真正的原因,而不是让调用方以为 doc type 拼错了。
  test("omitting portBases throws about portBases, not about the doc type", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"] })).toThrow(/portBases/);
  });

  test("describeAzurePorts explains every port in the layout", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 2 });
    const described = describeAzurePorts(layout);
    for (const port of allAzurePorts(layout)) {
      expect(described[port]).toBeTypeOf("string");
      expect(described[port].length).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 3: 运行,确认失败**

Run: `npx vitest run tests/unit/scripts/azure-ports.test.mjs`
Expected: FAIL —— 至少 `omitting portBases throws about portBases` 这条失败(现在会报 `Unknown Azure doc type`)

- [ ] **Step 4: 改 `stacks/azure/local/ports.mjs`**

删掉 `AZURE_DOC_TYPE_PORT_BASE` 那个 export,`azurePortLayout` 换成:

```js
export const AZURE_GATEWAY_PORT = 41787;
export const AZURE_PORT_STRIDE = 10;

/**
 * `portBases` 是必填的:本模块刻意零依赖,读不了
 * `packages/azure-<name>/azure.service.json`。由调用方从
 * `stacks/azure/doc-types.mjs` 的 `azureDocTypePortBases()` 传进来。
 * 这样"有哪些 doc type"只有一个来源,而端口算法仍然可以脱离文件系统单测。
 */
export function azurePortLayout({ docTypes = ["markdown"], portBases, replicas = 2 } = {}) {
  if (!portBases || typeof portBases !== "object") {
    throw new Error(
      "azurePortLayout() requires portBases: pass azureDocTypePortBases(readAzureDocTypes()) " +
        "from stacks/azure/doc-types.mjs. (This module stays dependency-free on purpose and " +
        "cannot read packages/azure-*/azure.service.json itself.)",
    );
  }
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error(`replicas must be a positive integer, got ${replicas}`);
  }
  // 段内第一个端口给代理,其余给副本 —— 所以副本上限是 STRIDE - 1。
  if (replicas > AZURE_PORT_STRIDE - 1) {
    throw new Error(
      `replicas=${replicas} overflows the ${AZURE_PORT_STRIDE}-port band each doc type gets ` +
        `(max ${AZURE_PORT_STRIDE - 1}); widen AZURE_PORT_STRIDE if you really need more`,
    );
  }

  const result = { gateway: AZURE_GATEWAY_PORT, docTypes: {} };
  for (const name of docTypes) {
    const base = portBases[name];
    if (base === undefined) {
      throw new Error(
        `Unknown Azure doc type: ${name}. Known: ${Object.keys(portBases).join(", ")}`,
      );
    }
    result.docTypes[name] = {
      proxy: base,
      replicas: Array.from({ length: replicas }, (_, i) => base + 1 + i),
    };
  }
  return result;
}
```

`allAzurePorts` 与 `describeAzurePorts` 一行不改。模块顶部的注释里,把
「无依赖是刻意的」那段保留,并补一句说明 `portBases` 由调用方注入。

- [ ] **Step 5: 运行,确认通过**

Run: `npx vitest run tests/unit/scripts/azure-ports.test.mjs`
Expected: PASS,7 个测试

- [ ] **Step 6: 改 `stacks/azure/local/runtime.mjs`**

在 import 区(`./ports.mjs` 那行下面)加:

```js
import { azureDocTypePortBases, readAzureDocTypes } from "../doc-types.mjs";
```

把 `SUPPORTED_DOC_TYPES` 常量和 `assertDocTypesSupported` 整体替换成:

```js
/**
 * Doc types this task knows how to spawn a bundle for —— 由
 * `packages/azure-<name>/azure.service.json` 声明,不是这里的一份列表。每个名字
 * 都必须有对应的 `packages/azure-${name}/src/main.ts` 入口。传一个未声明的
 * 名字必须在 spawn 任何东西之前失败,而不是走到一半在一个不存在的路径上
 * `esbuild.build()`。
 */
function assertDocTypesSupported(docTypes, table) {
  const known = Object.keys(table);
  const unsupported = docTypes.filter((name) => !known.includes(name));
  if (unsupported.length > 0) {
    throw new Error(
      `startAzureRuntime() supports ${known.join(", ")} (got ${unsupported.join(", ")}). ` +
        `Add a packages/azure-${unsupported[0]}/ package with a src/main.ts entry point and an ` +
        "azure.service.json declaring its docType — the table expands from those files.",
    );
  }
}
```

调用处(原 653-654 行)改成:

```js
  const docTypeTable = readAzureDocTypes(ROOT);
  assertDocTypesSupported(docTypes, docTypeTable);
  const layout = azurePortLayout({
    docTypes,
    portBases: azureDocTypePortBases(docTypeTable),
    replicas,
  });
```

- [ ] **Step 7: 改 `scripts/dev.mjs`**

顶部 import 区加:

```js
import { azureDocTypePortBases, readAzureDocTypes } from "../stacks/azure/doc-types.mjs";
```

`dev.mjs:45` 那一行(`azureDocTypes = positional.length === 0 ? Object.keys(DOC_TYPES) : docTypes;`)整段替换成:

```js
  // 无参数意为「起全部 doc type」。取的必须是 **Azure 自己的**表:
  // `DOC_TYPES` 是 Cloudflare 的(stacks/cloudflare/local/doc-types.mjs),
  // 两边的 doc type 集合可以不一样,拿 CF 的表当 Azure 的默认值会在 CF 先
  // 支持某个类型时直接把 `pnpm dev --azure` 打挂。
  const azureDocTypeTable = readAzureDocTypes(root);
  azureDocTypes = positional.length === 0 ? Object.keys(azureDocTypeTable) : docTypes;
```

`dev.mjs:53` 的 `if (azureDocTypes.includes("docx")) {` 改成:

```js
  // 哪些 doc type 需要 CAS 由各包的 azure.service.json 声明(needsCas),
  // 不在这里维护第二份名单。
  if (azureDocTypes.some((name) => azureDocTypeTable[name]?.needsCas)) {
```

`dev.mjs:158` 的 `azurePortLayout` 调用改成:

```js
  const layout = azurePortLayout({
    docTypes: azureDocTypes,
    portBases: azureDocTypePortBases(azureDocTypeTable),
    replicas: 2,
  });
```

注意 `azureDocTypeTable` 声明在 `if (useAzure) {` 块内,而 158 行在同一个块内更靠后的位置——确认它在作用域内;若不在,把 `let azureDocTypeTable;` 与 `let azureDocTypes;` 一起提到块外声明。

- [ ] **Step 8: 复验 Step 1 的 bug 已消失**

```bash
node -e "
const {readAzureDocTypes, azureDocTypePortBases}=await import('./stacks/azure/doc-types.mjs');
const {azurePortLayout}=await import('./stacks/azure/local/ports.mjs');
const t=readAzureDocTypes();
console.log('Azure doc types:', Object.keys(t));
azurePortLayout({docTypes:Object.keys(t), portBases:azureDocTypePortBases(t)});
console.log('layout ok');
" --input-type=module
```

Expected:
```
Azure doc types: [ 'docx', 'markdown' ]
layout ok
```

- [ ] **Step 9: 跑门禁**

Run: `pnpm test:local`
Expected: PASS(285 passed / 2 skipped 的基线上,`azure-doc-types` 新增 9 条)

- [ ] **Step 10: 提交**

```bash
git add stacks/azure/local/ports.mjs stacks/azure/local/runtime.mjs scripts/dev.mjs \
        tests/unit/scripts/azure-ports.test.mjs
git commit -m "refactor(azure): 本地栈改查 doc type 表，修掉 pnpm dev --azure 无参失败"
```

---

### Task 3: Bicep 泛化,并把 securestring 不变式固化成测试

**Files:**
- Modify: `stacks/azure/deploy/platform.bicep`
- Modify: `stacks/azure/deploy/gateway.bicep`
- Create: `tests/unit/scripts/azure-bicep-secrets.test.mjs`

**Interfaces:**
- Produces: `platform.bicep` 新增必填 `param docTypes array`;输出从单个 `migrateJobNames` 拆成 `gatewayMigrateJobName string` 与 `docMigrateJobNames array`(**Task 4 的 `deployPlatform()` 必须跟着改**)。
- Produces: `gateway.bicep` 删掉 `markdownAccessKey` / `docxAccessKey` 两个 `@secure()` 参数,新增 `param docTypes array` 与 `@secure() param docAccessKeysJson string`(值是 `{"markdown":"…","docx":"…"}` 形状的 JSON 字符串)。
- `service.bicep`、`bootstrap.bicep`、`container-app.bicep`、`migrate-job.bicep` **一行不改**。

**这两段 Bicep 已经在设计阶段用 `az bicep build` 编译验证过**,包括一个失败的写法:`map(range(0, length(docTypes)), i => docMigrateJobs[i].outputs.name)` 会报 `BCP247: Using lambda variables inside resource or module array access is not currently supported`。下面给的是验证通过的版本,不要改回 lambda 形式。

- [ ] **Step 1: 改 `platform.bicep` 的参数与数据库**

在 `param pgAdminUser string = 'unidocs'` 之前插入:

```bicep
@description('要建库与迁移 Job 的 doc type 列表，由部署脚本从各包的 azure.service.json 展开。')
param docTypes array
```

把 `markdownDatabase` 与 `docxDatabase` 两个资源(连同它们之间的空行)整体替换为:

```bicep
resource docDatabases 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for dt in docTypes: {
  parent: pg
  name: 'unidocs_${dt}'
}]
```

`gatewayDatabase` 保持独立,不进循环。

- [ ] **Step 2: 改 `platform.bicep` 的连接串与迁移 Job**

删掉这两行:

```bicep
var markdownDatabaseUrl = '${databaseOrigin}/${markdownDatabase.name}?sslmode=require'
var docxDatabaseUrl = '${databaseOrigin}/${docxDatabase.name}?sslmode=require'
```

把 `markdownMigrateJob` 与 `docxMigrateJob` 两个 module 整体替换为:

```bicep
module docMigrateJobs 'migrate-job.bicep' = [for dt in docTypes: {
  name: '${dt}-migrate-job'
  params: {
    name: 'caj-unidocs-${dt}-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
    databaseUrl: '${databaseOrigin}/unidocs_${dt}?sslmode=require'
  }
}]
```

`gatewayMigrateJob` 保持独立:它用的是 `unidocs/azure-gateway-migrate` 镜像(网关的目录 schema),与 doc service 共用的 `unidocs/azure-migrate`(会话 schema)不是一个东西,塞进同一个循环需要加一个三元分支,比留两段更难读。

- [ ] **Step 3: 改 `platform.bicep` 的 output**

把:

```bicep
output migrateJobNames array = [
  gatewayMigrateJob.outputs.name
  markdownMigrateJob.outputs.name
  docxMigrateJob.outputs.name
]
```

替换为:

```bicep
output gatewayMigrateJobName string = gatewayMigrateJob.outputs.name
output docMigrateJobNames array = [for (dt, i) in docTypes: docMigrateJobs[i].outputs.name]
```

拆成两个 output 而不是 `union()` 拼一个:`union()` 里放不下循环表达式,而
`map(range(...), i => docMigrateJobs[i]...)` 会撞上 BCP247。

- [ ] **Step 4: 改 `gateway.bicep`**

删掉:

```bicep
@secure()
param markdownAccessKey string

@secure()
param docxAccessKey string
```

在 `param pgAdminUser string = 'unidocs'` 之前插入:

```bicep
@description('网关要路由到的 doc type 列表，由部署脚本从各包的 azure.service.json 展开。')
param docTypes array

@description('doc type -> 该服务的 SERVICE_ACCESS_KEY，JSON 字符串。整体作为一个 @secure() 参数传，而不是每个 doc type 一个参数——后者需要按 doc type 动态生成参数名，Bicep 做不到。')
@secure()
param docAccessKeysJson string
```

把 `var docServicesJson = string({ … })` 那整段(含 markdown/docx 两个字面量键)替换为:

```bicep
var docServicesJson = string(toObject(docTypes, dt => dt, dt => {
  serviceId: dt
  url: 'https://unidocs-${dt}.internal.${containerEnv.properties.defaultDomain}'
  accessKey: json(docAccessKeysJson)[dt]
}))
```

**`json(docAccessKeysJson)` 必须写在 lambda 里面。** 写成
`var keys = json(docAccessKeysJson)` 再引用 `keys[dt]` 一样编译得过,但会在
外层模板生成 `"variables": {"keys": "[json(parameters('docAccessKeysJson'))]"}`
—— 一个持有密钥派生值的外层变量。内联版本的外层 `variables` 是空的,与改动
前的编译产物零结构差异。Step 6 的测试会挡住这个回退。

`docServicesJson` 上方那段解释「部署期注册取代运行时注册表」的注释保留。

- [ ] **Step 5: 编译两个模板**

```bash
az bicep build --file stacks/azure/deploy/platform.bicep --stdout > /dev/null && echo "platform ok"
az bicep build --file stacks/azure/deploy/gateway.bicep --stdout > /dev/null && echo "gateway ok"
```

Expected: 两行 `ok`,且**没有任何 warning**。有 warning 就地修掉,不要留着。

- [ ] **Step 6: 写 securestring 不变式测试**

新建 `tests/unit/scripts/azure-bicep-secrets.test.mjs`:

```js
/**
 * 挡住一类只在真部署时才暴露的缺陷:`@secure()` 派生的表达式被内联进外层
 * 模板,导致 `az deployment group what-if` 对 Create 变更把明文连接串/密钥
 * 打进终端与日志(部署脚本用 stdio:"inherit" 透传)。上一轮真的踩过一次。
 *
 * 直接验 what-if 需要订阅写权限,这里改验 `az bicep build` 的编译产物——
 * 同样能区分"跨了 module 边界(securestring)"与"内联进外层模板(明文)",
 * 而且不需要任何 Azure 权限。
 *
 * 没装 az CLI 时跳过而不是失败:贡献者不该为了跑单测装 Azure CLI。代价是
 * 这层网只在装了 az 的机器上张开——所以 Task 3 的验收里要求手工跑一次。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function hasAz() {
  try {
    execFileSync("az", ["bicep", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const AZ = hasAz();

function compile(template) {
  const stdout = execFileSync(
    "az",
    ["bicep", "build", "--file", join(ROOT, "stacks/azure/deploy", template), "--stdout"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** 外层模板里所有嵌套部署资源。 */
function nestedDeployments(arm) {
  return arm.resources.filter((r) => r.type === "Microsoft.Resources/deployments");
}

describe.skipIf(!AZ)("gateway.bicep 的密钥不落进外层模板", () => {
  test("外层 variables 里没有任何密钥派生值", () => {
    const arm = compile("gateway.bicep");
    const vars = JSON.stringify(arm.variables ?? {});
    expect(vars).not.toContain("docAccessKeysJson");
    expect(vars).not.toContain("pgAdminPassword");
    expect(vars).not.toContain("casAccessKey");
  });

  test("嵌套部署用 inner scope，密钥参数声明为 securestring", () => {
    const arm = compile("gateway.bicep");
    const nested = nestedDeployments(arm);
    expect(nested.length).toBeGreaterThan(0);
    for (const dep of nested) {
      expect(dep.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });
      const params = dep.properties.template.parameters;
      for (const name of ["docServicesJson", "casAccessKey", "databaseUrl"]) {
        expect(params[name]?.type, `${name} must be securestring`).toBe("securestring");
      }
    }
  });
});

describe.skipIf(!AZ)("platform.bicep 的连接串不落进外层模板", () => {
  test("迁移 Job 的 databaseUrl 是嵌套模板的 securestring 参数", () => {
    const arm = compile("platform.bicep");
    const nested = nestedDeployments(arm);
    expect(nested.length).toBeGreaterThan(0);
    for (const dep of nested) {
      expect(dep.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });
      expect(dep.properties.template.parameters.databaseUrl?.type).toBe("securestring");
    }
  });

  test("pgAdminPassword 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("platform.bicep");

    // 其一：外层 variables 必须完全不持有密钥派生值。
    expect(JSON.stringify(arm.variables ?? {})).not.toContain("pgAdminPassword");

    // 其二：外层资源属性里，pgAdminPassword 只允许以**直接引用**出现。
    // `[parameters('pgAdminPassword')]` 仍然是 securestring，ARM 在 what-if
    // 与部署历史里会遮蔽它——pg 资源的 administratorLoginPassword 就是这一种，
    // 是 Azure 的标准写法。危险的是**拼接**：一旦被 format() / 字符串插值包
    // 进去，结果就只是一个普通字符串，securestring 的血统在那一步断掉，
    // what-if 对 Create 变更会把它原样打印进终端和日志。上一轮真的踩过。
    const offenders = [];
    const walk = (node, path) => {
      if (typeof node === "string") {
        if (
          node.includes("parameters('pgAdminPassword')")
          && node !== "[parameters('pgAdminPassword')]"
        ) {
          offenders.push(`${path} = ${node}`);
        }
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      }
    };
    for (const r of arm.resources) {
      if (r.type === "Microsoft.Resources/deployments") continue;
      walk(r, r.type);
    }
    expect(offenders).toEqual([]);
  });

  // R4：上一轮有过一次同类教训——迁移 Job 名写成了嵌套部署名而不是资源名，
  // 能编译但值是错的，只在真部署时表现为 "job not found"。
  test("docMigrateJobNames 读的是 module 的 output，不是嵌套部署名", () => {
    const arm = compile("platform.bicep");
    const out = JSON.stringify(arm.outputs.docMigrateJobNames);
    expect(out).toContain("outputs.name.value");
  });
});
```

- [ ] **Step 7: 运行**

Run: `npx vitest run tests/unit/scripts/azure-bicep-secrets.test.mjs`
Expected: PASS,5 个测试(本机装了 az CLI,不会 skip)

若 `docMigrateJobNames` 那条失败,说明 Step 3 的 output 写错了 —— 检查是不是
写成了 `docMigrateJobs[i].name`(嵌套部署名)而不是 `.outputs.name`。

- [ ] **Step 8: 提交**

```bash
git add stacks/azure/deploy/platform.bicep stacks/azure/deploy/gateway.bicep \
        tests/unit/scripts/azure-bicep-secrets.test.mjs
git commit -m "refactor(azure): platform/gateway.bicep 按 docTypes 展开，并固化 securestring 不变式"
```

---

### Task 4: `deploy.mjs` / `smoke.mjs` 去掉 25 处硬编码

**Files:**
- Modify: `stacks/azure/deploy/deploy.mjs`
- Modify: `stacks/azure/deploy/smoke.mjs:71`
- Modify: `tests/unit/scripts/azure-deploy.test.mjs`

**Interfaces:**
- Consumes: `readAzureDocTypes()`(Task 1);`platform.bicep` 的双 output 与 `gateway.bicep` 的新参数(Task 3)
- Produces: `IMAGES` 变成从表展开的函数 `azureImages()`;`seedSecrets()` 返回 `{ pgAdminPassword, casAccessKey, accessKeys }`,其中 `accessKeys` 是 `Record<docType, string>`。

- [ ] **Step 1: 常量与 IMAGES**

删掉:

```js
const MARKDOWN_ACCESS_KEY_SECRET = "markdown-access-key";
const DOCX_ACCESS_KEY_SECRET = "docx-access-key";
```

加:

```js
/** Key Vault 里每个 Doc service 的 access key secret 名。 */
const accessKeySecretName = (docType) => `${docType}-access-key`;
```

把 `export const IMAGES = [...]` 换成:

```js
/**
 * 镜像清单:网关 + 网关迁移 + 每个 doc type 一个服务镜像 + 共用的 Doc 迁移。
 * doc type 那一段从 `packages/azure-<name>/azure.service.json` 展开,不是一份
 * 手写名单 —— 加一个 doc type 只该改那个包,不该改这里。
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
```

顶部 import 区加 `import { readAzureDocTypes } from "../doc-types.mjs";`。

- [ ] **Step 2: `seedSecrets()` 改成按表播种**

把函数体里 `markdownAccessKey` / `docxAccessKey` 两段替换为:

```js
  const table = readAzureDocTypes(ROOT);
  const accessKeys = {};
  if (needsServiceKeys) {
    for (const docType of Object.keys(table)) {
      accessKeys[docType] = await seedSecret(keyVaultName, accessKeySecretName(docType), 48);
    }
  }
  return { pgAdminPassword, casAccessKey, accessKeys };
```

同时把该函数上方注释里「`markdownAccessKey`/`docxAccessKey`(每个 Doc service 自己的 SERVICE_ACCESS_KEY,由本脚本生成)」改成「每个 doc type 一个 `SERVICE_ACCESS_KEY`,名字是 `{docType}-access-key`,由本脚本生成」。

- [ ] **Step 3: `imagesForTargets()` 与 `main()` 的默认 service 列表**

两处 `args.services ?? ["markdown", "docx"]`(约 827 行与 1273 行)都换成:

```js
    for (const docType of args.services ?? Object.keys(readAzureDocTypes(ROOT))) {
```

`imagesForTargets()` 里 `IMAGES.find(...)` 的三处调用改为先取一次
`const images = azureImages()`,再 `images.find(...)`。

- [ ] **Step 4: `deployPlatform()` 传 docTypes、读双 output**

`parameters` 数组改成:

```js
  const docTypes = Object.keys(readAzureDocTypes(ROOT));
  const parameters = [
    `imageTag=${tag}`,
    `docTypes=${JSON.stringify(docTypes)}`,
    `pgAdminPassword=${secrets.pgAdminPassword}`,
  ];
```

函数末尾的 output 读取改成:

```js
  const outputs = JSON.parse(stdout).properties.outputs;
  return {
    migrateJobNames: [
      outputs.gatewayMigrateJobName.value,
      ...outputs.docMigrateJobNames.value,
    ],
  };
```

返回值的形状(`{ migrateJobNames: string[] }`)保持不变,调用方不用改。

- [ ] **Step 5: `deployGateway()` 传新参数**

`parameters` 数组末尾两行:

```js
    `markdownAccessKey=${secrets.markdownAccessKey}`,
    `docxAccessKey=${secrets.docxAccessKey}`,
```

替换为:

```js
    `docTypes=${JSON.stringify(Object.keys(readAzureDocTypes(ROOT)))}`,
    `docAccessKeysJson=${JSON.stringify(secrets.accessKeys)}`,
```

- [ ] **Step 6: 冒烟的 CAS 特判改用 `needsCas`**

`deploy.mjs` 里两处提到 docx 图片路径的判断(约 771 行的 `assertCasAccessKeyMatches` 报错文案、约 1247 行的 `--no-cas` 提示)改成按表描述,例如把
`"azure-docx fail with 401 — the docx image path would break..."` 里的 `azure-docx` 换成从表算出的名单:

```js
  const casDocTypes = Object.values(readAzureDocTypes(ROOT))
    .filter((entry) => entry.needsCas)
    .map((entry) => `azure-${entry.docType}`)
    .join(" / ");
```

然后在两处文案里用 `casDocTypes` 代替写死的 `azure-docx` / `docx`。

`smoke.mjs:71` 的:

```js
const KNOWN_DOC_TYPES = ["markdown", "docx"];
```

替换为:

```js
/** 可冒烟的 doc type 由各包的 azure.service.json 声明，与 deploy.mjs 的
 *  azureImages()/service.bicep 同一个来源。 */
const KNOWN_DOC_TYPES = Object.keys(readAzureDocTypes(REPO_ROOT));
```

并在 `smoke.mjs` 顶部 import 区加 `import { readAzureDocTypes } from "../doc-types.mjs";`。

- [ ] **Step 7: 改 `tests/unit/scripts/azure-deploy.test.mjs`**

现有测试里凡 import `IMAGES` 的改成 import `azureImages` 并调用它。加两条新断言:

```js
test("azureImages 从 azure.service.json 展开每个 doc type 的服务镜像", () => {
  const names = azureImages().map((i) => i.name);
  expect(names).toContain("azure-markdown");
  expect(names).toContain("azure-docx");
  expect(names).toContain("azure-gateway");
  expect(names).toContain("azure-gateway-migrate");
  expect(names).toContain("azure-migrate");
});

// 加一个 doc type 只该改那个包，不该改 deploy.mjs。
test("azureImages 接受注入的表，新 doc type 自动出现", () => {
  const names = azureImages({
    markdown: { docType: "markdown" },
    psd: { docType: "psd" },
  }).map((i) => i.name);
  expect(names).toContain("azure-psd");
});
```

- [ ] **Step 8: 跑测试**

Run: `npx vitest run tests/unit`
Expected: PASS

- [ ] **Step 9: 确认没有残留字面量**

```bash
grep -n "markdown\|docx\|Markdown\|Docx" stacks/azure/deploy/deploy.mjs stacks/azure/deploy/smoke.mjs
```

Expected: 只剩注释/文档字符串里的示例(`--service docx` 这类用法演示)。**任何还在参与逻辑的 `markdown` / `docx` 字面量都是没改完。**

- [ ] **Step 10: 提交**

```bash
git add stacks/azure/deploy/deploy.mjs stacks/azure/deploy/smoke.mjs tests/unit/scripts/azure-deploy.test.mjs
git commit -m "refactor(azure): 部署脚本按 doc type 表展开，去掉 25 处硬编码"
```

---

### Task 5: `packages/azure-psd`

**Files:**
- Create: `packages/azure-psd/package.json`
- Create: `packages/azure-psd/tsconfig.json`
- Create: `packages/azure-psd/azure.service.json`
- Create: `packages/azure-psd/src/main.ts`
- Create: `packages/azure-psd/scripts/bundle.mjs`
- Modify: `tsconfig.json`(根)
- Modify: `README.md`

**Interfaces:**
- Consumes: `runDocTypeService({ docType, documentTypeFactory, defaultPort })` from `@unidocs/azure-sdk`;`createPsdDocumentType` from `@unidocs/doctype-psd`
- Produces: 一个新的 doc type 条目,Task 1 的 `readAzureDocTypes()` 会自动扫到它,Task 2/3/4 的所有消费方随之自动支持 psd。

- [ ] **Step 1: `azure.service.json`**

```json
{ "docType": "psd", "targetPort": 8790, "localPortBase": 41820, "minReplicas": 2, "maxReplicas": 5, "needsCas": true }
```

`targetPort` 8790 与 Cloudflare 侧 psd 一致(`stacks/cloudflare/local/doc-types.mjs` 里 psd 是 8790、`CAS_PORT` 是 8791);`localPortBase` 41820 顺着 markdown 41800 / docx 41810 与 `AZURE_PORT_STRIDE=10`。

- [ ] **Step 2: `package.json`**

```json
{
  "name": "@unidocs/azure-psd",
  "version": "0.1.0",
  "description": "Azure/Node entry point for the PSD document type",
  "type": "module",
  "main": "./src/main.ts",
  "types": "./src/main.ts",
  "exports": {
    ".": {
      "types": "./src/main.ts",
      "import": "./src/main.ts"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc && node scripts/bundle.mjs",
    "start": "node dist/main.js",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -b",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@unidocs/azure-sdk": "workspace:*",
    "@unidocs/doctype-psd": "workspace:*",
    "@azure/identity": "^4.13.2",
    "@azure/storage-blob": "^12.33.0",
    "pg": "^8.23.0"
  },
  "devDependencies": {
    "@types/pg": "^8.23.1",
    "esbuild": "^0.28.2",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "publishConfig": {
    "main": "./dist/main.js",
    "types": "./dist/main.d.ts",
    "exports": {
      ".": {
        "types": "./dist/main.d.ts",
        "import": "./dist/main.js"
      }
    }
  }
}
```

**不要声明 `ag-psd` / `fast-png`。** 它们是 `@unidocs/doctype-psd` 的依赖,纯 JS,不在 `scripts/workspace-aliases.mjs` 的 `EXTERNAL_NPM_PACKAGES`(`["pg", "@azure/storage-blob", "@azure/identity"]`)里,会被 esbuild 内联进 bundle。只有留作 external 的依赖才必须在这里声明——那是上一轮 azure-docx 漏声明 `pg` 导致镜像 `ERR_MODULE_NOT_FOUND` 的教训。`tests/unit/workspace/package-deps.test.mjs` 会守这条。

- [ ] **Step 3: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "lib": ["ES2024", "DOM"],
    "types": []
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../azure-sdk"
    },
    {
      "path": "../doctype-psd"
    }
  ]
}
```

- [ ] **Step 4: `src/main.ts`**

```ts
/**
 * Azure/Node entry point for the PSD document type.
 *
 * 与 `packages/azure-markdown` / `packages/azure-docx` 的入口同形,只有
 * doc type 与默认端口不同:连接池与它的四个超时、Blob 客户端、端口构造、
 * 每请求新建 DocumentSession、CAS 接线、SBlob 上下文、优雅关停,全部在
 * `@unidocs/azure-sdk` 的 `runDocTypeService()` 里。如果这个文件需要复制
 * 另两个入口里的任何东西,说明 SDK 抽取不完整 —— 改 azure-sdk,不要在这里抄。
 *
 * PSD 的像素路径重度依赖 SBlob,因此需要 CAS。本轮仍是过渡形态:
 * `CAS_BASE_URL` 指向 Cloudflare 的 CAS worker(阶段 4 换成 azure-cas)。
 * `azure.service.json` 里的 `needsCas: true` 声明了这一点,本地栈与部署
 * 脚本都从那里读。
 *
 * **Operator 在 Azure 上不可用。** `azure-sdk` 的
 * `createStubOperatorNamespace()` 让所有 doc type 的 `/run` 与 `/reset` 一律
 * 501。Cloudflare 侧 psd 挂了真 Operator(`createPsdDocumentAgent` +
 * Anthropic,maxIterations 25),Azure 侧没有。这不是 psd 特有的缺口,接真
 * Operator 会同时影响 markdown/docx/psd 三家,是独立一轮的事——不是这里漏掉了。
 *
 * Env vars: DATABASE_URL, SERVICE_ACCESS_KEY, CAS_ACCESS_KEY, PORT,加上一组
 * 二选一的 Blob 配置:云上是 BLOB_ACCOUNT_URL + AZURE_CLIENT_ID(用户分配
 * 托管标识;漏掉后者容器能起来、能过健康检查,第一次 Blob 操作才炸,所以
 * resolveBlobConfig() 把它作为启动期硬性要求),本地/Azurite 是
 * BLOB_CONNECTION_STRING。CAS_BASE_URL 可选(过渡形态)。
 *
 * CAS_ACCESS_KEY 必须与 Cloudflare CAS worker 的一致:那个 worker 对每个
 * X-Internal-Token 不匹配的请求都返回 401。
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
```

- [ ] **Step 5: `scripts/bundle.mjs`**

把 `packages/azure-docx/scripts/bundle.mjs` 整份复制过来,只改文件头注释里的
`azure-docx` → `azure-psd`、`@ariadng/office` → `ag-psd` / `fast-png`(说明它们
同样是**必须被内联**、不能留作 external 的真实 npm 依赖)。`esbuild.build()`
的配置块一个字符都不用改。

- [ ] **Step 6: 根 `tsconfig.json` 加 reference**

在 `{ "path": "packages/azure-docx" }` 之后插入:

```json
    {
      "path": "packages/azure-psd"
    },
```

- [ ] **Step 7: 装依赖并构建**

```bash
pnpm install --registry=https://repo.huaweicloud.com/repository/npm/
pnpm --filter @unidocs/azure-psd build
```

Expected: `tsc` 与 `node scripts/bundle.mjs` 都成功,产出 `packages/azure-psd/dist/main.js`

**注意**:如果 `pnpm install` 报出要清空 `node_modules` 的提示,说明工作区的
`.pnpm-workspace-state-v1.json` 里 `settings.dev` 被置成了 `false`(某次
`pnpm deploy --prod` 的副作用)。用上面这条不带 `--prod` 的 install 修正它。
**不要**设 `CI=true` 或 `confirmModulesPurge=false` 去绕过。

- [ ] **Step 8: 确认 bundle 能被 node 直接跑起来(会因缺环境变量退出,这是对的)**

```bash
node packages/azure-psd/dist/main.js 2>&1 | head -5
```

Expected: `azure-psd failed to start:` 后跟一个关于缺 `DATABASE_URL` 或 Blob
配置的明确错误。**若报 `ERR_MODULE_NOT_FOUND`,说明 bundle 把某个依赖漏在了
外面** —— 检查 Step 5 的 external 列表。

- [ ] **Step 9: 更新 README 的「新增 doc type」步骤**

`README.md:315-320` 附近那两条:

```
   - Add a `mytype: <port>` row to `AZURE_DOC_TYPE_PORT_BASE` in `stacks/azure/local/ports.mjs` ...
   - Add `"mytype"` to `SUPPORTED_DOC_TYPES` in `stacks/azure/local/runtime.mjs`.
```

替换为一条:

```
   - Create `packages/azure-mytype/` with `src/main.ts`, `package.json`, `tsconfig.json`,
     `scripts/bundle.mjs` and an `azure.service.json` declaring `docType`, `targetPort`,
     `localPortBase` (at least `AZURE_PORT_STRIDE` past the last one), `minReplicas`,
     `maxReplicas` and `needsCas`. Everything else — local ports, the dev stack's
     supported list, the deploy script's images and secrets, and the Bicep templates —
     expands from that one file.
```

- [ ] **Step 10: 全量门禁**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm test:local`
Expected: 全绿

- [ ] **Step 11: 提交**

```bash
git add packages/azure-psd tsconfig.json README.md pnpm-lock.yaml
git commit -m "feat(azure): 新增 packages/azure-psd"
```

---

### Task 6: psd 端到端测试与 web 端口偏移

**Files:**
- Create: `tests/integration/azure/azure-psd.test.mjs`
- Modify: `scripts/dev.mjs`(web 端口偏移)

**Interfaces:**
- Consumes: Task 5 的 `packages/azure-psd`;`startAzureRuntime({ docTypes, casBaseUrl, ... })` 与 `startLocalRuntime({ docTypes, ports })`
- 公共路由是 `/users/{userId}/docs/{docType}/...`(`packages/gateway-common/src/gateway-handler.ts:68`),**不是** `/tenants/...` —— 后者是内部路径。

- [ ] **Step 1: web 端口偏移**

`scripts/dev.mjs` 的前端启动循环里,`--port` 参数改为:

```js
// 两套栈可以同时跑(docx/psd 的 CAS 过渡形态正需要这一点),那时两个 Vite
// 都想要同一个端口。给 Azure 侧加一个固定偏移，与端口段本身的分离
// (Azure 41787 对 Miniflare 8787)同一个思路。偏移只与后端有关、与 doc
// type 无关，所以留在这里，不进 azure.service.json。
const AZURE_WEB_PORT_OFFSET = 1000;
```

放在文件顶部常量区,循环里:

```js
  const webPort = web.port + (useAzure ? AZURE_WEB_PORT_OFFSET : 0);
  const child = spawn("npx", ["vite", "--port", String(webPort), "--strictPort"], {
```

底下那行 `console.log` 里的端口也用 `webPort`。

- [ ] **Step 2: 写 psd 端到端测试**

新建 `tests/integration/azure/azure-psd.test.mjs`:

```js
/**
 * psd 在本地 Azure 栈上的端到端 —— 本轮的验收之一。
 *
 * 与 azure-docx-image 同样的过渡形态:psd 的像素路径重度依赖 SBlob，而
 * Azure 侧还没有 azure-cas，所以 CAS_BASE_URL 指向 Miniflare 栈里的
 * Cloudflare CAS worker（阶段 4 换成 azure-cas 后这段脚手架整个删掉）。
 *
 * 这条测试的重心是 `getPreview`：它走的正是 makeSBlob/readSBlob → CAS 的
 * 那条路径。只 create + getLayers 不足以证明 psd 在 Azure 上可用——那两步
 * 不碰 CAS。
 *
 * Miniflare 侧用专用端口（tests/integration/ 下每个文件都这么做：
 * 18787 / 28787 / 29787 / 31787 / 32787），因为开发流程要求另开终端跑
 * `pnpm dev`，那是绑默认端口的进程。**Azure 侧刻意不覆盖端口**：
 * `startAzureRuntime()` 没有端口覆盖参数，四个 Azure 测试在
 * `--fileParallelism=false` 下顺序执行、互不重叠；与外部 `pnpm dev --azure`
 * 的冲突由 `assertPortsFree()` 明确报出，不是静默失败。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import { startAzureRuntime } from "../../../stacks/azure/local/runtime.mjs";

const USER = "psd-e2e-user";
const MINIFLARE_PORTS = { gateway: 33787, psd: 33790, cas: 33791 };

let miniflare;
let azure;

beforeAll(async () => {
  miniflare = await startLocalRuntime({ docTypes: ["psd"], ports: MINIFLARE_PORTS });
  azure = await startAzureRuntime({
    docTypes: ["psd"],
    casBaseUrl: miniflare.urls.cas,
  });
}, 300_000);

afterAll(async () => {
  await azure?.dispose();
  await miniflare?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

test("psd imports, lists layers and renders a preview on the Azure stack", async () => {
  const psd = readFileSync(
    join(process.cwd(), "packages/doctype-psd/tests/fixtures/sample.psd"),
  );

  // create + import：`formats.psd.load` 认 image/vnd.adobe.photoshop
  // （packages/doctype-psd/src/doctype.ts 的 formats 块）。
  const created = await closeFetch(`${azure.urls.gateway}/users/${USER}/docs/psd/`, {
    method: "POST",
    headers: { "Content-Type": "image/vnd.adobe.photoshop" },
    body: psd,
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const { docId } = await created.json();
  expect(docId).toBeTypeOf("string");

  const layers = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/psd/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "getLayers" } }),
    },
  );
  expect(layers.status, await layers.clone().text()).toBe(200);
  const listed = await layers.json();
  expect(listed.version).toBeGreaterThanOrEqual(1);
  // sample.psd 有图层；空数组说明导入没真正落下来。
  expect(JSON.stringify(listed.data).length).toBeGreaterThan(2);

  // 这一步才碰 CAS：getPreview 要读回被 externalize 出去的像素。
  const preview = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/psd/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "getPreview", payload: { maxSize: 64 } } }),
    },
  );
  expect(preview.status, await preview.clone().text()).toBe(200);
  const rendered = await preview.json();
  expect(rendered.data).toBeTruthy();
}, 240_000);
```

**实施提示**:`query` 响应的字段名(`data` / `version`)与 create 响应的
`docId`,以对着 `tests/integration/azure/azure-docx-image.test.mjs` 与
`tests/integration/shared/behavior-suite.mjs` 里的既有断言为准 —— 那两个文件
里的写法是当前 wire format 的事实来源。若 `getPreview` 因 CAS 未就绪失败,
先确认 `miniflare.urls.cas` 非空(Miniflare 侧 psd 必须被选中,CAS worker 才
会起)。**不要**因为 preview 难通过就把它删掉换成只查 getLayers:那样这条
测试就不再覆盖 SBlob → CAS 这条路径,而那正是它存在的理由。

- [ ] **Step 3: 起 Docker,跑这条测试**

```bash
pnpm azure:up
npx vitest run --fileParallelism=false tests/integration/azure/azure-psd.test.mjs
```

Expected: PASS

- [ ] **Step 4: 跑全部 Azure 集测**

Run: `pnpm test:azure`
Expected: PASS

- [ ] **Step 5: 手工验本地栈**

```bash
pnpm dev psd          # 一个终端：Cloudflare 栈，提供 CAS
pnpm dev --azure psd  # 另一个终端
```

Expected:
- 两个都起得来
- Azure 侧打印 `azure-psd listening on ...`,端口在 41820 段
- Vite 前端在 **6173**(5173 + 1000),Cloudflare 那个在 5173,互不冲突
- 浏览器打开 6173,能建 psd 文档并看到渲染

- [ ] **Step 6: 验无参启动**

```bash
pnpm dev --azure
```

Expected: markdown / docx / psd 三个都起来,不再报 `Unknown Azure doc type`。

- [ ] **Step 7: 验隔离性没回退**

```bash
mv stacks/azure /tmp/azure-parked
pnpm build && pnpm typecheck && pnpm test
mv /tmp/azure-parked stacks/azure
```

Expected: 三条全绿。(`pnpm test:local` 会因为 `tests/unit/scripts/` 下若干直接
import `stacks/azure/` 的单测而失败 —— 这是既有状况,见设计 §8.9,本轮不修。)

- [ ] **Step 8: 提交**

```bash
git add tests/integration/azure/azure-psd.test.mjs scripts/dev.mjs
git commit -m "test(azure): psd 端到端，并给 Azure 侧的 Vite 端口加偏移"
```

---

## 完成后

全部 6 个任务完成后:

1. 跑一次完整门禁:`pnpm build && pnpm typecheck && pnpm test && pnpm test:local && pnpm test:azure`
2. 用 `superpowers:requesting-code-review` 对整分支做一次终审
3. 用 `superpowers:finishing-a-development-branch` 收尾

**PIM 恢复后**需要补做的真实部署验收(设计 §8 的 10-12 条,不阻塞合并):

- `node stacks/azure/deploy/deploy.mjs --platform` 建出 `unidocs_psd` 数据库与 `caj-unidocs-psd-migrate` 迁移 Job
- `--service psd` 只更新 psd 的 Container App,`service-markdown` / `service-docx` / `gateway` 的部署时间戳不变、revision 不递增
- `--gateway` 重部后 `DOC_SERVICES_JSON` 含三个 doc type,`/users/{u}/docs/psd/` 可达
