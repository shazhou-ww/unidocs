# Azure 字体登记表 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把租户级字体登记表从 Cloudflare 专有实现下沉成跨平台契约，让 Azure 上的 psd agent 拿到 `setText`。

**Architecture:** 新增中立契约 `FontRegistry`（独立模块，不进 `ports.ts`），路由与鉴权搬进中立层，两个平台各出一个适配器——Cloudflare 包住现有的 Durable Object（不重写），Azure 用新的 Postgres 表。`FontIndexSource` 合并成一个建在 `FontRegistry` 之上的中立实现。

**Tech Stack:** TypeScript（composite project references）、vitest、Postgres（`pg`）、Cloudflare Durable Objects、pnpm workspace。

设计稿：`docs/superpowers/specs/2026-09-04-azure-font-registry-design.md`

## Global Constraints

- 依赖方向不可逆：`doctype-psd → doctype-server-common → protocol-doc → protocol`。中立层**不得** import 任何 `doctype-psd` / `cloudflare-*` / `azure-*` 的东西。
- `packages/doctype-server-common/src/ports.ts` 的文件头不变式必须继续成立：*"Every port in this module is scoped to one Doc session."* 本计划新增的契约一律不放进该文件。
- Cloudflare 的 `PsdFontsDurableObject` 内部实现与 sqlite 表结构**不得修改**（线上已有数据）。
- 字节永不经过 `FontRegistry`：登记表只存 hash，字节在 CAS（裁定 R29）。
- 每个任务结束时 `pnpm --filter <改动的包> typecheck` 必须干净。
- 提交信息用中文，句末标点用半角逗号/句号混排风格（跟随仓库既有 commit）。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/doctype-server-common/src/font-registry.ts` | 新建。`FontCoverage` / `FontEntry` / `FontRegistry` 契约 + `fontEntryProblem` 校验器 |
| `packages/doctype-server-common/src/font-registry-handler.ts` | 新建。`/tenants/{t}/fonts` 的中立处理器：鉴权 → 校验 → 转 `FontRegistry` |
| `packages/doctype-server-common/src/memory-ports.ts` | 加 `MemoryFontRegistry` |
| `packages/protocol-doc/src/routes.ts` | 加 `matchFontsRoute` + `TenantOperation` |
| `packages/doctype-psd/src/text/registry.ts` | 改为 re-export `FontEntry` |
| `packages/doctype-psd/src/text/opentype-face.ts` | 改为 re-export `FontCoverage` |
| `packages/doctype-psd/src/text/font-index.ts` | 新建。中立的 `FontIndexSource` 实现（含 60s 缓存） |
| `packages/cloudflare-psd/src/font-registry-do.ts` | 新建。`FontRegistry` 的 DO 适配器 |
| `packages/cloudflare-psd/src/fonts-do.ts` | 删掉 `matchFontsRoute` / `handleFontsRequest` / `fontEntryProblem`（已搬走），保留 DO 与 `fontsObjectName` |
| `packages/cloudflare-psd/src/fonts-source.ts` | 缩成构造 `FontIndexSource` 的接线 |
| `packages/azure-sdk/migrations/0005_font_registry.sql` | 新建。`font_registry` 表 |
| `packages/azure-sdk/src/font-registry-pg.ts` | 新建。`PgFontRegistry` |
| `packages/azure-sdk/src/local-operator.ts` | `deps.agent` 由值改为工厂 |
| `packages/azure-sdk/src/doc-type-service.ts` | 透传工厂；挂 fonts 路由 |
| `packages/azure-psd/src/agent-deps.ts` | 新建。可测的 `psdAgentDeps(env, identity)` |
| `packages/azure-psd/tests/agent-deps.test.ts` | 新建 |
| `tests/unit/psd-agent-parity.test.mjs` | 新建。跨栈工具表断言 |

---

### Task 1: `FontRegistry` 契约与 `fontEntryProblem` 下沉

**Files:**
- Create: `packages/doctype-server-common/src/font-registry.ts`
- Create: `packages/doctype-server-common/tests/font-registry.test.ts`
- Modify: `packages/doctype-server-common/src/index.ts`（导出新模块）
- Modify: `packages/doctype-psd/src/text/registry.ts:15,17-36`（改 re-export）
- Modify: `packages/doctype-psd/src/text/opentype-face.ts:22`（改 re-export）
- Modify: `packages/cloudflare-psd/src/fonts-do.ts`（删掉 `fontEntryProblem` 及其私有辅助 `coverageProblem` / `isCodePoint` / `HASH_PATTERN` / `MAX_CODE_POINT`，改为从 `@unidocs/doctype-server-common` import）
- Modify: `packages/cloudflare-psd/tests/fonts-do.test.ts`（把 `describe("fontEntryProblem")` 整块搬到新测试文件）

**Interfaces:**
- Produces: `FontCoverage`、`FontEntry`、`FontRegistry`、`fontEntryProblem(value: unknown): string | null`，全部从 `@unidocs/doctype-server-common` 导出。

- [ ] **Step 1: 把现有的 `fontEntryProblem` 测试搬进新文件并让它失败**

新建 `packages/doctype-server-common/tests/font-registry.test.ts`。把 `packages/cloudflare-psd/tests/fonts-do.test.ts` 里 `describe("fontEntryProblem", ...)` 那一整块（第 132–189 行）**逐字**复制过来，只改 import：

```ts
/**
 * `fontEntryProblem` —— 登记载荷的边界校验。
 *
 * 从 cloudflare-psd/src/fonts-do.ts 搬来:契约下沉之后,写入侧的校验必须跟着
 * 到中立层,否则 Azure 那条路会绕过它。coverage 的形状是硬要求不是洁癖 ——
 * selectFonts 用二分查找判码位覆盖,喂它乱序或重叠的区间会**静默返回错的
 * 结果**,那个字被判成"这套字体不认识"然后掉到回退链上,没有任何东西报错。
 */
import { describe, expect, it } from "vitest";
import { fontEntryProblem } from "../src/font-registry.js";
import type { FontEntry } from "../src/font-registry.js";

const valid: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]],
};

describe("fontEntryProblem", () => {
  it("合法条目没有问题", () => {
    expect(fontEntryProblem(valid)).toBeNull();
  });

  it("unitsPerEm 非正 → 说得出是哪个字段", () => {
    expect(fontEntryProblem({ ...valid, unitsPerEm: 0 })).toContain("unitsPerEm");
  });

  it("coverage 乱序 → 指名道姓说是第几条", () => {
    const problem = fontEntryProblem({ ...valid, coverage: [[0x4e00, 0x9fff], [0x20, 0x7e]] });
    expect(problem).toContain("coverage[1]");
  });

  it("相邻但没合并 → 也不放行（二分查找依赖的是合并后的形状）", () => {
    expect(fontEntryProblem({ ...valid, coverage: [[0x20, 0x7e], [0x7f, 0x80]] })).toContain("merged");
  });

  it("空 coverage 不放行 —— 它永远不会被 selectFonts 选中，只会成为死条目", () => {
    expect(fontEntryProblem({ ...valid, coverage: [] })).toContain("must not be empty");
  });

  it("hash 必须是 64 位小写十六进制 —— createSBlob 只收这一种", () => {
    expect(fontEntryProblem({ ...valid, hash: "A".repeat(64) })).toContain("hexadecimal");
  });

  it("载荷根本不是对象", () => {
    expect(fontEntryProblem("nope")).toContain("JSON object");
  });
});
```

> 搬运时以 `fonts-do.test.ts` 现有断言为准；上面是骨架，**原文件里那一块的每一条 `it` 都要在这里出现**，一条都不能丢。

- [ ] **Step 2: 跑它，确认因模块不存在而失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry.test.ts`
Expected: FAIL — `Failed to load url ../src/font-registry.js`

- [ ] **Step 3: 写 `font-registry.ts`**

```ts
/**
 * 租户级字体登记表 —— 跨平台契约。
 *
 * **为什么不在 ports.ts 里**:那个模块的文件头写着"Every port in this module
 * is scoped to one Doc session",四个 port 全部经 SessionDeps 喂给
 * DocumentSession,身份是含 sessionId 的 SessionIdentity。字体索引是租户级
 * 的 —— 一个租户一套字体、被名下所有文档共用 —— 而且它永远不进
 * SessionDeps(消费者是路由处理器和 agent 依赖)。放进去它会是那个文件里唯一
 * 没有消费者的接口,并且当场作废那句不变式。
 *
 * 它**只存元数据,绝不碰 CAS**(裁定 R29):字节由预置脚本写进 CAS、由跑在
 * 编辑会话里的 setText effect 读,两边都拿得到会话身份;而租户级的登记表
 * 天然没有 sessionId,拿不到。
 */

/** 覆盖的码位区间,合并后按起点升序排列,区间之间不重叠也不相邻。 */
export type FontCoverage = readonly (readonly [number, number])[];

export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  /** CAS 里字体文件的内容哈希。 */
  readonly hash: string;
  /**
   * 从字体文件**解析**出来的,不是登记时人工填的。
   *
   * **排版不读这个字段** —— layoutText / rasterizeGlyphs 用的都是
   * face.unitsPerEm,即渲染时从字节现解析的值。这里这份是给运维看的
   * (登记了什么、对不对得上),改坏它不会影响任何输出。
   * 早先这条注释写的是"填错了字还是那些字、位置全错" —— 那是错的,
   * 而且误导了一轮测试补强:注入"写死 1000"之后全绿的真正原因不是测试字体
   * 的 upm 恰好都是 1000,是**这个字段本来就没有可观测后果**。family 同理。
   */
  readonly unitsPerEm: number;
  readonly coverage: FontCoverage;
}

/**
 * 作用域是 (stackId, tenantId),跨会话存活。适配器构造时绑定这两段身份,
 * 所以方法签名里没有它们。
 */
export interface FontRegistry {
  list(): Promise<readonly FontEntry[]>;
  /** 幂等:同一个 postScriptName 重登记覆盖旧的一条,不是报冲突 ——
   *  预置脚本每次跑都会把配置里的全套字体登记一遍。 */
  put(entry: FontEntry): Promise<void>;
}

/** createSBlob 只收 64 位小写十六进制;登记时就挡住,别留到 setText 才炸。 */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CODE_POINT = 0x10ffff;

/**
 * 校验一条登记载荷。合法返回 null,否则返回**说得出哪一条不对**的原因。
 *
 * coverage 的形状是硬要求,不是洁癖:selectFonts(doctype-psd 的
 * text/registry.ts)用二分查找判一个码位有没有被覆盖,喂给它一个乱序或重叠的
 * 区间数组,查找会**静默返回错的结果** —— 那个字被判成"这套字体不认识",然后
 * 掉到回退链上,没有任何东西会报错。写入侧是唯一挡得住的地方。
 */
export function fontEntryProblem(value: unknown): string | null {
  // ↓ 从 cloudflare-psd/src/fonts-do.ts:99-155 逐字搬运,连同 coverageProblem
  //   与 isCodePoint 两个私有辅助。行为必须一字不差 —— 上面那个测试文件就是
  //   从它原来的测试搬过来的,任何措辞改动都会让断言失败。
}
```

搬运 `coverageProblem` 与 `isCodePoint` 时保留原注释。

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 从 index.ts 导出，并把三个消费方改成 re-export / import**

`packages/doctype-server-common/src/index.ts` 加一行：

```ts
export * from "./font-registry.js";
```

`packages/doctype-psd/src/text/opentype-face.ts:22` 改为：

```ts
// FontCoverage 住在中立层(doctype-server-common/src/font-registry.ts):中立的
// 字体路由处理器要引用 FontEntry,而依赖方向是 doctype-psd → server-common,
// 反过来不行。这里 re-export 是为了让本包内既有的 import 一行都不用改 ——
// 删掉它会静默断开一批引用。
export type { FontCoverage } from "@unidocs/doctype-server-common";
```

`packages/doctype-psd/src/text/registry.ts` 的 `FontEntry` 定义整块删除，改为：

```ts
// 同 opentype-face.ts 的 FontCoverage:类型下沉到中立层,这里保留 re-export
// 让本包与外部既有 import 不受影响。
export type { FontEntry } from "@unidocs/doctype-server-common";
```

`packages/cloudflare-psd/src/fonts-do.ts` 删掉 `fontEntryProblem` / `coverageProblem` / `isCodePoint` / `HASH_PATTERN` / `MAX_CODE_POINT`，改为：

```ts
import { fontEntryProblem } from "@unidocs/doctype-server-common";
```

并把 `fonts-do.test.ts` 里的 `describe("fontEntryProblem")` 整块删除（已搬走），保留其余 describe。

- [ ] **Step 6: 全量验证**

Run:
```bash
pnpm --filter @unidocs/doctype-server-common test
pnpm --filter @unidocs/doctype-psd test
pnpm --filter @unidocs/cloudflare-psd test
pnpm --filter @unidocs/doctype-psd typecheck
pnpm --filter @unidocs/cloudflare-psd typecheck
```
Expected: 全部通过。若 `doctype-psd` 报循环依赖或找不到类型，检查 `packages/doctype-psd/tsconfig.json` 的 `references` 是否已含 `doctype-server-common`（它在 dependencies 里，应当已有）。

- [ ] **Step 7: Commit**

```bash
git add packages/doctype-server-common packages/doctype-psd packages/cloudflare-psd
git commit -m "refactor(fonts): FontEntry 与 fontEntryProblem 下沉到中立层

契约要跨平台,类型就得住在依赖方向的下游 —— 中立的字体路由处理器要引用
FontEntry,而 doctype-psd → doctype-server-common 这个方向不可逆。

FontEntry 的字段全是字体文件的存储元数据(内容哈希、upm、码位覆盖),不是
PSD 的文档语义;需要字体的也不止 PSD。所以这次下沉不只是\"不得不\",本身
也是对的。

fontEntryProblem 跟着一起下沉:写入侧的校验是挡住乱序 coverage 的唯一位置,
留在 cloudflare-psd 里,Azure 那条路会绕过它。两处 re-export 保留,既有
import 一行不用改。"
```

---

### Task 2: `MemoryFontRegistry` 与共享契约测试

**Files:**
- Modify: `packages/doctype-server-common/src/memory-ports.ts`
- Create: `packages/doctype-server-common/src/testing/font-registry-contract.ts`
- Create: `packages/doctype-server-common/tests/font-registry-memory.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry` / `FontEntry`
- Produces: `createMemoryFontRegistry(): FontRegistry`；`runFontRegistryContract(label: string, make: () => Promise<FontRegistry>): void`

- [ ] **Step 1: 写契约测试（先失败）**

`packages/doctype-server-common/src/testing/font-registry-contract.ts`：

```ts
/**
 * FontRegistry 的共享契约测试。两个平台的适配器都跑同一份 —— 这是"两边行为
 * 一致"唯一能被机器验证的地方,与 testing/port-contract.ts 同一个思路。
 */
import { describe, expect, it } from "vitest";
import type { FontEntry, FontRegistry } from "../font-registry.js";

const noto: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};
const josefin: FontEntry = {
  postScriptName: "JosefinSans-Bold",
  family: "Josefin Sans",
  hash: "b".repeat(64),
  unitsPerEm: 2048,
  coverage: [[0x20, 0x7e]],
};

export function runFontRegistryContract(
  label: string,
  make: () => Promise<FontRegistry>,
): void {
  describe(label, () => {
    it("空登记表返回空数组,不是抛错", async () => {
      expect(await (await make()).list()).toEqual([]);
    });

    it("登记后能读回,字段逐一对上", async () => {
      const registry = await make();
      await registry.put(noto);
      expect(await registry.list()).toEqual([noto]);
    });

    it("同名登记两次只剩一条,且是后一条 —— 预置脚本每次跑都会全量登记一遍", async () => {
      const registry = await make();
      await registry.put(noto);
      await registry.put({ ...noto, hash: "c".repeat(64), family: "Noto Sans 2" });
      const rows = await registry.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.hash).toBe("c".repeat(64));
      expect(rows[0]?.family).toBe("Noto Sans 2");
    });

    it("多条按 postScriptName 升序返回 —— 顺序稳定,回退链的选择才可复现", async () => {
      const registry = await make();
      await registry.put(noto);
      await registry.put(josefin);
      expect((await registry.list()).map(e => e.postScriptName))
        .toEqual(["JosefinSans-Bold", "NotoSans-Regular"]);
    });

    it("coverage 原样往返,不被 JSON 序列化改形状", async () => {
      const registry = await make();
      const wide: FontEntry = { ...noto, coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]] };
      await registry.put(wide);
      expect((await registry.list())[0]?.coverage).toEqual([[0x20, 0x7e], [0x4e00, 0x9fff]]);
    });
  });
}
```

`packages/doctype-server-common/tests/font-registry-memory.test.ts`：

```ts
import { runFontRegistryContract } from "../src/testing/font-registry-contract.js";
import { createMemoryFontRegistry } from "../src/memory-ports.js";

runFontRegistryContract("MemoryFontRegistry", async () => createMemoryFontRegistry());
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-memory.test.ts`
Expected: FAIL — `createMemoryFontRegistry is not a function`

- [ ] **Step 3: 实现 `createMemoryFontRegistry`**

在 `packages/doctype-server-common/src/memory-ports.ts` 末尾加：

```ts
/** 进程内的 FontRegistry —— 单测与本地夹具用,不持久化。 */
export function createMemoryFontRegistry(): FontRegistry {
  const rows = new Map<string, FontEntry>();
  return {
    async list() {
      return [...rows.values()].sort(
        (a, b) => a.postScriptName < b.postScriptName ? -1 : a.postScriptName > b.postScriptName ? 1 : 0,
      );
    },
    async put(entry) {
      rows.set(entry.postScriptName, entry);
    },
  };
}
```

并在文件顶部的 import 里加上 `FontEntry` / `FontRegistry`（来自 `./font-registry.js`）。

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-memory.test.ts`
Expected: PASS（5 条）

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-server-common
git commit -m "test(fonts): FontRegistry 的共享契约测试与内存实现

两个平台的适配器跑同一份契约,是\"两边行为一致\"唯一能被机器验证的地方。
与 testing/port-contract.ts 同一个思路。"
```

---

### Task 3: 中立路由与中立的 fonts 端点处理器

**Files:**
- Modify: `packages/protocol-doc/src/routes.ts`
- Create: `packages/doctype-server-common/src/font-registry-handler.ts`
- Create: `packages/doctype-server-common/tests/font-registry-handler.test.ts`
- Modify: `packages/protocol-doc/tests/`（新增 `matchFontsRoute` 用例，从 `cloudflare-psd/tests/fonts-do.test.ts` 的 `describe("matchFontsRoute")` 整块搬来）

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry` / `fontEntryProblem`
- Produces:
  - `matchFontsRoute(pathname: string): { tenantId: string } | null`（`@unidocs/protocol-doc`）
  - `type TenantOperation = "listFonts" | "registerFont"`（`@unidocs/protocol-doc`）
  - `handleFontsRequest(cfg: FontsRequestConfig, request: Request, route: { tenantId: string }): Promise<Response>`（`@unidocs/doctype-server-common`），其中
    ```ts
    interface FontsRequestConfig {
      readonly docCapabilityVerifier: DocCapabilityVerifier;
      readonly registry: FontRegistry;
      readonly audit?: (event: FontsAuditEvent) => void;
    }
    interface FontsAuditEvent {
      readonly credentialKind: "capability";
      readonly operation: TenantOperation;
      readonly tenantId: string;
      readonly kid?: string;
      readonly jti?: string;
    }
    ```

- [ ] **Step 1: 把 `matchFontsRoute` 搬进 `protocol-doc` 并让其测试失败**

`packages/protocol-doc/src/routes.ts` 末尾加（**不要**改 `matchDocRoute`）：

```ts
/**
 * 租户级路由,与 matchDocRoute 平行。
 *
 * 后者硬性要求 parts[2] === "sessions",只认会话级路径 —— 这就是租户级端点
 * 在中立层没有落脚点、当初只能在 cloudflare-psd 里自建一套的原因。
 *
 * 只按路径匹配,不按方法:方法不认识时由字体处理器回 405,而不是在这里返回
 * null —— 返回 null 会落回 createDocTypeHandler,那边不认识这条路径,答的是
 * 404 "Unknown Doc endpoint",把"方法用错了"说成"这个端点不存在"。
 */
export interface FontsRoute {
  readonly tenantId: string;
}

/** 租户级 operation。**刻意不并入 DocOperation**:后者喂给网关的
 *  docCapabilityPolicy 是个无 default 的穷尽 switch,加成员会强迫为两个根本
 *  不走网关的操作编一套 deadline 策略。 */
export type TenantOperation = "listFonts" | "registerFont";

export function matchFontsRoute(pathname: string): FontsRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "tenants" || parts[2] !== "fonts") return null;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return tenantId.length === 0 ? null : { tenantId };
}
```

测试：把 `packages/cloudflare-psd/tests/fonts-do.test.ts` 的 `describe("matchFontsRoute", ...)`（第 191–207 行）整块搬到 `packages/protocol-doc/tests/routes-fonts.test.ts`，import 改成 `../src/routes.js`。

- [ ] **Step 2: 跑，确认新位置的测试通过、旧位置已删除**

Run: `pnpm --filter @unidocs/protocol-doc exec vitest run tests/routes-fonts.test.ts`
Expected: PASS

- [ ] **Step 3: 写中立处理器的失败测试**

`packages/doctype-server-common/tests/font-registry-handler.test.ts`：

```ts
/**
 * /tenants/{t}/fonts 的中立处理器。
 *
 * 鉴权规则从 cloudflare-psd/src/fonts-do.ts 的 authenticateFontsRoute 逐条
 * 搬来,一条都不放松 —— 尤其"只接受 sessions:create 这一种权限"和"拒绝委派的
 * CAS 权限"(R29:这个端点背后不碰 CAS,多带一份权柄是调用方搞错了)。
 */
import { describe, expect, it } from "vitest";
import { handleFontsRequest } from "../src/font-registry-handler.js";
import { createMemoryFontRegistry } from "../src/memory-ports.js";
import type { FontEntry } from "../src/font-registry.js";

const TENANT = "t1";
const entry: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};

/** 只认一个 token 的假校验器,形状与 DocCapabilityVerifier 一致。 */
function verifierAccepting(permissions: readonly string[]) {
  return {
    async verify(token: string) {
      if (token !== "good") throw new Error("bad token");
      return {
        protectedHeader: { kid: "kid-1" },
        claims: { sub: "gateway", jti: "jti-1", tenantId: TENANT, permissions },
      };
    },
  } as never;
}

function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://svc/tenants/${TENANT}/fonts`, {
    method,
    headers: { Authorization: "Bearer good", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("handleFontsRequest", () => {
  const cfg = () => ({
    docCapabilityVerifier: verifierAccepting([`tenants:${TENANT}:sessions:create`]),
    registry: createMemoryFontRegistry(),
  });

  it("GET 列出登记表", async () => {
    const c = cfg();
    await c.registry.put(entry);
    const res = await handleFontsRequest(c, req("GET"), { tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fonts: [entry] });
  });

  it("POST 登记一条,再 GET 能读回", async () => {
    const c = cfg();
    const res = await handleFontsRequest(c, req("POST", entry), { tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(await c.registry.list()).toEqual([entry]);
  });

  it("方法不对回 405,不是 404 —— 别把\"方法用错\"说成\"端点不存在\"", async () => {
    const res = await handleFontsRequest(cfg(), req("DELETE"), { tenantId: TENANT });
    expect(res.status).toBe(405);
  });

  it("校验不过的载荷回 400 且不落库", async () => {
    const c = cfg();
    const res = await handleFontsRequest(c, req("POST", { ...entry, coverage: [] }), { tenantId: TENANT });
    expect(res.status).toBe(400);
    expect(await c.registry.list()).toEqual([]);
  });

  it("body 不是 JSON 回 400", async () => {
    const c = cfg();
    const bad = new Request(`https://svc/tenants/${TENANT}/fonts`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: "{oops",
    });
    expect((await handleFontsRequest(c, bad, { tenantId: TENANT })).status).toBe(400);
  });

  it("权限不是租户级的 sessions:create 就拒 —— 索引是租户级的,会话权限与它无关", async () => {
    const c = {
      docCapabilityVerifier: verifierAccepting([`tenants:${TENANT}:sessions:s1:write`]),
      registry: createMemoryFontRegistry(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(403);
  });

  it("带了委派的 CAS 权限就拒 —— R29:这个端点不碰 CAS,多带一份权柄是调用方搞错了", async () => {
    const res = await handleFontsRequest(
      cfg(),
      req("GET", undefined, { "X-UniDocs-CAS-Capability": "whatever" }),
      { tenantId: TENANT },
    );
    expect(res.status).toBe(403);
  });

  it("审计事件报出 operation 与 tenantId,不含 token", async () => {
    const events: unknown[] = [];
    await handleFontsRequest(
      { ...cfg(), audit: e => events.push(e) },
      req("GET"),
      { tenantId: TENANT },
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain("listFonts");
    expect(JSON.stringify(events[0])).not.toContain("good");
  });
});
```

- [ ] **Step 4: 跑，确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-handler.test.ts`
Expected: FAIL — 找不到 `../src/font-registry-handler.js`

- [ ] **Step 5: 实现 `font-registry-handler.ts`**

把 `cloudflare-psd/src/fonts-do.ts` 的 `handleFontsRequest` + `authenticateFontsRoute`（第 275–365 行）搬过来，做两处改造：

1. `cfg.namespace` / `cfg.objectName` 换成 `cfg.registry: FontRegistry`；
2. 转发那一段换成直接读写 registry：

```ts
  const stub = ...  // ← 删掉整段转发
```
改为
```ts
  if (request.method === "GET") {
    return Response.json({ fonts: await cfg.registry.list() });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const problem = fontEntryProblem(body);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  await cfg.registry.put(body as FontEntry);
  return Response.json({ success: true });
```

`authenticateFontsRoute` 连同它那三段注释（为什么用 `sessionCreatePermission`、为什么拒绝 CAS 委派、R30 为什么不发明新授权模型）**逐字保留**。

- [ ] **Step 6: 跑，确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-handler.test.ts`
Expected: PASS（8 条）

- [ ] **Step 7: Commit**

```bash
git add packages/protocol-doc packages/doctype-server-common packages/cloudflare-psd
git commit -m "feat(fonts): 租户级路由与 fonts 端点处理器下沉到中立层

matchFontsRoute 进 protocol-doc,与 matchDocRoute 平行 —— 后者硬性要求
parts[2] === \"sessions\",这就是租户级端点当初只能在 cloudflare-psd 里自建
一套的原因。

TenantOperation 是独立的 union,刻意不并入 DocOperation:后者喂给网关的
docCapabilityPolicy 是无 default 的穷尽 switch,加成员会强迫为两个根本不走
网关的操作编一套 deadline 策略。

处理器改成收一个 FontRegistry 而不是 DO namespace,鉴权规则逐条搬过来一条
没放松 —— 尤其只接受租户级的 sessions:create、以及拒绝委派的 CAS 权限。"
```

---

### Task 4: Cloudflare 适配器，worker 改走中立处理器

**Files:**
- Create: `packages/cloudflare-psd/src/font-registry-do.ts`
- Create: `packages/cloudflare-psd/tests/font-registry-do.test.ts`
- Modify: `packages/cloudflare-psd/src/fonts-do.ts`（删 `matchFontsRoute` / `FontsRoute` / `handleFontsRequest` / `authenticateFontsRoute` / `FontsRequestConfig` / `FontsAuditEvent`；保留 `FONTS_INTERNAL_PATH`、`fontsObjectName`、`PsdFontsDurableObject`）
- Modify: `packages/cloudflare-psd/src/worker.ts:133-150`

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry`，Task 3 的 `handleFontsRequest` / `matchFontsRoute`
- Produces: `createDoFontRegistry(opts: { namespace: DurableObjectNamespace; objectName: string }): FontRegistry`

- [ ] **Step 1: 写适配器的契约测试（先失败）**

`packages/cloudflare-psd/tests/font-registry-do.test.ts`：复用 Task 2 的契约，后端换成真 DO。参照现有 `fonts-do.test.ts` 顶部用 `node:sqlite` 的 `DatabaseSync` 造 `DurableObjectState` 假体的做法（第 11–63 行），把它抽成本文件的 `makeStubNamespace()`：

```ts
import { runFontRegistryContract } from "@unidocs/doctype-server-common/testing/font-registry-contract";
import { createDoFontRegistry } from "../src/font-registry-do.js";
// makeStubNamespace 复用 fonts-do.test.ts 里既有的 sqlite 假体构造,
// 把 PsdFontsDurableObject 包成一个只有 get/idFromName 的 namespace。

runFontRegistryContract("createDoFontRegistry", async () =>
  createDoFontRegistry({ namespace: makeStubNamespace(), objectName: "s1|t1" }));
```

> 若 `@unidocs/doctype-server-common` 未导出 `testing/` 子路径，按该包 `package.json` 的 `exports` 既有写法补一条（`./testing/*`），与 `./agent` 同形。

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/font-registry-do.test.ts`
Expected: FAIL — 找不到 `../src/font-registry-do.js`

- [ ] **Step 3: 写适配器**

```ts
/**
 * FontRegistry 的 Cloudflare 实现 —— 薄适配层,把 list/put 映到现有字体 DO 的
 * GET/POST。
 *
 * DO 内部与它的 sqlite 表**刻意不动**:线上已有登记数据,而这次要解决的是
 * "Azure 没有实现",不是"CF 的实现不好"。表的五个具名列与 FontEntry 一比一
 * 对上,所以这里不需要任何打包/拆包。
 */
import { FONTS_INTERNAL_PATH } from "./fonts-do.js";
import type { FontEntry, FontRegistry } from "@unidocs/doctype-server-common";

export function createDoFontRegistry(opts: {
  readonly namespace: DurableObjectNamespace;
  readonly objectName: string;
}): FontRegistry {
  const stub = () => opts.namespace.get(opts.namespace.idFromName(opts.objectName));
  return {
    async list() {
      const response = await stub().fetch(`http://psd-fonts${FONTS_INTERNAL_PATH}`, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Font index request failed ${response.status}: ${await response.text()}`);
      }
      const body = await response.json() as { fonts?: unknown };
      if (!Array.isArray(body.fonts)) throw new Error("Font index response has no fonts array");
      return body.fonts as FontEntry[];
    },
    async put(entry) {
      const response = await stub().fetch(`http://psd-fonts${FONTS_INTERNAL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!response.ok) {
        throw new Error(`Font registration failed ${response.status}: ${await response.text()}`);
      }
    },
  };
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/font-registry-do.test.ts`
Expected: PASS（5 条契约）

- [ ] **Step 5: worker 改走中立处理器**

`packages/cloudflare-psd/src/worker.ts` 的 fetch 分支改为：

```ts
    const fonts = matchFontsRoute(new URL(request.url).pathname);
    if (fonts) {
      if (!env.PSD_FONTS) {
        return Response.json({ error: "Fonts index is not configured" }, { status: 501 });
      }
      return handleFontsRequest({
        docCapabilityVerifier: auth.docCapabilityVerifier,
        registry: createDoFontRegistry({
          namespace: env.PSD_FONTS,
          objectName: fontsObjectName({ stackId: env.CAS_STACK_ID, tenantId: fonts.tenantId }),
        }),
        audit: event => console.log(JSON.stringify({
          event: "doc_authentication",
          docType: "psd",
          ...event,
        })),
      }, request, fonts);
    }
```

import 来源相应改为 `@unidocs/protocol-doc`（`matchFontsRoute`）与 `@unidocs/doctype-server-common`（`handleFontsRequest`）。`fonts-do.ts` 删掉已搬走的六个导出。

- [ ] **Step 6: 全量验证 CF 侧行为未变**

Run:
```bash
pnpm --filter @unidocs/cloudflare-psd test
pnpm --filter @unidocs/cloudflare-psd typecheck
```
Expected: 全部通过，尤其 `worker-routing.test.ts` 与 `fonts-do.test.ts` 剩余部分。

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare-psd
git commit -m "refactor(fonts): CF 侧改走中立处理器,DO 退到 FontRegistry 之后

新增的适配器只是把 list/put 映到现有 DO 的 GET/POST —— DO 内部与它的 sqlite
表刻意不动,线上已有登记数据不受影响。表的五个具名列与 FontEntry 一比一对上,
不需要任何打包拆包。

worker 的 fonts 分支改用中立的 handleFontsRequest,fonts-do.ts 里已搬走的
路由与鉴权删除。CF 侧对外行为一字未变,由既有测试守着。"
```

---

### Task 5: 中立的 `FontIndexSource`

**Files:**
- Create: `packages/doctype-psd/src/text/font-index.ts`
- Create: `packages/doctype-psd/tests/font-index.test.ts`
- Modify: `packages/cloudflare-psd/src/fonts-source.ts`（缩成接线）
- Modify: `packages/cloudflare-psd/tests/fonts-source.test.ts`（缓存相关用例搬到 `doctype-psd`）

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry`；既有的 `FontIndexSource`（`doctype-psd/src/text/set-text.ts:47`）
- Produces: `createFontIndex(opts: { registry: FontRegistry; fallbacks: readonly string[]; blobFor: (entry: FontEntry) => SBlob; now?: () => number }): FontIndexSource`

- [ ] **Step 1: 把缓存用例搬来并让它失败**

`packages/doctype-psd/tests/font-index.test.ts`：从 `cloudflare-psd/tests/fonts-source.test.ts` 搬三条不变式的用例——TTL 内只打一次后端、TTL 过期后重打、失败不留在缓存里（一次抖动不该被记住整个 TTL）。后端用一个计数的假 `FontRegistry`。

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/font-index.test.ts`
Expected: FAIL — 找不到 `../src/text/font-index.js`

- [ ] **Step 3: 实现**

把 `cloudflare-psd/src/fonts-source.ts` 的 `INDEX_TTL_MS`、`load()` 缓存逻辑（第 22–68 行）逐字搬过来，`fetchIndex` 改成 `registry.list()` 再转成 `Map`，`blobFor` 改由调用方注入（CF 传 `createSBlob`，Azure 传自己的）。原有两段注释（为什么缓存 Promise、为什么失败不入缓存、为什么 TTL 是一分钟）逐字保留。

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/font-index.test.ts`
Expected: PASS

- [ ] **Step 5: `fonts-source.ts` 缩成接线并验证**

`createFontIndexSource` 改为构造 `createDoFontRegistry` + `createFontIndex`，`parseFontFallbacks` 原地保留。

Run: `pnpm --filter @unidocs/cloudflare-psd test && pnpm --filter @unidocs/doctype-psd test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add packages/doctype-psd packages/cloudflare-psd
git commit -m "refactor(fonts): FontIndexSource 合并成一个中立实现

60 秒缓存那段从 cloudflare-psd 搬进 doctype-psd,两边共用。它的两条不变式
连同注释一起搬:缓存的是 Promise 不是结果(并发的两次 setText 只该打一次
后端),失败不留在缓存里(否则一次抖动被整整记住一个 TTL)。

平台差异至此收敛到 FontRegistry 那一层。"
```

---

### Task 6: Azure 的 Postgres 适配器与迁移

**Files:**
- Create: `packages/azure-sdk/migrations/0005_font_registry.sql`
- Create: `packages/azure-sdk/src/font-registry-pg.ts`
- Create: `packages/azure-sdk/tests/font-registry-pg.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry`，Task 2 的 `runFontRegistryContract`
- Produces: `class PgFontRegistry implements FontRegistry`，构造签名 `constructor(q: Queryable, scope: { stackId: string; tenantId: string })`——与 `PgDeltaLog(q, identity)` 同形。

- [ ] **Step 1: 写迁移**

`packages/azure-sdk/migrations/0005_font_registry.sql`：

```sql
-- 租户级字体登记表。作用域是 (stack_id, tenant_id) —— 不含 session:
-- 同一租户下所有 psd 文档共用一套字体。
--
-- 带 stack_id 不是冗余:字体字节在 CAS 里的键是
-- stacks/{stackId}/tenants/{tenantId}/nodes-v2/{hash},stack 和 tenant 两段
-- 都在键里。换一个 stack 那些字节就已经不在了,索引必须跟着换作用域,
-- 否则会得到一张指向不存在字节的索引,而那种失效是静默的。
CREATE TABLE IF NOT EXISTS font_registry (
  stack_id         text    NOT NULL,
  tenant_id        text    NOT NULL,
  post_script_name text    NOT NULL,
  family           text    NOT NULL,
  hash             text    NOT NULL,
  units_per_em     integer NOT NULL,
  coverage         jsonb   NOT NULL,
  PRIMARY KEY (stack_id, tenant_id, post_script_name)
);
```

- [ ] **Step 2: 写契约测试，确认失败**

`packages/azure-sdk/tests/font-registry-pg.test.ts`：照 `packages/azure-sdk/tests/ports.test.ts` 既有的 Postgres 夹具做法（compose 起的库 + 每个用例一个独立 scope），跑 Task 2 的契约：

```ts
import { runFontRegistryContract } from "@unidocs/doctype-server-common/testing/font-registry-contract";
import { PgFontRegistry } from "../src/font-registry-pg.js";
// pool / migrate 的取法与 tests/ports.test.ts 一致。

let n = 0;
runFontRegistryContract("PgFontRegistry", async () =>
  new PgFontRegistry(pool, { stackId: "s1", tenantId: `t${++n}` }));
```

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/font-registry-pg.test.ts`
Expected: FAIL — 找不到 `../src/font-registry-pg.js`

- [ ] **Step 3: 实现 `PgFontRegistry`**

```ts
/**
 * FontRegistry 的 Postgres 实现。
 *
 * 与 ports-pg.ts 的几个 port 刻意分开成独立文件:那些都绑一个 sessionId,
 * 这个只绑 (stackId, tenantId)。放在一起会让"每个 port 一个会话"这条读起来
 * 显然的性质变得需要逐个确认。
 */
import type { FontEntry, FontRegistry } from "@unidocs/doctype-server-common";
import type { Queryable } from "./ports-pg.js";

export interface FontRegistryScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export class PgFontRegistry implements FontRegistry {
  #q: Queryable;
  #scope: FontRegistryScope;

  constructor(q: Queryable, scope: FontRegistryScope) {
    this.#q = q;
    this.#scope = scope;
  }

  async list(): Promise<readonly FontEntry[]> {
    const { rows } = await this.#q.query(
      `SELECT post_script_name, family, hash, units_per_em, coverage
         FROM font_registry
        WHERE stack_id = $1 AND tenant_id = $2
        ORDER BY post_script_name`,
      [this.#scope.stackId, this.#scope.tenantId],
    );
    return rows.map((row: Record<string, unknown>) => ({
      postScriptName: row.post_script_name as string,
      family: row.family as string,
      hash: row.hash as string,
      unitsPerEm: Number(row.units_per_em),
      // pg 把 jsonb 解析成 JS 值,不需要再 JSON.parse。
      coverage: row.coverage as FontEntry["coverage"],
    }));
  }

  /** 幂等,与 CF 侧 INSERT OR REPLACE 同语义。 */
  async put(entry: FontEntry): Promise<void> {
    await this.#q.query(
      `INSERT INTO font_registry
         (stack_id, tenant_id, post_script_name, family, hash, units_per_em, coverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stack_id, tenant_id, post_script_name) DO UPDATE
         SET family = EXCLUDED.family,
             hash = EXCLUDED.hash,
             units_per_em = EXCLUDED.units_per_em,
             coverage = EXCLUDED.coverage`,
      [
        this.#scope.stackId,
        this.#scope.tenantId,
        entry.postScriptName,
        entry.family,
        entry.hash,
        entry.unitsPerEm,
        JSON.stringify(entry.coverage),
      ],
    );
  }
}
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/font-registry-pg.test.ts`
Expected: PASS（5 条契约）。需要 Docker（`pnpm azure:up`）。

- [ ] **Step 5: Commit**

```bash
git add packages/azure-sdk
git commit -m "feat(azure): FontRegistry 的 Postgres 实现与迁移

与 CF 的 DO 版跑同一份共享契约测试 —— 这是两边行为一致唯一能被机器验证的
地方。表带 stack_id 不是冗余:字体字节在 CAS 里的键含 stack 和 tenant 两段,
换 stack 那些字节就不在了,索引必须同作用域,否则会得到一张指向不存在字节的
索引,而那种失效是静默的。

独立成文件而不是并进 ports-pg.ts:那里每个 port 都绑一个 sessionId。"
```

---

### Task 7: Azure 的 agent 由值改为按身份构造的工厂

**Files:**
- Modify: `packages/azure-sdk/src/local-operator.ts:53-70`（`LocalOperatorDeps.agent`）
- Modify: `packages/azure-sdk/src/doc-type-service.ts:89,252-257,308,332`
- Modify: `packages/azure-sdk/tests/`（既有 operator 测试的构造处）

**Interfaces:**
- Produces: `LocalOperatorDeps.agent: (identity: SessionIdentity) => DocumentAgent<TQuery, TOp>`；`RunDocTypeServiceOptions.documentAgent?: (identity: SessionIdentity) => DocumentAgent<TQuery, TOp>`

- [ ] **Step 1: 写失败测试**

在 `packages/azure-sdk/tests/` 既有的 operator 测试里加一条：两次 `/run` 带不同的 `X-Tenant-Id`，断言工厂被调用两次且各自拿到对应的 `tenantId`。

理由写进注释：**字体索引是租户级的，agent 在启动期构造一次就永远拿不到租户**——这是 Azure 侧接不上 `setText` 的结构性障碍，与 CF 的 `agent: (env, identity) => ...` 对齐。

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/`
Expected: FAIL — 类型错误或工厂未被调用

- [ ] **Step 3: 改签名**

`local-operator.ts` 的 `deps.agent` 由 `DocumentAgent<TQuery, TOp>` 改为 `(identity: SessionIdentity) => DocumentAgent<TQuery, TOp>`，在 `captureIdentity` 拿到身份之后调用。`doc-type-service.ts` 的 `documentAgent` 同步改成工厂并透传；`documentAgent` 与 `llmProvider` 必须同时提供的既有检查保持不变。

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/azure-sdk test && pnpm --filter @unidocs/azure-sdk typecheck`
Expected: PASS

- [ ] **Step 5: 三个 doc service 入口跟着改**

`packages/azure-markdown/src/main.ts`、`packages/azure-docx/src/main.ts`、`packages/azure-psd/src/main.ts` 的 `documentAgent:` 由值改为 `() => 值`（psd 在 Task 8 再进一步）。

Run: `pnpm --filter @unidocs/azure-markdown typecheck && pnpm --filter @unidocs/azure-docx typecheck && pnpm --filter @unidocs/azure-psd typecheck`
Expected: 干净

- [ ] **Step 6: Commit**

```bash
git add packages/azure-sdk packages/azure-markdown packages/azure-docx packages/azure-psd
git commit -m "refactor(azure): documentAgent 改为按会话身份构造的工厂

字体索引是租户级的,而 Azure 原来在启动期把 agent 构造一次 —— 那时没有租户,
永远拿不到。这是 Azure 侧接不上 setText 的结构性障碍,不是漏了一行注入。

CF 侧本来就是 agent: (env, identity) => createPsdAgent(...),这次是对齐它。"
```

---

### Task 8: Azure psd 接线与 fonts 路由

**Files:**
- Create: `packages/azure-psd/src/agent-deps.ts`
- Create: `packages/azure-psd/tests/agent-deps.test.ts`
- Modify: `packages/azure-psd/src/main.ts`
- Modify: `packages/azure-sdk/src/doc-type-service.ts`（挂 fonts 路由）
- Modify: `packages/azure-psd/package.json`（加 `test` 脚本，照 `cloudflare-psd` 的写法）

**Interfaces:**
- Consumes: Task 5 的 `createFontIndex`，Task 6 的 `PgFontRegistry`，Task 7 的工厂签名
- Produces: `psdAgentDeps(env: NodeJS.ProcessEnv, identity: SessionIdentity, pool: Queryable): PsdAgentDeps`

- [ ] **Step 1: 写失败测试**

`packages/azure-psd/tests/agent-deps.test.ts`，与 `cloudflare-psd/tests/agent-deps.test.ts` 对称：

```ts
/**
 * 接线本身要能测。
 *
 * CF 侧把这段从 worker 里拆出来的理由记在 worker.ts:51-56:内联时"把
 * PSD_FONT_FALLBACKS 换成 [] 整套单测照样全绿"。Azure 侧原来内联在 main.ts
 * 里,连 tests 目录都没有 —— 同一课在这边没学到,而这正是 setText 缺席三周
 * 没被发现的一半原因。
 */
import { describe, expect, it } from "vitest";
import { psdAgentDeps } from "../src/agent-deps.js";

const identity = { docType: "psd", sessionId: "s1", tenantId: "t1" };
const pool = {} as never;

describe("psdAgentDeps", () => {
  it("没有 IMAGE_EDIT_API_KEY 就不注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).editor).toBeUndefined();
  });

  it("有 key 就注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" }, identity, pool).editor)
      .toBeDefined();
  });

  it("总是注入 fontIndex —— Postgres 后端不像 DO 绑定那样会漏配", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).fontIndex).toBeDefined();
  });

  it("回退链从 PSD_FONT_FALLBACKS 解析,顺序即优先级", () => {
    const deps = psdAgentDeps(
      { CAS_STACK_ID: "s", PSD_FONT_FALLBACKS: "NotoSans, NotoSansSC" },
      identity,
      pool,
    );
    expect(deps.fontIndex?.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter @unidocs/azure-psd exec vitest run`
Expected: FAIL — 找不到 `../src/agent-deps.js`

- [ ] **Step 3: 写 `agent-deps.ts` 并让 `main.ts` 只负责调用**

`psdAgentDeps` 构造 `editor`（条件，同现状）与 `fontIndex`（`createFontIndex({ registry: new PgFontRegistry(pool, { stackId: env.CAS_STACK_ID, tenantId: identity.tenantId }), fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS), blobFor: entry => createSBlob(entry.hash) })`）。

`parseFontFallbacks` 从 `cloudflare-psd` 搬到 `doctype-psd/src/text/font-index.ts` 一并导出（两边都要用，不能住在 CF 包里）。

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter @unidocs/azure-psd exec vitest run`
Expected: PASS（4 条）

- [ ] **Step 5: 在 Azure 服务上挂 fonts 路由**

`packages/azure-sdk/src/doc-type-service.ts` 的 handler 外面包一层：先 `matchFontsRoute`，命中就走 `handleFontsRequest`（registry 用 `new PgFontRegistry(pool, { stackId, tenantId })`），否则落回 `createDocTypeHandler`。与 CF 的 `worker.ts` 分流同形，注释指明为什么必须先分流（`matchDocRoute` 只认会话级路径）。

需要一个 `fontRegistryFor?: (tenantId: string) => FontRegistry` 的可选注入点，缺省时不挂这条路由（markdown/docx 不需要）。

- [ ] **Step 6: 端到端验证**

Run: `pnpm --filter @unidocs/azure-sdk test && pnpm --filter @unidocs/azure-psd typecheck && pnpm build`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add packages/azure-psd packages/azure-sdk
git commit -m "feat(azure): psd 接上 fontIndex,setText 出现在工具表里

接线拆成可测的 psdAgentDeps,与 CF 对称;packages/azure-psd 第一次有了 tests
目录 —— 它一直没有,是 setText 缺席三周没被发现的一半原因。

Azure 服务挂上 /tenants/{t}/fonts:必须在 createDocTypeHandler 之前分流,
matchDocRoute 只认会话级路径,交给它只会得到 404。"
```

---

### Task 9: 跨栈 parity 断言

**Files:**
- Create: `tests/unit/psd-agent-parity.test.mjs`

**Interfaces:**
- Consumes: `cloudflare-psd` 的 `psdAgentDeps`、`azure-psd` 的 `psdAgentDeps`、`doctype-psd` 的 `createPsdAgent`

- [ ] **Step 1: 写断言**

```js
/**
 * 两个栈的 psd agent 工具表必须一致。
 *
 * 这是本轮真正缺的守卫。setText 在 Azure 上缺席了三周,期间没有任何测试、
 * 日志或告警会说话 —— 工具表与提示词被刻意绑在同一个 if 里(避免幽灵工具),
 * 副作用是平台能力差异表现为一次礼貌的拒绝,而不是一个错误。
 *
 * 断言的是**工具名集合**,不是实现:两边的 editor / fontIndex 后端本来就不同,
 * 该一致的是"模型能看见哪些工具"。
 */
import { describe, expect, it } from "vitest";
import { createPsdAgent } from "@unidocs/doctype-psd";
import { psdAgentDeps as cfDeps } from "@unidocs/cloudflare-psd";
import { psdAgentDeps as azDeps } from "@unidocs/azure-psd";

const identity = { docType: "psd", sessionId: "s1", tenantId: "t1" };

describe("psd agent 跨栈 parity", () => {
  it("同等注入下,两个栈的工具名集合相等", () => {
    const cf = createPsdAgent(cfDeps(
      { CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k", PSD_FONTS: fakeNamespace() },
      identity,
    ));
    const az = createPsdAgent(azDeps(
      { CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" },
      identity,
      {},
    ));
    expect(new Set(az.tools.map(t => t.name))).toEqual(new Set(cf.tools.map(t => t.name)));
  });

  it("两个栈都含 setText 与 editPixels —— 集合相等但都是空,不算通过", () => {
    const az = createPsdAgent(azDeps(
      { CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" }, identity, {},
    ));
    const names = az.tools.map(t => t.name);
    expect(names).toContain("setText");
    expect(names).toContain("editPixels");
  });
});
```

第二条是刻意的：只断言"两个集合相等"，在两边都退化成空表时同样为真。

- [ ] **Step 2: 跑，确认通过**

Run: `npx vitest run tests/unit/psd-agent-parity.test.mjs`
Expected: PASS

- [ ] **Step 3: 反向验证这条断言真的有牙**

临时把 `azure-psd/src/agent-deps.ts` 的 `fontIndex` 注入注释掉，重跑，确认**两条都失败**；恢复。

这一步不可跳过：一条永远为真的 parity 断言比没有更糟。

- [ ] **Step 4: Commit**

```bash
git add tests/unit/psd-agent-parity.test.mjs
git commit -m "test(psd): 跨栈工具表 parity 断言

本轮真正缺的守卫。setText 在 Azure 上缺席三周,期间没有任何测试、日志或告警
会说话 —— 工具表与提示词绑在同一个 if 里(避免幽灵工具),副作用是平台能力
差异表现为一次礼貌的拒绝而不是错误。

第二条断言是刻意的:只比\"两个集合相等\",两边都退化成空表时同样为真。"
```

---

### Task 10: 预置脚本对两个栈通用 + 运维文档

**Files:**
- Modify: `scripts/seed-psd-fonts.mjs`
- Modify: `scripts/dev.mjs:72`（`psdFontsEnabled` 去掉 `!useAzure`）
- Modify: `scripts/psd-font-bootstrap.mjs`（URL 按栈选择）
- Modify: `stacks/unidocs-azure/README.md`（运维清单）
- Modify: `docs/psd-text-layers.md`（如含 CF-only 表述）

- [ ] **Step 1: 先验证 Azure 的 capability 签发形状与 CF 是否一致**

这是设计稿里记的风险 1。跑一次本地 Azure 栈，用现有 `createDocTokenFactory` 签一张票打 `GET /tenants/{t}/fonts`：

```bash
set -a; source .env.azure; set +a
pnpm dev unidocs-azure psd    # 另一个终端
```

若 401，则脚本需要一个 `--stack` 参数选择签发方式；若 200，脚本零改动即可。**先做这一步再改脚本**——它决定后面两步的形状。

- [ ] **Step 2: 让 `pnpm dev unidocs-azure psd` 自动预置**

`scripts/dev.mjs:72` 的 `psdFontsEnabled` 去掉 `!useAzure`，`psd-font-bootstrap.mjs` 的 URL 按 `UNIDOCS_LOCAL_PLATFORM` 选 Miniflare 8790 还是 Azure 41821。删掉 `dev.mjs:70-71` 那段"Azure 栈根本没有那个 worker"的注释——它已经不成立了。

- [ ] **Step 3: 真机验证**

```bash
pnpm dev unidocs-azure psd
```
Expected: 启动日志出现字体预置；浏览器里让 agent 改一个文字层的文字，成功。

- [ ] **Step 4: 写运维清单**

`stacks/unidocs-azure/README.md` 加一节「新环境的字体预置」：为什么是人工动作（字节不进仓库、不给部署加供应链依赖）、命令、以及漏跑的表现（`setText` 注册了但排不出字，不是启动失败）。

- [ ] **Step 5: Commit**

```bash
git add scripts stacks/unidocs-azure/README.md docs
git commit -m "feat(fonts): 预置脚本对两个栈通用,本地 Azure 栈自动预置

路由下沉之后同一个脚本指向哪个 service 就灌哪个,本地与线上同一条路径。
dev.mjs 里那句\"Azure 栈根本没有那个 worker\"已经不成立,一并删掉。

线上首次预置仍是人工动作,理由写进 README:字节进镜像违反 R19,构建时下载
等于给部署加一条供应链依赖。漏跑的表现是 setText 排不出字,不是启动失败 ——
所以它值得单独写一节。"
```

---

## Self-Review

**Spec coverage：**

| 设计稿要求 | 任务 |
| --- | --- |
| D1 契约独立成模块，不进 `ports.ts` | Task 1 |
| D2 具体 `FontRegistry`，不是泛型 | Task 1 |
| D3 `FontEntry` + `FontCoverage` 下沉，两处 re-export | Task 1 |
| D4 预置人工跑，不加部署 job | Task 10 |
| 中立路由 + 独立 `TenantOperation` | Task 3 |
| 鉴权逐条搬运（含拒绝 CAS 委派） | Task 3 |
| CF 适配器，DO 不重写 | Task 4 |
| Azure Pg 适配器 + 迁移 | Task 6 |
| `FontIndexSource` 合并成中立实现 | Task 5 |
| Azure 接线拆出来可测 + tests 目录 | Task 8 |
| parity 断言 | Task 9 |
| 共享契约测试两边都跑 | Task 2 / 4 / 6 |
| 风险 1（capability 形状） | Task 10 Step 1 |
| 风险 2（线上人工预置） | Task 10 Step 4 |
| 风险 3（re-export 被清理） | Task 1 Step 5 的注释 |

**计划自查中补上的一项：** 设计稿没写 Azure 的 `documentAgent` 是启动期构造的单个值、拿不到租户——这是接不上 `fontIndex` 的结构性障碍。已补为 Task 7，并连带三个 doc service 入口的签名改动。

**类型一致性：** `FontRegistry.list/put`、`createFontIndex`、`psdAgentDeps(env, identity, pool)`、`PgFontRegistry(q, scope)` 在各任务间用名一致。
