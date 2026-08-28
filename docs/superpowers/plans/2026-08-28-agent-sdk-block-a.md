# Agent SDK 区块 A（两层边界）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent 的工具调用循环从 Cloudflare 的 DurableObject 实现里剥出来，变成一份与文档类型和平台都无关的内核，并让 PSD 在 Cloudflare 上端到端跑在它上面。

**Architecture:** 内核住在 `packages/doctype-server-common/src/agent/`，通过两条契约与外界相连——上边界 `DocumentAgent`（文档类型提供一张纯数据的工具表），下边界 `AgentPlatform` / `LlmProvider`（平台提供文档读写和模型访问）。契约类型定义在 `packages/protocol`，内核实现和门面在 `doctype-server-common`。文档类型不再持有任何指向平台的句柄。

**Tech Stack:** TypeScript（ESM，`"type": "module"`）、vitest、pnpm workspace。无 eslint/biome，质量靠 `tsc` + `vitest`。包之间通过 `exports` 直接指向 `src/*.ts`，跨包 import 不需要先 build。

**Spec:** `docs/superpowers/specs/2026-08-26-agent-sdk-design.md`（本计划实现其第 10 章的第 0–6 步）

## Global Constraints

以下是全仓库口径，每个任务都隐含包含：

- **每个任务结束时 `pnpm test:local` 必须全绿。** 这是 spec 第 10 章的硬要求。任务边界就是按"能独立成为一个提交且不破坏仓库"划的。
- **内核目录 `packages/doctype-server-common/src/agent/**` 里不得出现** `Request` / `Response` / `DurableObject*` / `@cloudflare/*` / `@azure/*`（spec 4.4 规则 1）。同包的 `doc-type-handler.ts` / `session-handler.ts` 不受此限。
- **文档类型对 `@unidocs/doctype-server-common` 只能是 `import type`**（spec 4.3.2、V5）。任何运行时 helper 必须住在 `@unidocs/svalue-codec`。
- **依赖声明必须与 import 一致。** `tests/unit/workspace/package-deps.test.mjs` 强制四条规则，其中两条会咬到本计划：src 里的 workspace import 必须在 `dependencies`（正则不区分 `import type`）；composite 包的 tsconfig `references` 必须恰好覆盖 `dependencies`。加依赖时两处都要改。
- **不要写 `as any`。** 窄化 `SValue` 用 `svalue-codec` 的 `require*` helper（Task 2 建立）。
- **会话历史序列化一律 SValue CBOR，不能用 JSON**（spec 6.1.1）。`SBlob` 的品牌是 Symbol，`JSON.stringify` 会丢。本区块还不落盘，但内核里的类型必须保持 SValue-可编码。
- **提交信息用中文**，格式 `<type>(<scope>): <说明>`，与仓库既有风格一致（见 `git log`）。

## 不在本区块

区块 B（裁剪、持久化、并发租约）、区块 C（事件流、客户端）、Azure 平台实现，各自独立成计划。本区块结束时：历史仍然只在内存里、`/run` 仍然是一次阻塞 JSON 请求、Azure 仍然 501。

---

## File Structure

**新建 —— 内核（`packages/doctype-server-common/src/agent/`）**

| 文件 | 职责 |
|---|---|
| `tool-result.ts` | 默认的 `SValue → AgentToolResult` 转换；`AgentToolResult → AgentMessage` 的规范化。全是纯函数 |
| `messages.ts` | `AgentMessage → LlmMessage` 的物化（读 blob 字节）+ `ByteLru` 字节缓存 |
| `session.ts` | `AgentSession` —— 工具调用循环 |
| `providers/anthropic.ts` | `LlmProvider` 的 Anthropic 实现，单向翻译 |
| `index.ts` | `./agent` 子路径的门面：再导出 protocol 的契约类型 + 上面这些实现 |

**新建 —— 平台（`packages/cloudflare-sdk/src/`）**

| 文件 | 职责 |
|---|---|
| `agent-platform-do.ts` | `AgentPlatform` 的 DurableObject 实现：`query` / `apply` / `readBlob` / `writeBlob` |

**新建 —— 边界检查**

| 文件 | 职责 |
|---|---|
| `tests/unit/workspace/agent-kernel-purity.test.mjs` | 内核目录不碰平台类型（V3） |

**改写**

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/types.ts` | 新增上下边界契约；旧的 `DocumentAgent*` 先改名 `Legacy*`，最后删 |
| `packages/svalue-codec/src/svalue.ts` | 新增 `requireRecord` / `requireNumber` / `requireString` / `requireSBlob` |
| `packages/doctype-psd/src/tools.ts` | 工具表 → `AgentTool[]`，去前缀，提示词对齐 |
| `packages/doctype-psd/src/queries.ts` | `getPreview` 从 base64 改 SBlob |
| `packages/doctype-psd/src/agent.ts` | 80 行 → 一个常量 |
| `packages/doctype-{markdown,docx}/src/*` | 同上 |
| `packages/cloudflare-sdk/src/operator-do-agent.ts` | 326 行 → 薄外壳 |
| `packages/gateway-common/src/capability-policy.ts` | `run` 的授权窗口（Task 0） |

---

## Task 0: run 的授权窗口

与 agent 内核完全无关，只动 `gateway-common` 和配置。**排在最前面**：不先改它，后面每一次端到端验证都会在 90 秒处莫名断流（spec 5.6、第 10 章第 0 步）。

**Files:**
- Modify: `packages/service-auth/src/claims.ts:8`
- Modify: `packages/gateway-common/src/capability-policy.ts:13-18,64-71,111-122`
- Modify: `packages/gateway-common/src/capability-authority.ts:53`
- Modify: `packages/cloudflare-gateway/wrangler.toml:12`
- Modify: `packages/cloudflare-psd/wrangler.toml:16`
- Modify: `packages/cloudflare-markdown/wrangler.toml:16`
- Modify: `packages/cloudflare-docx/wrangler.toml:16`
- Modify: `stacks/unidocs-azure/deploy/gateway.bicep:178`
- Modify: `stacks/unidocs-azure/deploy/service.bicep:153`
- Modify: `stacks/unidocs-cloudflare/local/doc-types.mjs:221`
- Modify: `stacks/unidocs-azure/local/runtime.mjs:775,823`
- Test: `packages/gateway-common/tests/capability-policy.test.ts`
- Test: `tests/unit/scripts/dev-vars.test.mjs:123`
- Test: `tests/unit/scripts/doc-types.test.mjs:229`

**Interfaces:**
- Consumes: 无
- Produces: `docCapabilityPolicy("run")` 返回 `{ deadlineSeconds: 1800, lifetimeSeconds: 1800 }`；其余操作不变。

- [ ] **Step 1: 改测试表，让它先失败**

`packages/gateway-common/tests/capability-policy.test.ts` —— 表格加一列 lifetime，`run` 那行改成 1800：

```ts
  test.each([
    ["create", "tenants:t:sessions:create", ["tenants:t:cas:write"], 90, 120],
    ["status", "tenants:t:sessions:create", [], 15, 120],
    ["query", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["export", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["history", "tenants:t:sessions:s:read", [], 30, 120],
    ["ir", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 30, 120],
    ["snapshot", "tenants:t:sessions:s:read", ["tenants:t:cas:write"], 60, 120],
    ["apply", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90, 120],
    ["rollback", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90, 120],
    // 只有 run 拿长窗口：agent 循环要跑到 30 分钟（spec 5.6）
    ["run", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 1800, 1800],
    ["initFromHash", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 60, 120],
    ["reset", "tenants:t:sessions:s:write", [], 30, 120],
  ] satisfies Array<[DocOperation, string, string[], number, number]>) (
    "%s uses minimum downstream authority",
    (operation, docPermission, delegatedCasPermissions, deadlineSeconds, lifetimeSeconds) => {
      expect(docCapabilityPolicy(operation, "t", "s")).toEqual({
        docPermission,
        delegatedCasPermissions,
        deadlineSeconds,
        lifetimeSeconds,
      });
    },
  );
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/gateway-common test`
Expected: FAIL —— `run` 那行拿到 `{deadlineSeconds: 90, lifetimeSeconds: 120}`。

- [ ] **Step 3: 抬高全局天花板**

`packages/service-auth/src/claims.ts:8`：

```ts
/**
 * 一张 capability 最长能签多久。签发（issuer.ts）和校验（verifier.ts）两端
 * 都强制，也是 CAPABILITY_MAX_LIFETIME_SECONDS 的解析上界（runtime.ts:40-45）。
 *
 * 2026-08 从 300 抬到 1800：agent 的 /run 是一次可能跑几十分钟的循环，
 * operator 全程带着启动时那张 delegated-cas 凭据调编辑器，凭据一过期
 * 后续写入就 401（spec 5.6）。这是权宜之计 —— 代价是校验侧不再为
 * apply 这类短操作兜底，正解是循环中途续签（spec 5.6.5、第 12 章）。
 */
export const MaximumCapabilityLifetimeSeconds = 1800;
```

- [ ] **Step 4: 放宽策略类型并把 run 拆出来**

`packages/gateway-common/src/capability-policy.ts` —— 三处改动。类型：

```ts
export interface DocCapabilityPolicy {
  readonly docPermission: CapabilityPermission;
  readonly delegatedCasPermissions: readonly CapabilityPermission[];
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 1800;
  readonly lifetimeSeconds: 120 | 1800;
}
```

`run` 从 `apply` / `rollback` 的 case 里拆出来：

```ts
    case "apply":
    case "rollback":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        90,
      );
    // `run` 的权限集与 apply 完全相同，长的只有时间。agent 循环全程带着
    // 这里签出的 delegated-cas 凭据调编辑器，凭据过期后续写入就 401，
    // 所以窗口必须覆盖整次 run（spec 5.6.3）。
    case "run":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        1800,
        1800,
      );
```

helper 多收一个可选 lifetime：

```ts
function policy(
  docPermission: CapabilityPermission,
  delegatedCasPermissions: readonly CapabilityPermission[],
  deadlineSeconds: 15 | 30 | 60 | 90 | 1800,
  lifetimeSeconds: 120 | 1800 = 120,
): DocCapabilityPolicy {
  return Object.freeze({
    docPermission,
    delegatedCasPermissions: Object.freeze([...delegatedCasPermissions]),
    deadlineSeconds,
    lifetimeSeconds,
  });
}
```

`packages/gateway-common/src/capability-authority.ts:53`：

```ts
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 1800;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/gateway-common test && pnpm --filter @unidocs/service-auth test`
Expected: PASS。

- [ ] **Step 6: 改 9 处部署配置**

四个 `wrangler.toml` 里 `CAPABILITY_MAX_LIFETIME_SECONDS = "300"` → `"1800"`；两个 bicep 里 `value: '300'`（紧跟在 `name: 'CAPABILITY_MAX_LIFETIME_SECONDS'` 之后那一行）→ `'1800'`；三处 mjs 里 `CAPABILITY_MAX_LIFETIME_SECONDS: "300"` → `"1800"`。

**`CAPABILITY_TTL_SECONDS` 一律保持 `"120"` 不动** —— 它是"没写明 lifetime 时用多久"的兜底，跟着抬会让所有未指定的调用都拿到长凭据（spec 5.6.3）。

校验没漏：

```bash
git grep -c 'CAPABILITY_MAX_LIFETIME_SECONDS.*1800' -- '*.toml' '*.bicep' '*.mjs' | grep -v tests
```

- [ ] **Step 7: 修跟着红的两个脚本测试**

`tests/unit/scripts/dev-vars.test.mjs:123` 和 `tests/unit/scripts/doc-types.test.mjs:229` 断言的是生成出的完整 env map，把其中的 `CAPABILITY_MAX_LIFETIME_SECONDS: "300"` 改成 `"1800"`。

`packages/service-auth/tests/runtime.test.ts` 和 `packages/doctype-server-common/tests/doc-auth-config.test.ts` 里的 `"300"` 是**输入夹具不是断言**，抬高常量之后仍然通过，**不要改**。

- [ ] **Step 8: 全仓库测试**

Run: `pnpm test:local`
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(auth): run 的授权窗口放宽到 1800 秒

agent 的 /run 是一次可能跑几十分钟的循环,而 operator 全程带着启动时
那张 delegated-cas 凭据调编辑器。两个时钟卡着它:网关用
AbortSignal.timeout(deadlineSeconds) 掐转发(run 原本 90 秒),凭据本身
lifetimeSeconds 原本 120 秒 —— 后者更要命,它让服务端跑不完而不只是
断了看的人。

签发侧只放宽 run,apply/rollback 一点没动;权限集合也没变宽,长的只有
时间。为了签得出 1800 秒,全局 MaximumCapabilityLifetimeSeconds 从 300
抬到 1800,以及 9 处 CAPABILITY_MAX_LIFETIME_SECONDS 配置。

代价:校验侧从此接受任何 <=1800 秒的凭据,不再为 apply 这类短操作兜底。
这层挡的是失误不是攻击者,但确实是削弱,明确记为权宜之计 —— 正解是
循环中途续签,它同时消掉时长上限和全局放宽两件事(spec 5.6.5)。

CAPABILITY_TTL_SECONDS 保持 120:它是未指定 lifetime 时的兜底,跟着抬
会让所有没写明的调用都拿到长凭据。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: protocol —— 新契约进场，旧契约改名让位

新旧并存一段时间，仓库才能每一步都绿。旧的三个类型先改名 `Legacy*`（机械操作），好名字直接给新契约，Task 9 再把 `Legacy*` 删掉。

**Files:**
- Modify: `packages/protocol/src/types.ts:105-129`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/cloudflare-sdk/src/operator-do-agent.ts:3`（跟着改名）
- Modify: `packages/cloudflare-sdk/src/operator-do.ts`、`src/index.ts`（跟着改名）
- Modify: `packages/doctype-{psd,markdown,docx}/src/agent.ts`（跟着改名）
- Modify: `packages/doctype-server-common/src/operator.ts`（跟着改名）
- Test: `packages/protocol/tests/agent-contracts.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `AgentTool<TQuery,TOp>`、`DocumentAgent<TQuery,TOp>`、`AgentPlatform<TQuery,TOp>`、`AgentMessage`、`AgentToolCall`、`LlmContentPart`、`LlmMessage`、`LlmProvider`、`AgentCompletion`。旧名变成 `LegacyDocumentAgent` / `LegacyDocumentAgentContext` / `LegacyDocumentAgentFactory`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/protocol/tests/agent-contracts.test.ts`。契约全是类型，所以测的是"用这些类型能不能构造出预期的值"——类型错了 `tsc` 会挡住，运行时断言守住结构：

```ts
import { describe, expect, it } from "vitest";
import type {
  AgentMessage, AgentTool, DocumentAgent, LlmMessage,
} from "../src/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

describe("agent 上边界契约", () => {
  it("query 工具只声明纯函数，不接受任何句柄", () => {
    const tool: AgentTool<Q, O> = {
      kind: "query",
      name: "getLayers",
      description: "READ.",
      inputSchema: { type: "object", properties: {} },
      toQuery: () => ({ kind: "getLayers" }) as never,
    };
    expect(tool.kind).toBe("query");
    // 同一组参数调两次结果深相等 —— 纯函数（spec V7）
    expect(tool.toQuery({})).toEqual(tool.toQuery({}));
  });

  it("op 工具产出一批 op，且没有 toResult", () => {
    const tool: AgentTool<Q, O> = {
      kind: "op",
      name: "transform",
      description: "WRITE.",
      inputSchema: { type: "object", properties: {} },
      toOps: args => [{ kind: "transform", payload: args }] as never,
    };
    expect(tool.kind).toBe("op");
    expect("toResult" in tool).toBe(false);
  });

  it("DocumentAgent 就是一张表加一段提示词", () => {
    const agent: DocumentAgent<Q, O> = { tools: [], instructions: "hi" };
    expect(agent.tools).toEqual([]);
    expect(Object.keys(agent).sort()).toEqual(["instructions", "tools"]);
  });

  it("三个 role 的持久消息都用同一种 content", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }], toolCalls: [{ id: "t1", name: "getLayers", arguments: {} }] },
      { role: "tool", callId: "t1", content: [], structuredContent: { ok: true } },
    ];
    for (const m of msgs) expect(Array.isArray(m.content)).toBe(true);
  });

  it("模型态的附件是字节，持久态的是 SBlob", () => {
    const llm: LlmMessage = {
      role: "user",
      content: [{ type: "image", data: new Uint8Array([1, 2]), mediaType: "image/png" }],
    };
    const part = llm.content[0];
    expect(part.type === "image" && part.data).toBeInstanceOf(Uint8Array);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/protocol test`
Expected: FAIL —— `AgentTool` / `DocumentAgent` / `AgentMessage` / `LlmMessage` 都还不存在。

- [ ] **Step 3: 旧名改成 Legacy\***

`packages/protocol/src/types.ts:105-129`，三处改名，内容一字不动：

```ts
/** @deprecated 旧的上下边界形状，Task 9 删。新代码用 AgentPlatform / DocumentAgent。 */
export interface LegacyDocumentAgentContext<TQuery, TOp> { /* 原样 */ }
/** @deprecated 同上 */
export interface LegacyDocumentAgent { /* 原样 */ }
/** @deprecated 同上 */
export type LegacyDocumentAgentFactory<TQuery, TOp> = (
  context: LegacyDocumentAgentContext<TQuery, TOp>,
) => LegacyDocumentAgent;
```

然后机械跟进所有引用点（`git grep -l 'DocumentAgentContext\|DocumentAgentFactory\|DocumentAgent\b'` 里除 protocol 之外的每一个文件）。这一步纯改名，不改任何行为。

- [ ] **Step 4: 加新契约**

`packages/protocol/src/types.ts` 尾部追加。**上边界：**

```ts
export type AgentTool<TQuery, TOp> =
  | {
    readonly kind: "query";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    /** 纯函数：模型给的参数 → 一个 query。不得有 IO、不得读全局状态。 */
    readonly toQuery: (args: Readonly<Record<string, JsonValue>>) => SValueType<TQuery>;
    /**
     * 纯函数：query 结果 → 交给模型的东西。
     * 不给则用 defaultQueryToolResult（签名与本字段完全一致）。
     * 要返回图片/文件的工具**必须**给，且必须产出 image/file content part。
     */
    readonly toResult?: (data: SValue, version: number) => AgentToolResult;
  }
  | {
    readonly kind: "op";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    /** 纯函数：模型给的参数 → 一批 op。 */
    readonly toOps: (args: Readonly<Record<string, JsonValue>>) => readonly SValueType<TOp>[];
  };

export interface DocumentAgent<TQuery, TOp> {
  readonly tools: readonly AgentTool<TQuery, TOp>[];
  readonly instructions: string;
}
```

**下边界：**

```ts
/**
 * 平台提供的"怎么做到"。**文档类型看不到它**，只有内核调。
 * apply 的 baseVersion 由实现自己读当前 head —— agent 不管版本（spec 5.2）。
 */
export interface AgentPlatform<TQuery, TOp> {
  readonly query: (query: SValueType<TQuery>) => Promise<{
    readonly data: SValue;
    readonly version: number;
  }>;
  readonly apply: (
    operations: readonly SValueType<TOp>[],
    description: string,
  ) => Promise<{ readonly version: number }>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobData>;
  readonly writeBlob: (data: SBlobData) => Promise<SBlob>;
}
```

**持久态消息：**

```ts
export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

/** 落盘、裁剪、算引用都用它。附件是 SBlob 引用，不是字节。 */
export type AgentMessage =
  | { readonly role: "user"; readonly content: readonly AgentContentPart[] }
  | {
    readonly role: "assistant";
    readonly content: readonly AgentContentPart[];
    readonly toolCalls?: readonly AgentToolCall[];
  }
  | {
    readonly role: "tool";
    readonly callId: string;
    readonly content: readonly AgentContentPart[];
    readonly structuredContent?: JsonValue;
  };
```

**模型态消息：**

```ts
/** 附件已物化成字节。只在"即将发给 provider"这一刻存在，不落盘。 */
export type LlmContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: Uint8Array; readonly mediaType: string; readonly altText?: string }
  | { readonly type: "file"; readonly data: Uint8Array; readonly mediaType: string; readonly filename?: string };

export type LlmMessage =
  | { readonly role: "user"; readonly content: readonly LlmContentPart[] }
  | { readonly role: "assistant"; readonly content: readonly LlmContentPart[]; readonly toolCalls?: readonly AgentToolCall[] }
  | { readonly role: "tool"; readonly callId: string; readonly content: readonly LlmContentPart[]; readonly structuredContent?: JsonValue };

export interface AgentCompletion {
  readonly content: readonly LlmContentPart[];
  readonly toolCalls?: readonly AgentToolCall[];
}

export interface LlmProvider {
  complete(request: {
    readonly system: string;
    readonly messages: readonly LlmMessage[];
    readonly tools: readonly AgentToolDefinition[];
  }): Promise<AgentCompletion>;
}
```

`packages/protocol/src/index.ts` 把新类型全部导出。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/protocol test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 全仓库测试 + 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(agent): protocol 里立起上下两层边界的契约

上边界 DocumentAgent = AgentTool[] + instructions,全是数据和纯函数,
文档类型不再接受任何句柄。下边界 AgentPlatform 收拢 query/apply/
readBlob/writeBlob,只有内核调。另加中立消息格式:持久态 AgentMessage
(附件是 SBlob)与模型态 LlmMessage(附件是字节)分成两个类型,不让一个
类型同时假装表示两种状态。

旧的 DocumentAgent / DocumentAgentContext / DocumentAgentFactory 先
改名 Legacy*,好名字让给新契约;等三个文档类型和 cloudflare-sdk 都迁
完再删(本区块最后一个任务)。这一步纯粹是加类型和改名,零行为变化。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: svalue-codec —— 共享的 SValue 窄化 helper

**Files:**
- Modify: `packages/svalue-codec/src/svalue.ts`
- Test: `packages/svalue-codec/tests/require.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `requireRecord(v: SValue, what: string): Readonly<Record<string, SValue>>`、`requireNumber(v: SValue | undefined, what: string): number`、`requireString(v: SValue | undefined, what: string): string`、`requireSBlob(v: SValue | undefined, what: string): SBlob`

放这里不放内核，因为它们是**运行时函数**且由**文档类型**调用——放进 `doctype-server-common/agent` 会让三个文档类型对内核产生运行时依赖，"仅类型依赖"的前提当场作废（spec 5.1.2）。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { createSBlob, requireNumber, requireRecord, requireSBlob, requireString } from "../src/index.js";

describe("SValue 窄化 helper", () => {
  it("requireRecord 接受普通对象", () => {
    expect(requireRecord({ a: 1 }, "x")).toEqual({ a: 1 });
  });

  it("requireRecord 拒绝数组、null 和 SBlob", () => {
    expect(() => requireRecord([1] as never, "x")).toThrow("x must be an object");
    expect(() => requireRecord(null as never, "x")).toThrow("x must be an object");
    expect(() => requireRecord(createSBlob("a".repeat(64)) as never, "x")).toThrow("x must be an object");
  });

  it("requireNumber 拒绝 NaN 和 Infinity", () => {
    expect(requireNumber(1.5, "n")).toBe(1.5);
    expect(() => requireNumber(Number.NaN, "n")).toThrow("n must be a finite number");
    expect(() => requireNumber(undefined, "n")).toThrow("n must be a finite number");
  });

  it("requireString / requireSBlob", () => {
    expect(requireString("s", "s")).toBe("s");
    expect(() => requireString(1, "s")).toThrow("s must be a string");
    const blob = createSBlob("b".repeat(64));
    expect(requireSBlob(blob, "b")).toBe(blob);
    expect(() => requireSBlob({}, "b")).toThrow("b must be an SBlob");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/svalue-codec test`
Expected: FAIL —— 四个函数都不存在。

- [ ] **Step 3: 实现**

追加到 `packages/svalue-codec/src/svalue.ts`（`isSBlob` 已经住在这个文件里）：

```ts
/**
 * 把跨过一次序列化的 SValue 窄化成具体形状。
 *
 * 这几个是从 doctype-docx/src/agent.ts 提上来的 —— 三个文档类型的
 * toResult 都要做同一件事，没有理由各写一份。窄化失败时抛错，被内核
 * 接住变成一条给模型的错误消息（spec 5.1.5）。
 */
export function requireRecord(v: SValue, what: string): Readonly<Record<string, SValue>> {
  if (typeof v !== "object" || v === null || Array.isArray(v) || isSBlob(v)) {
    throw new TypeError(`${what} must be an object`);
  }
  return v as Readonly<Record<string, SValue>>;
}

export function requireNumber(v: SValue | undefined, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`${what} must be a finite number`);
  }
  return v;
}

export function requireString(v: SValue | undefined, what: string): string {
  if (typeof v !== "string") throw new TypeError(`${what} must be a string`);
  return v;
}

export function requireSBlob(v: SValue | undefined, what: string): SBlob {
  if (!isSBlob(v)) throw new TypeError(`${what} must be an SBlob`);
  return v;
}
```

从 `packages/svalue-codec/src/index.ts` 导出这四个。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/svalue-codec test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(svalue): 提取共享的 SValue 窄化 helper

requireRecord / requireNumber / requireString / requireSBlob 从
doctype-docx/src/agent.ts 提到 svalue-codec —— 三个文档类型的 toResult
都要做同一件窄化,没理由各写一份。

放 svalue-codec 不放 agent 内核是有讲究的:它们是运行时函数,放进
doctype-server-common/agent 会让三个文档类型对内核产生运行时依赖,
\"仅类型依赖\"这个前提当场作废(spec 5.1.2)。而窄化 SValue 本来就与
agent 无关,isSBlob 早就住在这儿。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 内核 —— 默认转换与消息规范化

**Files:**
- Create: `packages/doctype-server-common/src/agent/tool-result.ts`
- Create: `packages/doctype-server-common/src/agent/index.ts`
- Modify: `packages/doctype-server-common/package.json`（加 `./agent` 导出）
- Test: `packages/doctype-server-common/tests/agent/tool-result.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentToolResult`、`AgentMessage`、`AgentContentPart`
- Produces:
  - `defaultQueryToolResult(data: SValue, version: number): AgentToolResult`
  - `defaultOpToolResult(version: number): AgentToolResult`
  - `toolResultToMessage(callId: string, result: AgentToolResult): AgentMessage`

- [ ] **Step 1: 写失败的测试**

`packages/doctype-server-common/tests/agent/tool-result.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import {
  defaultOpToolResult, defaultQueryToolResult, toolResultToMessage,
} from "../../src/agent/index.js";

const HASH = "a".repeat(64);

describe("默认的 SValue → AgentToolResult 转换", () => {
  it("query 默认包装成 { data, version }，与改造前 toolCall 的产物一致", () => {
    expect(defaultQueryToolResult({ layers: [] }, 7)).toEqual({
      structuredContent: { data: { layers: [] }, version: 7 },
    });
  });

  it("op 固定返回 { success: true, version }", () => {
    expect(defaultOpToolResult(8)).toEqual({
      structuredContent: { success: true, version: 8 },
    });
  });

  it("默认转换不产生 content —— 附件必须由 toResult 显式给出", () => {
    expect(defaultQueryToolResult({ a: 1 }, 1).content).toBeUndefined();
  });
});

describe("AgentToolResult → AgentMessage 的规范化", () => {
  it("content 与 structuredContent 原样搬，callId 由内核补", () => {
    const blob = createSBlob(HASH);
    const msg = toolResultToMessage("call-1", {
      structuredContent: { width: 10 },
      content: [{ type: "image", blob, mediaType: "image/png", altText: "preview" }],
    });
    expect(msg).toEqual({
      role: "tool",
      callId: "call-1",
      content: [{ type: "image", blob, mediaType: "image/png", altText: "preview" }],
      structuredContent: { width: 10 },
    });
  });

  it("没有 content 时归一成空数组，不是 undefined", () => {
    const msg = toolResultToMessage("call-2", { structuredContent: { ok: true } });
    expect(msg.content).toEqual([]);
  });

  it("没有 structuredContent 时该字段整个不出现", () => {
    const msg = toolResultToMessage("call-3", { content: [{ type: "text", text: "hi" }] });
    expect("structuredContent" in msg).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`packages/doctype-server-common/src/agent/tool-result.ts`：

```ts
import { toJsonValue } from "@unidocs/svalue-codec";
import type { AgentMessage, AgentToolResult, SValue } from "@unidocs/protocol";

/**
 * `kind: "query"` 未提供 toResult 时的默认转换。
 * 签名与 AgentTool.toResult 完全一致 —— 不写 toResult 就等于用了这个。
 *
 * 只有内核调。一个工具但凡写了 toResult，就说明默认满足不了它，不存在
 * "先调默认再往上加"的用法，所以它留在内核，文档类型一次都不 import
 * （spec 5.1.2）。
 */
export function defaultQueryToolResult(data: SValue, version: number): AgentToolResult {
  return { structuredContent: toJsonValue({ data, version } as SValue) };
}

/** `kind: "op"` 的固定转换。op 工具没有 toResult，这条不可覆盖。 */
export function defaultOpToolResult(version: number): AgentToolResult {
  return { structuredContent: { success: true, version } };
}

/**
 * AgentToolResult → AgentMessage 的无损结构转换。
 *
 * AgentToolResult 是**中转类型**：只活在"工具返回"到这里为止，进不了
 * 历史、数据库和事件流，落盘的一律是 AgentMessage（spec 5.4.1）。
 */
export function toolResultToMessage(callId: string, result: AgentToolResult): AgentMessage {
  return {
    role: "tool",
    callId,
    content: result.content ?? [],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  };
}
```

`packages/doctype-server-common/src/agent/index.ts`：

```ts
/**
 * `@unidocs/doctype-server-common/agent` —— 文档类型和平台 sdk 共同对着
 * 写代码的那一层。契约类型定义在 protocol，这里再导出一次，于是作者只
 * 需要记住一个 import 来源（spec 4.3.1）。
 */
export type {
  AgentCompletion, AgentContentPart, AgentMessage, AgentPlatform,
  AgentTool, AgentToolCall, AgentToolDefinition, AgentToolResult,
  DocumentAgent, LlmContentPart, LlmMessage, LlmProvider,
} from "@unidocs/protocol";

export {
  defaultOpToolResult, defaultQueryToolResult, toolResultToMessage,
} from "./tool-result.js";
```

`packages/doctype-server-common/package.json` 的 `exports` 加一条（与 `./port-contract` 同形）：

```json
    "./agent": {
      "types": "./src/agent/index.ts",
      "import": "./src/agent/index.ts"
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(agent): 内核的默认工具结果转换与消息规范化

defaultQueryToolResult / defaultOpToolResult 把原本散在三个文档类型
toolCall 里的那两段包装收成具名函数,签名与 AgentTool.toResult 一致,
所以\"不写 toResult 就等于用了这个\"从类型上就看得出来。

toolResultToMessage 是 AgentToolResult -> AgentMessage 的无损转换。
这也把两者的分工写死了:AgentToolResult 是中转类型,只活在一次工具调用
之内;落盘、裁剪、算引用的一律是 AgentMessage。

顺带开出 ./agent 子路径,按包已有的 ./port-contract 约定。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 内核 —— 附件物化与字节缓存

**Files:**
- Create: `packages/doctype-server-common/src/agent/messages.ts`
- Modify: `packages/doctype-server-common/src/agent/index.ts`
- Test: `packages/doctype-server-common/tests/agent/messages.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentMessage` / `LlmMessage` / `AgentPlatform`；Task 3 的 index 门面
- Produces:
  - `class ByteLru { constructor(maxBytes: number); get(hash: string): Uint8Array | undefined; set(hash: string, bytes: Uint8Array): void }`
  - `materializeMessages(messages: readonly AgentMessage[], readBlob: (blob: SBlob) => Promise<SBlobData>, cache: ByteLru): Promise<readonly LlmMessage[]>`
  - `class BlobUnavailableError extends Error`（平台用它表示"blob 确实不存在"）

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { AgentMessage } from "@unidocs/protocol";
import { BlobUnavailableError, ByteLru, materializeMessages } from "../../src/agent/index.js";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const png = (n: number) => new Uint8Array([n, n, n]);

function imageMsg(hash: string, altText: string): AgentMessage {
  return {
    role: "tool",
    callId: "c1",
    content: [{ type: "image", blob: createSBlob(hash), mediaType: "image/png", altText }],
  };
}

describe("附件物化", () => {
  it("把 SBlob 换成字节，三个 role 一视同仁", async () => {
    const readBlob = vi.fn(async () => ({ data: png(1), contentType: "image/png" }));
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "image", blob: createSBlob(H1), mediaType: "image/png" }] },
      { role: "assistant", content: [{ type: "image", blob: createSBlob(H2), mediaType: "image/png" }] },
      imageMsg(H1, "preview"),
    ];
    const out = await materializeMessages(msgs, readBlob, new ByteLru(1024));
    for (const m of out) {
      const p = m.content[0];
      expect(p.type === "image" && p.data).toEqual(png(1));
    }
  });

  it("同一个 hash 只读一次 —— 缓存按 hash 去重（spec V24）", async () => {
    const readBlob = vi.fn(async () => ({ data: png(1), contentType: "image/png" }));
    const cache = new ByteLru(1024);
    const msgs = [imageMsg(H1, "p"), imageMsg(H1, "p"), imageMsg(H2, "q")];
    await materializeMessages(msgs, readBlob, cache);
    await materializeMessages(msgs, readBlob, cache);
    expect(readBlob).toHaveBeenCalledTimes(2); // 两个不同 hash，不是六次
  });

  it("blob 确实不存在时降级成 altText 文字，run 继续（spec 6.6.0）", async () => {
    const readBlob = vi.fn(async () => { throw new BlobUnavailableError("gone"); });
    const out = await materializeMessages([imageMsg(H1, "preview 8x8 v3")], readBlob, new ByteLru(1024));
    expect(out[0].content[0]).toEqual({ type: "text", text: "[image: preview 8x8 v3]" });
  });

  it("授权失败必须抛出，不能伪装成图没了（spec 6.6.0）", async () => {
    const readBlob = vi.fn(async () => { throw new Error("CAS 401 unauthorized"); });
    await expect(materializeMessages([imageMsg(H1, "p")], readBlob, new ByteLru(1024)))
      .rejects.toThrow("401");
  });

  it("没有 altText 时降级用 mediaType", async () => {
    const readBlob = vi.fn(async () => { throw new BlobUnavailableError("gone"); });
    const msg: AgentMessage = {
      role: "user",
      content: [{ type: "image", blob: createSBlob(H1), mediaType: "image/png" }],
    };
    const out = await materializeMessages([msg], readBlob, new ByteLru(1024));
    expect(out[0].content[0]).toEqual({ type: "text", text: "[image: image/png]" });
  });
});

describe("ByteLru", () => {
  it("超过字节上限后淘汰最久未用的", () => {
    const lru = new ByteLru(6);
    lru.set(H1, png(1));           // 3 字节
    lru.set(H2, png(2));           // 6 字节，正好到顶
    expect(lru.get(H1)).toEqual(png(1)); // 命中，H1 变成最近使用
    lru.set("c".repeat(64), png(3));     // 超了，淘汰 H2
    expect(lru.get(H2)).toBeUndefined();
    expect(lru.get(H1)).toEqual(png(1));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/doctype-server-common/src/agent/messages.ts`：

```ts
import { isSBlob } from "@unidocs/svalue-codec";
import type {
  AgentContentPart, AgentMessage, LlmContentPart, LlmMessage, SBlob, SBlobData,
} from "@unidocs/protocol";

/**
 * 平台用它表示"这个 blob 确实不存在"——CAS 404，或者引用已被回收。
 *
 * 只有这一种失败会被降级成文字。授权失败（401/403）和传输失败一律往上抛，
 * 因为把它们伪装成"图没了"正是提交 63f997b 修掉的坑：一次跑长了的 run 会
 * 从某一刻起每张图静默变成一行文字，模型基于看不见的画面瞎猜，日志里一个
 * 错误都没有（spec 6.6.0）。
 */
export class BlobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobUnavailableError";
  }
}

/** 按总字节数封顶的 hash → 字节缓存，淘汰最久未用的。 */
export class ByteLru {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Uint8Array>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get(hash: string): Uint8Array | undefined {
    const hit = this.#entries.get(hash);
    if (hit === undefined) return undefined;
    // Map 保持插入序，删了再插就是"移到最近使用"。
    this.#entries.delete(hash);
    this.#entries.set(hash, hit);
    return hit;
  }

  set(hash: string, bytes: Uint8Array): void {
    const existing = this.#entries.get(hash);
    if (existing !== undefined) {
      this.#entries.delete(hash);
      this.#bytes -= existing.byteLength;
    }
    this.#entries.set(hash, bytes);
    this.#bytes += bytes.byteLength;
    for (const [k, v] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      if (k === hash) continue;          // 刚放进来的不淘汰
      this.#entries.delete(k);
      this.#bytes -= v.byteLength;
    }
  }
}

function degrade(part: Extract<AgentContentPart, { type: "image" | "file" }>): LlmContentPart {
  // 内核只知道"这里原来有个附件，文档类型说它是这样"。那句话里写什么是
  // 文档类型的事（spec 6.2.3）。
  const label = part.type === "image"
    ? part.altText ?? part.mediaType
    : part.filename ?? part.mediaType;
  return { type: "text", text: `[${part.type}: ${label}]` };
}

async function materializePart(
  part: AgentContentPart,
  readBlob: (blob: SBlob) => Promise<SBlobData>,
  cache: ByteLru,
): Promise<LlmContentPart> {
  if (part.type === "text") return part;
  const hash = blobHash(part.blob);
  const cached = cache.get(hash);
  if (cached !== undefined) return withData(part, cached);
  let bytes: Uint8Array;
  try {
    bytes = (await readBlob(part.blob)).data;
  } catch (err) {
    // 只有"确实没了"才降级；其余（授权、传输）原样抛给上面结束这次 run。
    if (err instanceof BlobUnavailableError) return degrade(part);
    throw err;
  }
  cache.set(hash, bytes);
  return withData(part, bytes);
}

function withData(
  part: Extract<AgentContentPart, { type: "image" | "file" }>,
  data: Uint8Array,
): LlmContentPart {
  return part.type === "image"
    ? { type: "image", data, mediaType: part.mediaType, ...(part.altText === undefined ? {} : { altText: part.altText }) }
    : { type: "file", data, mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }) };
}

function blobHash(blob: SBlob): string {
  if (!isSBlob(blob)) throw new TypeError("content part blob is not an SBlob");
  return blob.hash;
}

/**
 * 把持久态历史变成模型输入。三个 role 一视同仁地扫 content —— 内核不区分
 * 图片来自 user、assistant 还是 tool（spec 5.4.2）。
 */
export async function materializeMessages(
  messages: readonly AgentMessage[],
  readBlob: (blob: SBlob) => Promise<SBlobData>,
  cache: ByteLru,
): Promise<readonly LlmMessage[]> {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const content = await Promise.all(m.content.map(p => materializePart(p, readBlob, cache)));
    if (m.role === "tool") {
      out.push({
        role: "tool",
        callId: m.callId,
        content,
        ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent }),
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content, ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls }) });
    } else {
      out.push({ role: "user", content });
    }
  }
  return out;
}
```

从 `src/agent/index.ts` 导出 `ByteLru`、`BlobUnavailableError`、`materializeMessages`。

（`SBlob` 的形状是 `{ readonly [sBlobSignature]: true; readonly hash: string }`，`protocol/src/types.ts:35-38`，所以 `blob.hash` 就是 hash。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(agent): 附件物化与按 hash 去重的字节缓存

每次调模型之前要把历史里的 SBlob 引用换成真字节。PSD 一次 run 跑 25 圈,
每圈重读就是几十次 readBlob 读同样两个 hash,所以按 hash 缓存、按总字节
封顶淘汰。放内核不放平台,因为\"同一个 blob 被反复要\"是循环的性质。

readBlob 失败按类型分流:只有 BlobUnavailableError(blob 确实不存在)才
就地降级成 altText 文字;授权失败和传输失败一律往上抛。提交 63f997b 刚
因为裸 catch 把 CAS 的 401 伪装成\"blob 不存在\"而被修掉,照抄进内核会更
隐蔽 —— 凭据过期之后每张图静默变文字,模型基于看不见的画面瞎猜(spec 6.6.0)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 内核 —— AgentSession 循环

**Files:**
- Create: `packages/doctype-server-common/src/agent/session.ts`
- Modify: `packages/doctype-server-common/src/agent/index.ts`
- Test: `packages/doctype-server-common/tests/agent/session.test.ts`

**Interfaces:**
- Consumes: Task 1 契约、Task 3 的 `defaultQueryToolResult`/`defaultOpToolResult`/`toolResultToMessage`、Task 4 的 `ByteLru`/`materializeMessages`
- Produces:
  - `class AgentSession<TQuery, TOp>`，构造参数 `{ agent, platform, provider, maxIterations? }`
  - `run(content: readonly AgentContentPart[]): Promise<AgentRunOutcome>`
  - `reset(): void`
  - `type AgentRunOutcome = { ok: true; content: readonly AgentContentPart[]; response: string; iterations: number } | { ok: false; error: string }`
  - `DEFAULT_MAX_ITERATIONS = 10`

本区块的 `run` 还**没有** lease 和 onEvent 参数——那是区块 B / C。签名到时候再扩。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import type {
  AgentCompletion, AgentPlatform, DocumentAgent, LlmMessage, SBlob, SBlobData, SValue,
} from "@unidocs/protocol";
import { AgentSession } from "../../src/agent/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

const agent: DocumentAgent<Q, O> = {
  instructions: "你是测试用的 operator。",
  tools: [
    {
      kind: "query", name: "getLayers", description: "READ.",
      inputSchema: { type: "object", properties: {} },
      toQuery: () => ({ kind: "getLayers" }) as never,
    },
    {
      kind: "op", name: "transform", description: "WRITE.",
      inputSchema: { type: "object", properties: {} },
      toOps: args => [{ kind: "transform", payload: args }] as never,
    },
  ],
};

function fakePlatform(over: Partial<AgentPlatform<Q, O>> = {}): AgentPlatform<Q, O> {
  return {
    query: vi.fn(async () => ({ data: { layers: [] } as SValue, version: 3 })),
    apply: vi.fn(async () => ({ version: 4 })),
    readBlob: vi.fn(async (): Promise<SBlobData> => ({ data: new Uint8Array(), contentType: "image/png" })),
    writeBlob: vi.fn(async (): Promise<SBlob> => { throw new Error("unused"); }),
    ...over,
  };
}

/** 依次返回预设的 completion，并记下每次收到的 messages。 */
function scriptedProvider(script: AgentCompletion[]) {
  const seen: LlmMessage[][] = [];
  let i = 0;
  return {
    seen,
    complete: vi.fn(async (req: { messages: readonly LlmMessage[] }) => {
      seen.push([...req.messages]);
      const next = script[i++];
      if (!next) throw new Error("provider script exhausted");
      return next;
    }),
  };
}

describe("AgentSession 循环", () => {
  it("模型不调工具就直接结束，iterations = 1", async () => {
    const provider = scriptedProvider([{ content: [{ type: "text", text: "好了" }] }]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    const out = await s.run([{ type: "text", text: "看一下" }]);
    expect(out).toEqual({ ok: true, content: [{ type: "text", text: "好了" }], response: "好了", iterations: 1 });
  });

  it("query 工具走 toQuery → platform.query → 默认转换", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] },
      { content: [{ type: "text", text: "看完了" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "列图层" }]);
    expect(platform.query).toHaveBeenCalledWith({ kind: "getLayers" });
    // 第二次调模型时，工具结果已经作为 role:"tool" 进了历史
    const second = provider.seen[1];
    expect(second.at(-1)).toEqual({
      role: "tool", callId: "c1", content: [],
      structuredContent: { data: { layers: [] }, version: 3 },
    });
  });

  it("op 工具走 toOps → platform.apply，描述带工具名", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L1" } }] },
      { content: [{ type: "text", text: "改完了" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "移动图层" }]);
    expect(platform.apply).toHaveBeenCalledWith(
      [{ kind: "transform", payload: { layerId: "L1" } }],
      "Agent: transform",
    );
    expect(provider.seen[1].at(-1)).toMatchObject({
      structuredContent: { success: true, version: 4 },
    });
  });

  it("apply 失败时错误原文回给模型，循环不中断（spec 5.2）", async () => {
    const platform = fakePlatform({
      apply: vi.fn(async () => { throw new Error("layer not found: L9"); }),
    });
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L9" } }] },
      { content: [{ type: "text", text: "换一个" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "移动" }]);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(provider.seen[1].at(-1))).toContain("layer not found: L9");
  });

  it("未知工具名返回错误文本给模型，循环不中断", async () => {
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "nope", arguments: {} }] },
      { content: [{ type: "text", text: "抱歉" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(provider.seen[1].at(-1))).toContain("nope");
  });

  it("达到 maxIterations 以失败结束", async () => {
    const call = { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] };
    const provider = scriptedProvider([call, call, call]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider, maxIterations: 2 });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out).toEqual({ ok: false, error: "Max iterations (2) reached" });
  });

  it("提示词作为 system 传给 provider，不混进 messages", async () => {
    const provider = scriptedProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    await s.run([{ type: "text", text: "x" }]);
    expect(provider.complete.mock.calls[0][0].system).toBe(agent.instructions);
    expect(provider.seen[0].every(m => m.role !== ("system" as never))).toBe(true);
  });

  it("内核不持有版本状态：不先 query 直接 apply 也放行（spec 5.2）", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(platform.query).not.toHaveBeenCalled();
  });

  it("reset 之后模型看不到上一轮", async () => {
    const provider = scriptedProvider([
      { content: [{ type: "text", text: "a" }] },
      { content: [{ type: "text", text: "b" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    await s.run([{ type: "text", text: "第一句" }]);
    s.reset();
    await s.run([{ type: "text", text: "第二句" }]);
    expect(provider.seen[1]).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: FAIL —— `AgentSession` 不存在。

- [ ] **Step 3: 实现**

`packages/doctype-server-common/src/agent/session.ts`：

```ts
import type {
  AgentContentPart, AgentMessage, AgentPlatform, AgentTool, AgentToolDefinition,
  AgentToolResult, DocumentAgent, JsonValue, LlmProvider, SValue,
} from "@unidocs/protocol";
import { ByteLru, materializeMessages } from "./messages.js";
import { defaultOpToolResult, defaultQueryToolResult, toolResultToMessage } from "./tool-result.js";

/** 文档类型没设 maxIterations 时的循环上限。PSD 传 25。 */
export const DEFAULT_MAX_ITERATIONS = 10;

/** 与 sblob-context.ts:69 的默认一致。 */
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;

export type AgentRunOutcome =
  | {
    readonly ok: true;
    readonly content: readonly AgentContentPart[];
    /** 兼容旧客户端：从 content 的 text parts 派生，不是权威字段。 */
    readonly response: string;
    readonly iterations: number;
  }
  | { readonly ok: false; readonly error: string };

export interface AgentSessionDeps<TQuery, TOp> {
  readonly agent: DocumentAgent<TQuery, TOp>;
  readonly platform: AgentPlatform<TQuery, TOp>;
  readonly provider: LlmProvider;
  readonly maxIterations?: number;
}

export class AgentSession<TQuery, TOp> {
  readonly #deps: AgentSessionDeps<TQuery, TOp>;
  readonly #tools: ReadonlyMap<string, AgentTool<TQuery, TOp>>;
  readonly #definitions: readonly AgentToolDefinition[];
  readonly #blobCache = new ByteLru(BLOB_CACHE_BYTES);
  #history: AgentMessage[] = [];

  constructor(deps: AgentSessionDeps<TQuery, TOp>) {
    this.#deps = deps;
    this.#tools = new Map(deps.agent.tools.map(t => [t.name, t]));
    this.#definitions = deps.agent.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async run(content: readonly AgentContentPart[]): Promise<AgentRunOutcome> {
    this.#history.push({ role: "user", content });
    const maxIterations = this.#deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iterations = 1; iterations <= maxIterations; iterations++) {
      const messages = await materializeMessages(
        this.#history,
        blob => this.#deps.platform.readBlob(blob),
        this.#blobCache,
      );
      const completion = await this.#deps.provider.complete({
        system: this.#deps.agent.instructions,
        messages,
        tools: this.#definitions,
      });

      // provider 返回的文字直接成为 assistant 的 text part。将来 provider
      // 返回二进制时，这里先走 platform.writeBlob 再进历史（spec 5.4.2）。
      const assistantContent: AgentContentPart[] = completion.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map(p => ({ type: "text", text: p.text }));
      this.#history.push({
        role: "assistant",
        content: assistantContent,
        ...(completion.toolCalls?.length ? { toolCalls: completion.toolCalls } : {}),
      });

      if (!completion.toolCalls?.length) {
        return {
          ok: true,
          content: assistantContent,
          response: assistantContent.map(p => p.text).join(""),
          iterations,
        };
      }

      for (const call of completion.toolCalls) {
        const result = await this.#dispatch(call.name, call.arguments);
        this.#history.push(toolResultToMessage(call.id, result));
      }
    }

    return { ok: false, error: `Max iterations (${maxIterations}) reached` };
  }

  reset(): void {
    this.#history = [];
  }

  /**
   * 内核对工具的全部认知：它叫什么、是读还是写、把参数交给它的纯函数会
   * 得到一个 query 或一批 op。不认识图层或段落，也不认识版本号（spec 5.1.6）。
   *
   * 任何一步抛错都变成一条给模型的 tool 消息，循环不中断 —— apply 自己
   * 就是校验器，错了让模型重新生成（spec 5.2）。
   */
  async #dispatch(name: string, args: JsonValue): Promise<AgentToolResult> {
    try {
      const tool = this.#tools.get(name);
      if (!tool) throw new Error(`Unknown agent tool: ${name}`);
      const parameters = requireJsonObject(args);
      if (tool.kind === "query") {
        const { data, version } = await this.#deps.platform.query(tool.toQuery(parameters));
        return (tool.toResult ?? defaultQueryToolResult)(data as SValue, version);
      }
      const { version } = await this.#deps.platform.apply(tool.toOps(parameters), `Agent: ${name}`);
      return defaultOpToolResult(version);
    } catch (err) {
      return { structuredContent: { error: String(err) } };
    }
  }
}

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}
```

从 `src/agent/index.ts` 导出 `AgentSession`、`AgentRunOutcome`、`DEFAULT_MAX_ITERATIONS`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: PASS，9 个用例全过。

- [ ] **Step 5: 加内核纯净性检查（V3）**

新建 `tests/unit/workspace/agent-kernel-purity.test.mjs`：

```js
/**
 * 内核不知道平台（spec 4.4 规则 1）。
 *
 * 按目录扫而不是按包扫:同包的 doc-type-handler.ts / session-handler.ts
 * 本来就要用 Request / Response —— 它们是 HTTP 外壳,不在 agent 内核里。
 * 这是不新建包所付的唯一代价:拿不到"整包 tsconfig 禁用平台类型"那道更硬
 * 的保险,只能靠目录级扫描。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const KERNEL = join(import.meta.dirname, "..", "..", "..",
  "packages", "doctype-server-common", "src", "agent");

const FORBIDDEN = [
  /\bDurableObject\w*/, /\bRequest\b/, /\bResponse\b/,
  /@cloudflare\//, /@azure\//, /\bWebSocket\b/, /\bfetch\s*\(/,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(KERNEL);

describe("agent 内核不认识任何平台", () => {
  test("内核目录里有文件（防止 walk 静默扫空）", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  test.each(files.map(f => [f.slice(f.indexOf("packages")), f]))(
    "%s 不出现平台标识符",
    (_rel, full) => {
      const src = readFileSync(full, "utf8");
      const hits = FORBIDDEN.filter(re => re.test(src)).map(String);
      expect(hits, `平台标识符不该出现在内核里：${hits.join(", ")}`).toEqual([]);
    },
  );
});
```

Run: `pnpm vitest run tests/unit/workspace/agent-kernel-purity.test.mjs`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(agent): 内核的工具调用循环

AgentSession 拿三样东西:上边界的 DocumentAgent(纯数据的工具表)、下边界
的 AgentPlatform 和 LlmProvider。它对工具的全部认知是\"叫什么、是读还是
写、把参数交给它的纯函数会得到 query 还是 op\",不认识图层或段落。

不持有版本状态,也不强制\"apply 之前必须先 query\":apply 是确定性算法,
它自己就是校验器。工具的任何一步抛错都变成一条给模型的 tool 消息,循环
不中断,让模型自己纠正(spec 5.2)。

提示词作为 system 传给 provider,不再像今天那样混成 messages[0] —— 循环
内部从此只有中立消息格式,不再是 OpenAI 那套形状。

配 tests/unit/workspace/agent-kernel-purity.test.mjs 按目录扫,断言内核
里不出现 Request / Response / DurableObject / @cloudflare / @azure。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 内核 —— Anthropic provider

**Files:**
- Create: `packages/doctype-server-common/src/agent/providers/anthropic.ts`
- Modify: `packages/doctype-server-common/src/agent/index.ts`
- Test: `packages/doctype-server-common/tests/agent/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LlmProvider` / `LlmMessage` / `AgentCompletion` / `AgentToolDefinition`
- Produces: `createAnthropicProvider(env: AnthropicEnv, fetchImpl?: typeof fetch): LlmProvider`、`toAnthropicMessages(messages: readonly LlmMessage[]): AnthropicMessage[]`（导出供测试）

从 `cloudflare-psd/src/anthropic.ts` 搬过来，但**翻译改为单向**：内核已经是中立格式，不再需要"翻成 OpenAI 再翻成 Anthropic"。`findImage` / `previewMeta` 整个删掉——图片现在是结构化的 image part，不需要递归搜索。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@unidocs/protocol";
import { createAnthropicProvider, toAnthropicMessages } from "../../src/agent/index.js";

describe("中立消息 → Anthropic", () => {
  it("图片直接读 image part，不做任何搜索", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "看这个" }] },
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "getPreview", arguments: {} }] },
      {
        role: "tool", callId: "c1",
        content: [
          { type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/png", altText: "preview 8x8 v3" },
          { type: "text", text: "[preview]" },
        ],
        structuredContent: { width: 8 },
      },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "看这个" }] });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "getPreview", input: {} }],
    });
    const toolResult = out[2].content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(toolResult.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    });
  });

  it("同一个 assistant 轮次的多个 tool 结果合并进一条 user 消息", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [], toolCalls: [
        { id: "c1", name: "a", arguments: {} }, { id: "c2", name: "b", arguments: {} },
      ] },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "1" }] },
      { role: "tool", callId: "c2", content: [{ type: "text", text: "2" }] },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].content).toHaveLength(2);
  });

  it("structuredContent 作为文字块跟在附件后面", () => {
    const out = toAnthropicMessages([
      { role: "tool", callId: "c1", content: [], structuredContent: { ok: true } },
    ]);
    expect(out[0].content[0].content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });
});

describe("Anthropic 响应 → AgentCompletion", () => {
  it("文字和 tool_use 各自归位", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "我来看看" },
        { type: "tool_use", id: "c1", name: "getLayers", input: { a: 1 } },
      ],
    }), { status: 200 }));
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    const completion = await provider.complete({
      system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [],
    });
    expect(completion.content).toEqual([{ type: "text", text: "我来看看" }]);
    expect(completion.toolCalls).toEqual([{ id: "c1", name: "getLayers", arguments: { a: 1 } }]);
  });

  it("system 走顶层字段", async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    });
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    await provider.complete({ system: "你是 operator", messages: [], tools: [] });
    expect(body.system).toBe("你是 operator");
  });

  it("没有 API key 时报出可操作的错误", async () => {
    const provider = createAnthropicProvider({});
    await expect(provider.complete({ system: "", messages: [], tools: [] }))
      .rejects.toThrow(/LLM_API_KEY/);
  });

  it("非 2xx 带上状态码和响应体", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    await expect(provider.complete({ system: "", messages: [], tools: [] }))
      .rejects.toThrow("Anthropic 429: nope");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: FAIL。

- [ ] **Step 3: 实现**

从 `packages/cloudflare-psd/src/anthropic.ts` 把 `toInputSchema`（`:33-37`）、`resolveEndpoint`（`:40-45`）、`AnthropicEnv`（`:19-30`）三段**原样**搬过来。**删掉** `findImage`、`previewMeta`、`toOpenAi` 以及所有 OpenAI 形状的接口。翻译改成单向：

```ts
import type {
  AgentCompletion, AgentToolCall, AgentToolDefinition, JsonValue,
  LlmContentPart, LlmMessage, LlmProvider,
} from "@unidocs/protocol";

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicImageBlock { type: "image"; source: { type: "base64"; media_type: string; data: string } }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
export interface AnthropicMessage { role: "user" | "assistant"; content: AnthropicBlock[] }

/** 分块，避免 String.fromCharCode(...) 在大图上爆栈。原实现同一写法。 */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 一个中立 content part → 一个 Anthropic 块。图片是结构化字段，直接读。 */
function toBlock(part: LlmContentPart): AnthropicTextBlock | AnthropicImageBlock {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    return { type: "image", source: { type: "base64", media_type: part.mediaType, data: toBase64(part.data) } };
  }
  // Anthropic 的 document 块另有形状，本区块不做 —— 先降级成一行文字，
  // 与裁剪/物化的降级用同一句式（spec 6.2.3）。
  return { type: "text", text: `[file: ${part.filename ?? part.mediaType}]` };
}

export function toAnthropicMessages(messages: readonly LlmMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map(toBlock) });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = m.content.map(toBlock);
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // role === "tool"
    const content: Array<AnthropicTextBlock | AnthropicImageBlock> = m.content.map(toBlock);
    if (m.structuredContent !== undefined) {
      content.push({ type: "text", text: JSON.stringify(m.structuredContent) });
    }
    const block: AnthropicToolResultBlock = { type: "tool_result", tool_use_id: m.callId, content };
    // Claude 要求 tool 结果以 user 角色出现；把同一个 assistant 轮次产生的
    // 多个结果合并进一条消息（原实现 anthropic.ts:130-138 的逻辑）。
    const last = out[out.length - 1];
    if (last && last.role === "user" && last.content.every(b => b.type === "tool_result")) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}

function toCompletion(data: AnthropicResponse): AgentCompletion {
  const content: LlmContentPart[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: (block.input ?? {}) as JsonValue,
      });
    }
  }
  return { content, ...(toolCalls.length ? { toolCalls } : {}) };
}

export function createAnthropicProvider(
  env: AnthropicEnv,
  fetchImpl: typeof fetch = fetch,
): LlmProvider {
  const endpoint = resolveEndpoint(env.LLM_BASE_URL || env.ANTHROPIC_API_BASE || "https://api.anthropic.com");
  const apiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY;
  const model = env.LLM_MODEL || env.ANTHROPIC_MODELS?.split(",")[0]?.trim() || "claude-3-5-sonnet-latest";

  return {
    async complete({ system, messages, tools }) {
      if (!apiKey) {
        throw new Error("No API key set — put LLM_API_KEY (or ANTHROPIC_API_KEY) in this worker's env");
      }
      const anthTools = tools.map((t: AgentToolDefinition) => ({
        name: t.name,
        description: t.description,
        input_schema: toInputSchema(t.inputSchema),
      }));
      const resp = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages: toAnthropicMessages(messages),
          ...(anthTools.length ? { tools: anthTools } : {}),
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
      return toCompletion(await resp.json() as AnthropicResponse);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(agent): Anthropic provider 进内核,翻译改为单向

原实现躺在 cloudflare-psd 这个叶子包里,其他文档类型用不到(P4);而且因为
循环内部用的是 OpenAI 消息格式,它必须双向翻译两次。现在循环内部是中立
格式,每个适配层只单向翻译一次。

findImage 和 previewMeta 一并删掉:图片现在是结构化的 image part,适配层
直接读,不需要在 JSON 字符串里递归搜索 \$image。previewMeta 那点知识本来
就属于 PSD,它会回到 psd 自己的 altText 里(下一个任务)。

env 的别名解析、endpoint 推导、max_tokens 与请求头原样保留。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: doctype-psd —— 工具表重写、改名、图片走 SBlob

psd 的三件事必须一起做：工具表换形状、名字去前缀、`getPreview` 改走 SBlob。分开做会让"提示词里的名字"和"工具表里的名字"在中间状态更不一致，也会让图片路径在两套约定之间反复横跳。

**旧的 `createPsdDocumentAgent` 保留成薄适配器**，让 `cloudflare-psd/src/worker.ts` 继续能跑到 Task 8 切换为止——这样这一步仓库仍然是绿的。

**Files:**
- Modify: `packages/doctype-psd/src/tools.ts`
- Modify: `packages/doctype-psd/src/queries.ts:96-101,163`
- Modify: `packages/doctype-psd/src/agent.ts`
- Modify: `packages/doctype-psd/src/index.ts`
- Modify: `packages/doctype-psd/package.json`、`tsconfig.json`（`@unidocs/doctype-server-common` 从 devDeps 移到 deps，tsconfig 加 reference）
- Test: `packages/doctype-psd/tests/agent.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentTool` / `DocumentAgent`；Task 2 的 `requireRecord` / `requireNumber` / `requireSBlob`
- Produces: `export const psdAgent: DocumentAgent<PsdQuery, PsdOp>`；工具名 `getLayers` / `getDoc` / `getPreview` / `addLayer` / `removeLayer` / `reorder` / `setProps` / `crop` / `transform` / `setAdjustment` / `editMask` / `generativeFill`

- [ ] **Step 1: 改测试**

`packages/doctype-psd/tests/agent.test.ts` 整体重写——从"调 `toolCall`"改成"调纯函数并断言返回值"：

```ts
import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import { psdAgent } from "../src/agent.js";

const tool = (name: string) => {
  const t = psdAgent.tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("PSD 工具表", () => {
  it("工具名不带 query_ / apply_ 前缀", () => {
    for (const t of psdAgent.tools) {
      expect(t.name).not.toMatch(/^(query|apply)_/);
    }
  });

  it("提示词里提到的每个工具名都真的存在（修 spec 5.3.1 的缺陷）", () => {
    const names = new Set(psdAgent.tools.map(t => t.name));
    for (const n of ["getLayers", "getDoc", "getPreview", "transform", "editMask", "setAdjustment", "addLayer", "generativeFill"]) {
      expect(names, `提示词让模型调 ${n}`).toContain(n);
    }
  });

  it("getLayers 无参数时不带 payload —— {} 不能掩盖默认值", () => {
    const t = tool("getLayers");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({})).toEqual({ kind: "getLayers" });
  });

  it("getDoc 有参数时透传成 payload", () => {
    const t = tool("getDoc");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ layerId: "L1" })).toEqual({ kind: "getDoc", payload: { layerId: "L1" } });
  });

  it("transform 产出一个 op，参数原样透传", () => {
    const t = tool("transform");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ layerId: "L1", op: { translate: [1, 2] } }))
      .toEqual([{ kind: "transform", payload: { layerId: "L1", op: { translate: [1, 2] } } }]);
  });

  it("toQuery / toOps 是纯函数：同参调两次结果深相等（spec V7）", () => {
    for (const t of psdAgent.tools) {
      const args = { layerId: "L1" };
      const once = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      const twice = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      expect(twice).toEqual(once);
    }
  });

  it("getPreview 返回 image content part，不再是 $image", () => {
    const t = tool("getPreview");
    if (t.kind !== "query" || !t.toResult) throw new Error("getPreview 必须有 toResult");
    const blob = createSBlob("a".repeat(64));
    const result = t.toResult(
      { image: blob, width: 8, height: 6, region: [0, 0, 6, 8] } as never,
      7,
    );
    expect(result.content).toEqual([{
      type: "image", blob, mediaType: "image/png",
      altText: "preview 8x6 region=[0,0,6,8] v7",
    }]);
    expect(result.structuredContent).toEqual({ width: 8, height: 6, region: [0, 0, 6, 8], version: 7 });
    expect(JSON.stringify(result)).not.toContain("$image");
  });

  it("getPreview 的结果缺 image 时抛错，不吞", () => {
    const t = tool("getPreview");
    if (t.kind !== "query" || !t.toResult) throw new Error("kind");
    expect(() => t.toResult!({ width: 8 } as never, 1)).toThrow(/SBlob/);
  });
});
```

`packages/doctype-psd/tests/` 下如有断言 `$image` 的其他用例（`git grep -n '\$image' packages/doctype-psd`），一并改成断言 SBlob。

**另外六个 preview 测试文件也会红**（预检发现，必做）：`getPreview` 现在需要 `ctx` 才能存 PNG，而这些用例今天都用 `runQuery({kind:"getPreview"}, doc)` 不传 ctx——

```
tests/render-preview.test.ts:20
tests/query-getpreview.test.ts:15,23,29,34
tests/query-getpreview-lazy.test.ts:72,81
tests/preview-payload-cap.test.ts:58,66,74,82,87,96,106
tests/cas-render.test.ts:105,119
```

现成的内存 CAS 已经存在，但被**抄了三份**（`cas-snapshot.test.ts:15`、`cas-render.test.ts:17`、`cas-e2e.test.ts:73` 的 `memCas()`）。把它提到 `packages/doctype-psd/tests/helpers/mem-cas.ts` 导出一份，三处原有的删掉改成 import，然后给上面那些调用点补上 `memCas().ctx`。

断言也跟着变：这些用例原本断言 `out.$image.base64` 之类，现在改成断言 `isSBlob(out.image)` 加 `out.width` / `out.height` / `out.region`。`preview-payload-cap.test.ts` 断言的是编码后的字节数，改成从 `memCas()` 的 `nodes` map 里按 hash 取出 PNG 再量长度——预算逻辑本身没变，只是产物从内联字符串变成了 CAS 里的一个节点。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-psd test`
Expected: FAIL —— `psdAgent` 不存在。

- [ ] **Step 3: 工具表换形状 + 改名**

`packages/doctype-psd/src/tools.ts`：`export const tools: Record<string, AgentToolDefinition>` 改成 `export const tools: readonly AgentTool<PsdQuery, PsdOp>[]`。每一项：

- 去掉外层的 key（`getLayers:` 那些），`name` 去掉前缀；
- 加 `kind`；
- `description` / `inputSchema` 原样；
- query 加 `toQuery`，op 加 `toOps`。

三个 query 的 `toQuery` 统一写法（保留"无参数不带 payload"的既有语义）：

```ts
const psdQuery = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    (Object.keys(args).length === 0 ? { kind } : { kind, payload: args }) as unknown as SValueType<PsdQuery>;
```

九个 op 的 `toOps` 统一写法：

```ts
const psdOp = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    [{ kind, payload: args }] as unknown as readonly SValueType<PsdOp>[];
```

改名对照（`apply_transform` 里"变换"和"提交"本是一步，叫 `transform` 就够了）：

```
query_getLayers        → getLayers
query_getDoc           → getDoc
query_getPreview       → getPreview
apply_add_layer        → addLayer
apply_remove_layer     → removeLayer
apply_reorder          → reorder
apply_set_props        → setProps
apply_crop             → crop
apply_transform        → transform
apply_adjust           → setAdjustment
apply_mask_edit        → editMask
apply_generative_fill  → generativeFill
```

提示词里的 `transformLayer` 改成 `transform`（其余四个 `editMask` / `setAdjustment` / `addLayer` / `generativeFill` 本来就是提示词在用的名字，现在工具表跟上了）。

- [ ] **Step 4: getPreview 改走 SBlob**

`packages/doctype-psd/src/queries.ts` —— `toImageResult` 变成 async 且需要 `ctx`：

```ts
/** PNG-encode 并交出一个 SBlob 引用；不再产生 base64（spec 5.3、2.4）。 */
async function toImageResult(
  source: Px,
  region: [number, number, number, number],
  maxSize: number,
  ctx: DocumentTypeContext,
): Promise<QueryValue> {
  const { px, png } = fitToBudget(source, maxSize);
  const image = await ctx.makeSBlob({ data: png, contentType: "image/png" });
  return { image, width: px.width, height: px.height, region } as unknown as QueryValue;
}
```

调用点 `queries.ts:163` 改成 `return toImageResult(px, region, maxSize, requireCtx(ctx))`。`ctx` 今天是可选参数，`getPreview` 分支需要它——加一个显式断言而不是 `!`：

```ts
function requireCtx(ctx: DocumentTypeContext | undefined): DocumentTypeContext {
  if (!ctx) throw new Error("getPreview needs a DocumentTypeContext to store the rendered PNG");
  return ctx;
}
```

`fitToBudget` 的字节预算注释要更新——它原本是为 SValue 字符串上限（1 MiB）设的，现在 PNG 走 CAS 不再受那个限制，但**保留这个预算**：它同时也是"别把几十 MB 塞进模型上下文"的保护。把注释改成后一个理由。

`getPreview` 的 `toResult`（写在 `tools.ts` 里）：

```ts
    toResult: (data, version) => {
      const d = requireRecord(data, "getPreview 结果");
      const width = requireNumber(d.width, "width");
      const height = requireNumber(d.height, "height");
      const region = d.region;
      return {
        content: [{
          type: "image",
          blob: requireSBlob(d.image, "getPreview image"),
          mediaType: "image/png",
          // 裁剪降级时模型看到的就是这句（spec 6.2.3 第 1 级）。
          // 这点知识一直属于 PSD，此前却写在大模型适配层的 previewMeta 里。
          altText: `preview ${width}x${height} region=${JSON.stringify(region)} v${version}`,
        }],
        structuredContent: { width, height, region, version } as JsonValue,
      };
    },
```

- [ ] **Step 5: agent.ts 变成一个常量 + 临时适配器**

```ts
/**
 * PSD DocumentAgent —— 一张纯数据的工具表加一段提示词。
 * 不接受任何句柄：工具声明自己是读还是写，由内核去调平台（spec 5.1）。
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { instructions, tools } from "./tools.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export const psdAgent: DocumentAgent<PsdQuery, PsdOp> = { tools, instructions };
```

同文件保留 `createPsdDocumentAgent`，改写成**基于新工具表**的适配器（让老 worker 撑到 Task 8）：

```ts
/**
 * @deprecated 只为让 cloudflare-psd 的旧 OperatorDO 撑到内核切换那一步，
 * 下一个任务连同旧 OperatorDO 一起删。新代码用 psdAgent。
 */
export const createPsdDocumentAgent: LegacyPsdDocumentAgentFactory = context => ({
  tools: Object.fromEntries(tools.map(t => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }])),
  instructions,
  async toolCall(name, parameters) { /* 按 kind 分发到 toQuery/toOps + context.query/apply，复用 tools 表 */ },
});
```

- [ ] **Step 6: 依赖声明与 tsconfig**

`@unidocs/doctype-server-common` 从 `devDependencies` 移到 `dependencies`（src 里现在有 `import type`，`package-deps.test.mjs` 规则 1 要求如此），`tsconfig.json` 的 `references` 加上对应条目（规则 4）。

Run: `pnpm vitest run tests/unit/workspace/package-deps.test.mjs`
Expected: PASS。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 8: 全仓库测试 + 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(psd): 工具表改成 AgentTool[],图片改走 SBlob

三件事一起做,因为分开会让\"提示词里的名字\"和\"工具表里的名字\"在中间
状态更不一致,也会让图片路径在两套约定之间反复横跳。

一、工具表从 Record<string, AgentToolDefinition> 变成 AgentTool[],每项
    声明 kind 并给一个把参数转成 query/op 的纯函数。agent.ts 从 80 行
    变成一个常量。

二、去掉 query_ / apply_ 前缀。前缀是分发器的机器语言不是给模型的名字,
    而这一版之后它彻底没用处 —— 工具是读是写由 kind 声明。顺带修掉一个
    已有缺陷:提示词里的 transformLayer / editMask / setAdjustment /
    addLayer / generativeFill 五个名字工具表里根本不存在,模型只能自己
    猜映射(spec 5.3.1)。apply_transform 也简化成 transform:\"变换\"和
    \"提交\"本来就是一步。

三、getPreview 从 btoa 产 base64 改成 makeSBlob 返回引用,配 toResult
    产出 image content part。base64 让数据膨胀三分之一,还撞过 SValue
    的字符串长度上限(da9028d 就是修这个)。previewMeta 那点知识回到
    PSD 自己的 altText 里 —— 它一直属于 PSD,此前却写在适配层。

createPsdDocumentAgent 暂时保留成基于新工具表的适配器,让旧 OperatorDO
撑到 Task 9 切换内核为止。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: markdown 与 docx 的工具表改形状

**Files:**
- Modify: `packages/doctype-markdown/src/agent.ts`（工具表就在这个文件里，markdown **没有** `tools.ts`）
- Modify: `packages/doctype-{markdown,docx}/package.json` / `tsconfig.json`
- Modify: `packages/doctype-docx/src/tools.ts`、`src/agent.ts`
- Modify: `packages/cloudflare-{markdown,docx}/src/worker.ts`
- Modify: 两个包的 `package.json` / `tsconfig.json`
- Test: `packages/doctype-markdown/tests/agent.test.ts`、`packages/doctype-docx/tests/agent.test.ts`

**Interfaces:**
- Consumes: Task 1 契约、Task 2 helper、Task 5/6 内核
- Produces: `export const markdownAgent: DocumentAgent<MQuery, MOp>`、`export const docxAgent: DocumentAgent<DocxQuery, DocxOperation>`

- [ ] **Step 1: markdown —— 改测试**

按 Task 7 的形状重写 `packages/doctype-markdown/tests/agent.test.ts`：断言工具名去前缀、`toQuery` / `toOps` 的产物、纯函数性。

- [ ] **Step 2: markdown —— 实现**

`markdownTools` 从 `Record<string, AgentToolDefinition>` 改成 `AgentTool[]`，名字去前缀（`getContent` / `getSection` / `getHeadings` / `setContent` / `appendSection` / `replaceSection` / `deleteSection`），导出 `markdownAgent` 常量。

**`createMarkdownDocumentAgent` 先不删**，和 Task 7 对 psd 做的一样：改写成基于新工具表的薄适配器，让 `cloudflare-markdown/src/worker.ts` 撑到 Task 9 一起切。docx 同理保留 `createDocxDocumentAgent`。这两个适配器由 Task 9 删除。

- [ ] **Step 3: docx —— 改测试**

同上，另加一条端到端（spec V11）：`getImage` 的 `toResult` 产出 image content part，且它能被 Task 6 的 `toAnthropicMessages` 翻成图片块**而不抛异常**——这条路今天从未真正跑通过（P6）。

- [ ] **Step 4: docx —— 实现**

`tools.ts` 换形状、去前缀。`agent.ts`：
- `queryImageContent`（`:51-81`）→ `getImage` 工具的 `toResult`，用 Task 2 的 `requireRecord` / `requireSBlob` 替掉本地那三个 helper；
- `makeOperation`（`:83-115`）→ 拆进 `insertImage` / `replaceImage` 两个工具的 `toOps`，`await resolveBlob(hash)` 变成同步的 `createSBlob(hash)`（租约由 `session.ts:611` 的 `leaseOpRefs` 在 apply 第 1 步做掉了，spec 5.1.1）；
- 删掉本地的 `requireString` / `requireNumber` / `requireSValueRecord`（已提到 svalue-codec）。

- [ ] **Step 5: 切两个 worker**

`cloudflare-markdown` / `cloudflare-docx` 的 `worker.ts` 改成注入常量 + 内核 provider。两者的 `llmProvider` 今天是抛异常的占位——**保持占位语义**（本区块不给它们配模型），但换成 `LlmProvider` 形状：

```ts
  provider: () => ({
    complete: async () => {
      throw new Error("LLM provider not configured. Set LLM_API_KEY in this worker's env.");
    },
  }),
```

- [ ] **Step 6: 依赖与 tsconfig**

两个包加 `@unidocs/doctype-server-common` 到 `dependencies` + tsconfig `references`。docx 还要确认 `@unidocs/svalue-codec` 已在 `dependencies`（它已经是）。

- [ ] **Step 7: 测试 + 提交**

```bash
pnpm test:local
git add -A
git commit -m "feat(doctype): markdown 与 docx 也切到内核

两个文档类型的工具表改成 AgentTool[],名字去前缀,agent.ts 各自变成一个
常量。docx 的 makeOperation 拆进 insertImage / replaceImage 的 toOps,
其中 await resolveBlob(hash) 变成同步的 createSBlob(hash) —— 租约本来就
由 session.ts:611 的 leaseOpRefs 在 apply 第 1 步做掉了,那次往返是多余的
(spec 5.1.1)。queryImageContent 变成 getImage 的 toResult。

docx 本地那三个 require* helper 删掉,改用 svalue-codec 里的共享版本。

docx 的图片路径这是第一次真正跑通:此前它必然撞上 renderDefaultAgentTool
Result 的抛异常分支,只是因为 llmProvider 本身就是个抛异常的占位所以一直
没暴露(P6)。补了一条端到端断言它能被 Anthropic 适配层翻成图片块。

两个 worker 的 provider 仍是占位 —— 本区块不给它们配模型,只是换成
LlmProvider 的形状。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: cloudflare-sdk —— 薄外壳，三个 worker 一起切到内核

这是**切换点**：旧循环退场，PSD 端到端跑在新内核上。

**Files:**
- Create: `packages/cloudflare-sdk/src/agent-platform-do.ts`
- Modify: `packages/cloudflare-sdk/src/operator-do-agent.ts`（326 行 → 薄外壳）
- Modify: `packages/cloudflare-sdk/src/operator-do.ts`、`src/index.ts`
- Modify: `packages/cloudflare-{psd,markdown,docx}/src/worker.ts`（**三个一起改** —— `createOperatorDO` 的 config 形状变了，只改一个会让另外两个编译不过）
- Delete: `packages/cloudflare-psd/src/anthropic.ts`
- Delete: `packages/cloudflare-psd/tests/anthropic-image.test.ts`
- Modify: `packages/doctype-{psd,markdown,docx}/src/agent.ts`（删掉 Task 7 / Task 8 留下的三个临时适配器）
- Test: `packages/cloudflare-sdk/tests/operator-do.test.ts`（按新形状重写）

**Interfaces:**
- Consumes: Task 5 的 `AgentSession`、Task 6 的 `createAnthropicProvider`、Task 7 的 `psdAgent`
- Produces: `createOperatorDO<TQuery, TOp, TEnv>(config: { agent: DocumentAgent<TQuery,TOp>; provider: (env: TEnv) => LlmProvider; getEditorStub; maxIterations? })`

- [ ] **Step 1: 重写测试**

`packages/cloudflare-sdk/tests/operator-do.test.ts` 的三个用例按 spec V12 逐条改写：

- 「dispatches JSON tool calls」→ 改测 `toQuery` / `toOps` 经内核到达平台（断言编辑器 stub 收到的 `/_internal/query` 和 `/_internal/apply` 请求体）。
- 「lets a provider renderer materialize multimodal SBlob results」→ 改测 image content part 直达适配层，**不需要渲染钩子**。
- 「requires a provider renderer for non-text content」→ **删除**，它断言的那个异常不再存在。

再补两条：`/_internal/reset` 清空历史；身份不一致返回 403（保留今天 `operator-do-agent.ts:188-191` 的行为）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-sdk test`
Expected: FAIL。

- [ ] **Step 3: 写 CloudflareAgentPlatform**

`packages/cloudflare-sdk/src/agent-platform-do.ts` —— 把今天 `operator-do-agent.ts:210-286` 的 `#query` / `#editorValueRequest` / `decodeValueResponse` / `isRecord` / `editorError` 搬过来（原样），`#apply` 和 `#readBlob` 按下面改，另加 `writeBlob`。

对外是一个工厂，OperatorDO 在拿到身份之后构造它：

```ts
export interface CloudflarePlatformDeps<TEnv> {
  readonly env: TEnv;
  readonly getEditorStub: (env: TEnv, editorObjectName: string) => DurableObjectStub;
  readonly editorObjectName: string;
  /** 从入站请求捕获的转发头（身份 + capability），见 operator-do-agent.ts:182-208。 */
  readonly requestHeaders: Headers;
}

export function createCloudflareAgentPlatform<TQuery, TOp, TEnv>(
  deps: CloudflarePlatformDeps<TEnv>,
): AgentPlatform<TQuery, TOp> { /* … */ }
```

**`apply` 不再带 `lastKnownVersion`。** 循环不记版本了（spec 5.2.1），平台自己读当前 head：

```ts
  async apply(operations, description) {
    // agent 的职责到"生成 op"为止 —— baseVersion 是编辑器写入路径的必需
    // 参数（editor-do-svalue.ts:576-584 缺了它直接 400），由这里读当前 head
    // 得到，而不是由循环记着上次 query 看到的版本（spec 5.2.1）。
    //
    // 代价是每次 apply 多一次轻量往返。之所以不让编辑器接受"不带
    // baseVersion 即用当前 head"，是因为那会给它开一条绕过版本校验的路径，
    // 影响的不只是 agent。真成为瓶颈时再单独讨论。
    const head = await headVersion();
    const response = await editorValueRequest("/_internal/apply", {
      operations: operations as unknown as readonly SValue[],
      description,
      baseVersion: head,
    });
    const value = await response.json() as { success?: unknown; version?: unknown; error?: unknown };
    if (!response.ok || value.success !== true || typeof value.version !== "number") {
      throw new Error(`Editor apply failed: ${String(value.error ?? response.statusText)}`);
    }
    return { version: value.version };
  }
```

`headVersion()` 走**已有的** `GET /_internal/status`——它返回 `{ exists, version }`（`editor-do-svalue.ts:506-510`），与文档类型无关，正是这里需要的。不用新增路由：

```ts
  async function headVersion(): Promise<number> {
    const response = await editorRequest("GET", "/_internal/status");
    const value = await response.json() as { exists?: unknown; version?: unknown };
    if (!response.ok || typeof value.version !== "number") {
      throw new Error(`Editor status failed: ${response.status}`);
    }
    if (value.exists !== true) throw new Error("Document not initialized");
    return value.version;
  }
```

`editorRequest` 是 `#editorValueRequest` 的无请求体变体——同一套转发头，方法可变，不发 body。把原来的 `#editorValueRequest` 拆成"建 headers + 定位 editorObjectName"和"发请求"两部分，两个调用方共用前者。

**`readBlob` 失败要分类**（Task 4 的契约、spec 6.6.0）：

```ts
  async readBlob(blob) {
    const response = await editorValueRequest("/_internal/read_blob", { blob });
    if (response.status === 404) {
      // 只有"确实没了"才让内核降级成文字。401/403/5xx 一律往上抛 ——
      // 把它们伪装成"图没了"正是 63f997b 修掉的坑。
      throw new BlobUnavailableError(`blob ${blob.hash} is gone`);
    }
    if (!response.ok) {
      throw new Error(`Editor read blob failed ${response.status}: ${await response.text() || response.statusText}`);
    }
    const contentType = response.headers.get("Content-Type");
    if (!contentType) throw new Error("Editor blob response has no Content-Type");
    return { data: new Uint8Array(await response.arrayBuffer()), contentType };
  }
```

**新增 `writeBlob`，本区块实现成显式未接线。** 编辑器今天**没有**写 blob 的内部路由——`editor-do-svalue.ts` 只有 `resolve_blob`（按 hash 造引用）和 `read_blob`（读字节），没有"给我字节、返回 SBlob"那条。而本区块也还没有调用方：`AgentSession` 只在 provider 返回二进制时才用它，而 Anthropic provider 现在只产出文字（Task 6）。

所以不要为一个没有调用方的功能现在去给编辑器开新路由：

```ts
  async writeBlob(): Promise<SBlob> {
    // 第一个调用方要等到 provider 真的返回图片或文件字节（spec 5.4.2）。
    // 那时给编辑器加一条 /_internal/write_blob，让它走 ctx.makeSBlob(data)
    // ——今天 editor-do-svalue.ts 只有 resolve_blob（按 hash 造引用）和
    // read_blob（读字节），没有"给我字节、返回 SBlob"那一条。
    throw new Error("writeBlob is not wired yet: no provider returns binary content");
  },
```

在提交信息里写明这一点，别让它看起来像漏了。

- [ ] **Step 4: OperatorDO 瘦身**

`operator-do-agent.ts` 只留：身份捕获与校验（`#captureIdentity` 原样）、`#requestTail` 串行化、惰性创建 `AgentSession`（spec 5.5.1：sessionId 来自请求头，DO 构造时还没有）、把 `AgentRunOutcome` 映射成今天完全一样的 JSON 响应（spec 7.5）。

**删掉**：`AgentToolResultRenderer` / `AgentToolResultRendererContext` / `OperatorConfig.renderToolResult` / `renderDefaultAgentToolResult` / `#dispatchToolCall` / `#lastKnownVersion` / `#session` / OpenAI 形状的工具表构造。P5、P6 一并解决。

`config` 从 `agentFactory` 改成 `agent`（常量），`llmProvider` 从"函数签名"改成 `(env) => LlmProvider`。

- [ ] **Step 5: 三个 worker 一起切**

`createOperatorDO` 的 config 形状变了（`agentFactory` → `agent`，`llmProvider` → `provider`），而三个 worker 都在调它，所以必须同一步改完——只改 psd 会让 markdown / docx 编译不过，违反"每个任务结束时全仓库绿"。

`packages/cloudflare-psd/src/worker.ts`：

```ts
import { psdAgent } from "@unidocs/doctype-psd";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";

export const PsdOperator = createOperatorDO({
  agent: psdAgent,
  provider: (env: Env) => createAnthropicProvider(env),
  getEditorStub: (env: Env, sessionId) => env.PSD_EDITOR.get(env.PSD_EDITOR.idFromName(sessionId)),
  maxIterations: 25,
});
```

`cloudflare-markdown` / `cloudflare-docx` 的 worker 换成各自的常量。两者**保持今天的占位语义**（本区块不给它们配模型），只是换成 `LlmProvider` 的形状：

```ts
export const MarkdownOperator = createOperatorDO({
  agent: markdownAgent,
  provider: () => ({
    complete: async () => {
      throw new Error("LLM provider not configured. Set LLM_API_KEY in this worker's env.");
    },
  }),
  getEditorStub: (env: Env, sessionId) => env.MARKDOWN_EDITOR.get(env.MARKDOWN_EDITOR.idFromName(sessionId)),
});
```

删除 `packages/cloudflare-psd/src/anthropic.ts`，以及测它的 `packages/cloudflare-psd/tests/anthropic-image.test.ts`——那两个用例断言的是 `$image` → image block 的转换，两端都已不存在；替代覆盖是 Task 6 的 `toAnthropicMessages` 测试（image part → Anthropic 图片块）加 Task 7 的 `getPreview` `toResult` 测试。

删掉三个文档类型 `agent.ts` 里 Task 7 / Task 8 留下的临时适配器。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-sdk test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 7: 本地栈端到端手验**

```bash
pnpm dev:cf
```

在 web-psd 里发一条多步指令（例如"把最上面的图层往右移 50 像素，然后给我看预览"）。确认：模型调到 `getLayers` / `transform` / `getPreview`；预览图模型真的看得见（回答里能描述画面）；`/run` 返回体形状与改造前一致。

**这一步也顺带验证 Task 0 的 R11**：观察一次长 run 是否会在 90 秒被掐断——如果仍然断在 90 秒，说明有配置没生效，回到 Task 0 Step 6 检查。

- [ ] **Step 8: 提交**

```bash
pnpm test:local
git add -A
git commit -m "refactor(cloudflare): OperatorDO 瘦成薄外壳,PSD 切到内核

operator-do-agent.ts 从 326 行降到只剩 DurableObject 外壳:身份校验、
请求串行化、惰性创建 AgentSession、把 AgentRunOutcome 映射成与今天
完全一样的 JSON 响应。循环、消息格式、工具分发全部搬进了内核。

文档读写变成 CloudflareAgentPlatform,是 AgentPlatform 的一个实现。
apply 不再依赖循环记着的 lastKnownVersion —— 平台自己读当前 head 作
baseVersion,agent 的职责到\"生成 op\"为止(spec 5.2)。readBlob 的 404
翻译成 BlobUnavailableError,其余错误原样上抛,不伪装成\"图没了\"。

一并删除:renderToolResult 钩子(全仓库无人设置,docx 的图片路径一跑就
撞它的抛异常分支)、renderDefaultAgentToolResult、cloudflare-psd 里那份
只有 psd 用得到的 anthropic.ts。P4/P5/P6 一起解决。

operator-do.test.ts 的三个用例逐条改写:前两个改测新形状,第三个断言的
那个异常不再存在,删除。

AgentPlatform.writeBlob 本轮实现成显式抛错,不是漏了:编辑器今天没有
\"给我字节、返回 SBlob\"那条内部路由,而本轮也没有调用方(provider 只
产出文字)。第一个调用方出现时再给编辑器加 /_internal/write_blob。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 清理 —— 删死代码与旧契约

区块 A 的收尾。此时没有任何代码还在用 `Legacy*`。

**Files:**
- Delete: `packages/doctype-server-common/src/operator.ts`
- Modify: `packages/doctype-server-common/src/index.ts:8`（删掉 `export * from "./operator.js"`）
- Modify: `packages/protocol/src/types.ts`（删 `Legacy*` 三个类型；删 `DocumentType.tools` / `.instructions`）
- Modify: `packages/doctype-psd/src/doctype.ts:94-95`、`packages/doctype-docx/src/docx.ts:215-216`（删两行）
- Modify: `packages/doctype-markdown/src/markdown.ts:110-190`（删重复的第二份工具表和提示词）
- Modify: `tests/unit/workspace/package-deps.test.mjs`（加 V4 的两条断言）

**Interfaces:**
- Consumes: 前面所有任务
- Produces: 无新接口，只有删除

- [ ] **Step 1: 确认真的没人用了**

```bash
git grep -n 'LegacyDocumentAgent\|OperatorSession\|renderToolResult\|\$image' -- packages | grep -v dist
```

Expected: 空。有残留就先清掉。

- [ ] **Step 2: 删死代码**

删 `doctype-server-common/src/operator.ts`（177 行，循环的第二份实现，已落后）以及 `src/index.ts:8` 的再导出——**这是包的公开 API 变化**，不只是删文件。

- [ ] **Step 3: 删 Legacy 契约与 DocumentType.tools**

`protocol/src/types.ts` 删掉 `LegacyDocumentAgent` / `LegacyDocumentAgentContext` / `LegacyDocumentAgentFactory`，以及 `DocumentType` 上的 `tools` / `instructions` 两个必填字段。

后者全仓库没有读取方——唯一读它的正是刚删掉的 `operator.ts:78`（spec 9.1.1）。跟着删：psd `doctype.ts:94-95`、docx `docx.ts:215-216` 各两行；markdown `markdown.ts:110-190` 那份**重复写的**工具表和提示词整段删掉（markdown 是唯一有两份的，agent.ts 那份才是被用的，两份已经漂移出差异）。

- [ ] **Step 4: 加 V4 的边界断言**

在 `tests/unit/workspace/package-deps.test.mjs` 的 `describe` 里追加：

```js
  const PLATFORM_SDKS = new Set(["@unidocs/cloudflare-sdk", "@unidocs/azure-sdk"]);

  test.each(packages.filter(p => PLATFORM_SDKS.has(p.name)).map(p => [p.name, p]))(
    "%s: 平台 sdk 不依赖任何文档类型", (_name, p) => {
      const bad = [...p.deps].filter(d =>
        d.startsWith("@unidocs/doctype-") && d !== "@unidocs/doctype-server-common").sort();
      expect(bad, `平台 sdk 依赖了文档类型：${bad.join(", ")}`).toEqual([]);
    },
  );

  test.each(packages.filter(p => p.name.startsWith("@unidocs/doctype-")
    && p.name !== "@unidocs/doctype-server-common").map(p => [p.name, p]))(
    "%s: 文档类型不依赖任何平台 sdk", (_name, p) => {
      const bad = [...p.deps, ...p.devDeps].filter(d => PLATFORM_SDKS.has(d)).sort();
      expect(bad, `文档类型依赖了平台 sdk：${bad.join(", ")}`).toEqual([]);
    },
  );
```

- [ ] **Step 5: 加 V5 的 import type 断言**

同文件追加——文档类型对内核的 import 必须全是 `import type`：

```js
  test.each(packages.filter(p => p.name.startsWith("@unidocs/doctype-")
    && p.name !== "@unidocs/doctype-server-common").map(p => [p.name, p]))(
    "%s: 对 doctype-server-common 的 src import 全是 import type", (_name, p) => {
      const dir = join(p.pkgRoot.dir, p.dirName);
      const offenders = [];
      for (const f of walk(dir)) {
        const rel = f.slice(dir.length + 1).replace(/\\/g, "/");
        if (rel.startsWith("tests/") || /\.(test|spec)\./.test(rel)) continue;
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes("@unidocs/doctype-server-common")) continue;
          if (!/^\s*import\s+type\b/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
      expect(offenders, `必须是 import type，否则服务端代码会进浏览器产物：\n${offenders.join("\n")}`).toEqual([]);
    },
  );
```

- [ ] **Step 6: 全仓库测试 + 提交**

```bash
pnpm test:local && pnpm typecheck
git add -A
git commit -m "chore(agent): 删掉死代码与旧契约,补上边界断言

一、doctype-server-common/src/operator.ts(177 行,循环的第二份实现,
    无人 import 且已落后)。注意它不只是删文件:index.ts:8 有一句
    export * from \"./operator.js\",所以 OperatorSession 等是这个包的
    公开导出,一并摘掉(P3)。

二、protocol 里的 LegacyDocumentAgent / LegacyDocumentAgentContext /
    LegacyDocumentAgentFactory —— 三个文档类型和 cloudflare-sdk 都迁完了。

三、DocumentType 上的 tools / instructions 两个必填字段。全仓库没有读取
    方,唯一读它的正是刚删掉的 operator.ts:78。跟着删 psd/docx 各两行;
    markdown.ts:110-190 那份重复写的工具表和提示词整段删掉 —— 三个文档
    类型里只有 markdown 有两份,agent.ts 那份才是被用的,两份早已漂移出
    差异(spec 9.1.1)。

四、package-deps.test.mjs 补三条断言:平台 sdk 不依赖文档类型、文档类型
    不依赖平台 sdk、文档类型对内核的 src import 全是 import type
    (spec V4、V5)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 区块 A 完成判据

对着 spec 第 11 章逐条核：

| # | 判据 | 怎么验 |
|---|---|---|
| V1 | 文档类型不再持有平台句柄 | `git grep -n 'context.query\|context.apply\|resolveBlob' -- packages/doctype-*/src` 为空；三个 `agent.ts` 各只导出一个常量 |
| V2 | 内核不按名字猜语义 | `git grep -n 'startsWith("query_")\|startsWith("apply_")'` 为空 |
| V3 | 内核不 import 云模块 | Task 5 Step 5 的 purity 测试 |
| V4 | 两侧互不依赖 | Task 10 Step 4 |
| V5 | 运行时代码隔离 | Task 10 Step 5（①）。②③（打包产物断言）留到区块 C 与 client-sdk 一起做——本区块还没动 psd-client |
| V6 / V6b / V6c | 循环、默认转换、规范化 | Task 3、Task 5 的契约测试 |
| V7 | `toQuery` / `toOps` 是纯函数 | Task 7 Step 1 的"同参调两次深相等" |
| V8 | 内核不持有版本状态 | `git grep -n 'version' packages/doctype-server-common/src/agent/session.ts` 只应出现在转发 platform 返回值处；Task 5 的"不先 query 直接 apply 也放行" |
| V9 | 送给模型的图片字节不变 | Task 8 Step 7 手验时抓一次 provider 请求体，与改造前对比 |
| V11 | docx 图片路径第一次跑通 | Task 9 Step 3 |
| V12 | `operator-do.test.ts` 逐条改写 | Task 8 Step 1 |
| V32 / V32b | run 的授权窗口 | Task 0 |
| V34 | readBlob 按类型分流 | Task 4 Step 1 |

**留给后续区块：** V10（Azure 跑通）、V13–V31（流式、持久化、裁剪、引用保活）、V33（长 run 端到端）、V5 的②③。

---

## 后续区块

| 区块 | spec 步骤 | 产出 |
|---|---|---|
| B | 7–10 | 历史裁剪、`AgentSessionStore` + 契约测试、根引用保活、run 租约 |
| C | 11–13 | 事件流 + SSE、`client-sdk` 的 `DocSession` 泛型化 + `AgentChannel`、web-psd 接上流式 |
| D | 14 | azure-sdk 的 `AgentPlatform` + `PgAgentSessionStore`，去掉 501 |
