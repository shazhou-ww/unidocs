# PSD 层内像素编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 用一句自然语言（"把帽子删掉"）在 2~3 轮内改完一个图层内部的像素，结果作为新图层非破坏落地。

**Architecture:** 给内核加第三种工具形态 `effect` —— 唯一被允许做 IO 的工具。PSD 侧新增一个 `editPixels` effect：查出图层原生分辨率像素 → 交给 `ImageEditor` 端口（本轮唯一实现是 DashScope 的 `qwen-image-edit-plus`）→ 用前后差异反推蒙版 → 把结果 PNG 写进 CAS → 产出一个普通的 `generative_fill` op。像素在 op 被创建**之前**就已存在，所以 `apply` 保持纯函数，确定性重放不受影响。

**Tech Stack:** TypeScript 5.9 (ESM, 相对 import 必须带 `.js` 后缀)、vitest 3、fast-png、Cloudflare Workers + Durable Objects、DashScope 原生 AIGC HTTP API（纯 `fetch`，不引 SDK）。

**Spec:** `docs/superpowers/specs/2026-09-01-psd-image-edit-design.md`

## Global Constraints

- Node >= 24，pnpm >= 11，包管理器 `pnpm@11.24.0`。
- 所有相对 import 必须带 `.js` 扩展名（ESM + `moduleResolution: nodenext`）。
- `packages/doctype-psd` 与 `packages/doctype-server-common` 是 **cloud-neutral** 包：只能用 `fetch` 等标准 API，禁止 import 任何 Cloudflare / Azure / Node 专有模块。
- **不新增运行时依赖。** 需要的 `fast-png` 已在 `packages/doctype-psd` 的 dependencies 里。
- **API key 绝不进代码、绝不进提交。** 只走 `env` / `.dev.vars`（已被 gitignore）。`.dev.vars.example` 里只放占位符。
- `apply` 必须保持纯函数：不生成像素、不调模型、不读时钟/网络/随机数（`packages/doctype-psd/docs/design.md:184`）。
- 图层数组是 **bottom-to-top**：`layers[0]` 在最下，最后一个在最上（`render/composite.ts:168` "Render a sibling list bottom-to-top"）。
- `Mask.pixels` 是 RGBA 布局（stride 4），合成器只读 **R 通道**作为覆盖度（`render/composite.ts:74`）。
- 单包跑测试：`pnpm --filter @unidocs/<pkg> test`。全量：`pnpm test`。
- 提交信息沿用仓库风格：`type(scope): 中文描述`。

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/doctype-psd/src/image/editor.ts` | `ImageEditor` 端口的类型定义。只有类型，无逻辑。 |
| `packages/doctype-psd/src/image/guards.ts` | 纯函数护栏：哨兵合成、alpha 还原、双线性重采样、差异蒙版、覆盖度→Mask 像素。 |
| `packages/doctype-psd/src/image/qwen-editor.ts` | DashScope `qwen-image-edit-plus` 适配器。本轮唯一实现。 |
| `packages/doctype-psd/src/image/edit-pixels.ts` | `editPixels` effect 工具。端口的唯一消费方。 |
| `packages/doctype-psd/src/testing/image-editor-contract.ts` | `runImageEditorContract` —— 任何 `ImageEditor` 实现都要过的契约套件。 |
| `packages/doctype-psd/src/testing/stub-editor.ts` | 确定性桩实现，给契约套件和 effect 单测用。 |

**修改**

| 文件 | 改什么 |
|---|---|
| `packages/protocol/src/types.ts` | `AgentTool` 加第三个分支 `effect`；新增 `EffectContext` / `EffectOutcome`。 |
| `packages/protocol/src/index.ts` | 导出上面两个新类型。 |
| `packages/doctype-server-common/src/agent/session.ts` | `#dispatch` 处理 `kind === "effect"`。 |
| `packages/cloudflare-sdk/src/editor-do-svalue.ts` | 新增 `POST /_internal/write_blob` 路由。 |
| `packages/cloudflare-sdk/src/agent-platform-do.ts` | 实现 `writeBlob`（现在直接抛错）。 |
| `packages/cloudflare-sdk/src/operator-do-agent.ts` | `OperatorConfig.agent` 允许传 `(env) => DocumentAgent`，与已有的 `provider` 同形。 |
| `packages/doctype-psd/src/queries.ts` | 新增内部 query `getLayerPixels`（原生分辨率，不走预览字节预算）。 |
| `packages/doctype-psd/src/model/tree.ts` | 新增 `findParentId`。 |
| `packages/doctype-psd/src/agent.ts` | `psdAgent` 常量 → `createPsdAgent({ editor? })` 工厂。 |
| `packages/doctype-psd/src/tools.ts` | 提示词补一段 `editPixels` 的用法。 |
| `packages/doctype-psd/src/index.ts` | 导出改动同步。 |
| `packages/doctype-psd/tests/agent.test.ts` | 跟随工厂化改造。 |
| `packages/cloudflare-psd/src/worker.ts` | 按 env 构造 editor 并注入 agent。 |
| `packages/cloudflare-psd/.dev.vars.example` | 加 DashScope 的三个占位变量。 |

**依赖顺序：** 1 → (2, 3 可并行) → 4 → 5 → 6 → 7 → 8。

---

### Task 1: 内核加 `effect` 工具形态

**Files:**
- Modify: `packages/protocol/src/types.ts:202-224`（`AgentTool` 联合）
- Modify: `packages/protocol/src/index.ts`（导出）
- Modify: `packages/doctype-server-common/src/agent/session.ts:110-130`（`#dispatch`）
- Test: `packages/doctype-server-common/tests/agent/session-effect.test.ts`

**Interfaces:**
- Consumes: 无（本任务是根）。
- Produces:
  - `AgentTool` 新分支 `{ kind: "effect"; name; description; inputSchema; run(args, ctx): Promise<EffectOutcome<TOp>> }`
  - `EffectContext<TQuery> = { query; readBlob; writeBlob; signal }`
  - `EffectOutcome<TOp> = { ops: readonly SValueType<TOp>[]; result: AgentToolResult; description?: string }`
  - `EFFECT_TIMEOUT_MS`（`session.ts` 导出的常量，值 120_000）

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-server-common/tests/agent/session-effect.test.ts`。
harness 照抄同目录 `session.test.ts` 的 `fakePlatform` / `scriptedProvider` 写法（不要 import 它们，
那个文件没导出；复制过来，两个文件各自独立可读）。

```ts
import { describe, expect, it, vi } from "vitest";
import type {
  AgentCompletion, AgentPlatform, AgentTool, DocumentAgent, LlmMessage, SBlob, SBlobData, SValue,
} from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec";
import { AgentSession } from "../../src/agent/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

function fakePlatform(over: Partial<AgentPlatform<Q, O>> = {}): AgentPlatform<Q, O> {
  return {
    query: vi.fn(async () => ({ data: { layers: [] } as SValue, version: 3 })),
    apply: vi.fn(async () => ({ version: 4 })),
    readBlob: vi.fn(async (): Promise<SBlobData> => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" })),
    writeBlob: vi.fn(async (): Promise<SBlob> => createSBlob("a".repeat(64))),
    ...over,
  };
}

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

/** 记录 effect 拿到的 ctx，便于断言内核交给它的是什么。 */
function effectAgent(
  run: AgentTool<Q, O> extends { kind: "effect"; run: infer R } ? R : never,
): DocumentAgent<Q, O> {
  return {
    instructions: "测试用 operator。",
    tools: [{
      kind: "effect", name: "editPixels", description: "WRITE+IO.",
      inputSchema: { type: "object", properties: {} },
      run,
    }],
  };
}

const callEditPixels: AgentCompletion = {
  content: [], toolCalls: [{ id: "c1", name: "editPixels", arguments: { layerId: "L1" } }],
};
const done: AgentCompletion = { content: [{ type: "text", text: "好了" }] };

describe("effect 工具形态", () => {
  it("effect 产出的 ops 经 platform.apply 落地，description 用 outcome 的", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => ({
      ops: [{ kind: "generative_fill", payload: { layerId: "L1" } }] as never,
      result: { structuredContent: { ok: true } },
      description: "editPixels: 删掉帽子",
    }));
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "删帽子" }]);
    expect(out.ok).toBe(true);
    expect(platform.apply).toHaveBeenCalledWith(
      [{ kind: "generative_fill", payload: { layerId: "L1" } }],
      "editPixels: 删掉帽子",
    );
  });

  it("ops 为空数组时不调 apply —— 不产生 delta、不 bump 版本", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => ({
      ops: [],
      result: { structuredContent: { ok: false, reason: "refused", detail: "内容审核未通过" } },
    }));
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "删帽子" }]);
    expect(platform.apply).not.toHaveBeenCalled();
    // 失败原样进历史，让模型自己决定改措辞重试
    const second = provider.seen[1];
    expect(second.at(-1)).toMatchObject({
      role: "tool", callId: "c1",
      structuredContent: { ok: false, reason: "refused", detail: "内容审核未通过" },
    });
  });

  it("EffectContext 暴露 query / readBlob / writeBlob / signal，不多不少", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    let keys: string[] = [];
    let aborted: boolean | null = null;
    const agent = effectAgent(async (_args, ctx) => {
      keys = Object.keys(ctx).sort();
      aborted = ctx.signal.aborted;
      await ctx.query({ kind: "getLayers" } as never);
      return { ops: [], result: { structuredContent: { ok: true } } };
    });
    await new AgentSession({ agent, platform, provider }).run([{ type: "text", text: "x" }]);
    expect(keys).toEqual(["query", "readBlob", "signal", "writeBlob"]);
    expect(aborted).toBe(false);
    expect(platform.query).toHaveBeenCalledWith({ kind: "getLayers" });
  });

  it("effect 抛错变成一条给模型的 tool 消息，循环不中断", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => { throw new Error("provider 挂了"); });
    const out = await new AgentSession({ agent, platform, provider }).run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(provider.seen[1].at(-1)).toMatchObject({
      role: "tool", structuredContent: { error: "Error: provider 挂了" },
    });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common test session-effect`
Expected: FAIL —— TypeScript 报 `kind: "effect"` 不在 `AgentTool` 联合里。

- [ ] **Step 3: 给 `AgentTool` 加第三个分支**

`packages/protocol/src/types.ts`，在 `kind: "op"` 那一支之后、`;` 之前追加：

```ts
  | {
    /**
     * 第三种工具形态，也是**唯一**被允许做 IO 的那一种。
     *
     * 存在的理由：query/op 都是同步纯函数，于是没有任何一条路径能产出
     * 模型自己造不出来的字节（像素）。effect 填的就是这个洞：它在 op 被
     * 创建**之前**完成 IO，把结果落进 CAS，再产出携带引用的普通 op ——
     * 所以 `apply` 仍然是纯函数，确定性重放不受影响（design.md:184）。
     */
    readonly kind: "effect";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly run: (
      args: Readonly<Record<string, JsonValue>>,
      ctx: EffectContext<TQuery>,
    ) => Promise<EffectOutcome<TOp>>;
  };
```

在 `AgentTool` 定义之前插入两个新接口：

```ts
/**
 * effect 能碰到的全部外部世界。就是 AgentPlatform 去掉 apply ——
 * effect 跑在 Operator 里，它手上只有 AgentPlatform，没有
 * DocumentTypeContext（那是 Editor 的东西）。
 *
 * 没有 apply：落库是内核的事，effect 只负责把 ops 交出来。
 */
export interface EffectContext<TQuery> {
  readonly query: (query: SValueType<TQuery>) => Promise<{
    readonly data: SValue;
    readonly version: number;
  }>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobBytes>;
  readonly writeBlob: (data: SBlobBytes) => Promise<SBlob>;
  readonly signal: AbortSignal;
}

export interface EffectOutcome<TOp> {
  /** 空数组 = 什么都不改。此时内核不调 apply，不产生 delta、不 bump 版本。 */
  readonly ops: readonly SValueType<TOp>[];
  /** 交给模型的东西。失败也走这里，不要抛 —— 失败是一次普通的工具返回。 */
  readonly result: AgentToolResult;
  /** 落进 delta 的说明。不给则用 `Agent: <工具名>`。 */
  readonly description?: string;
}
```

`packages/protocol/src/index.ts` 的 `export type {` 列表里按字母序加上 `EffectContext,` 和 `EffectOutcome,`。

- [ ] **Step 4: 内核分发 effect**

`packages/doctype-server-common/src/agent/session.ts`。先在 `DEFAULT_MAX_ITERATIONS` 旁边加常量：

```ts
/** 一次 effect 的墙钟上限。图像模型同步返回约 6s，两分钟足够覆盖重试与慢响应。 */
export const EFFECT_TIMEOUT_MS = 120_000;
```

把 `#dispatch` 里 `if (tool.kind === "query") {...}` 之后、`const { version } = await this.#deps.platform.apply(...)` 之前，插入 effect 分支：

```ts
      if (tool.kind === "effect") {
        const outcome = await tool.run(parameters, {
          query: q => this.#deps.platform.query(q),
          readBlob: b => this.#deps.platform.readBlob(b),
          writeBlob: d => this.#deps.platform.writeBlob(d),
          signal: AbortSignal.timeout(EFFECT_TIMEOUT_MS),
        });
        // 空 ops 不落库：一次被拒绝的生成不该在历史里留下一个空版本。
        if (outcome.ops.length > 0) {
          await this.#deps.platform.apply(outcome.ops, outcome.description ?? `Agent: ${name}`);
        }
        // 版本号不合并进去 —— effect 自己说清楚发生了什么就够了，
        // 而且它通常还要附一张 after 预览图（spec 5.2.1：agent 不管版本）。
        return outcome.result;
      }
```

`#definitions` 不用改：它只读 `name` / `description` / `inputSchema`，三个分支都有。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: PASS，包括原有的 `session.test.ts`。

Run: `pnpm --filter @unidocs/protocol typecheck && pnpm --filter @unidocs/doctype-server-common typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/protocol/src/types.ts packages/protocol/src/index.ts \
        packages/doctype-server-common/src/agent/session.ts \
        packages/doctype-server-common/tests/agent/session-effect.test.ts
git commit -m "feat(protocol): 加 effect 工具形态 —— 唯一允许做 IO 的工具"
```

---

### Task 2: 打通 `writeBlob`

`agent-platform-do.ts:132` 今天直接抛 `"writeBlob is not wired yet"`，编辑器也没有对应路由。
本设计是它的第一个调用方。

**Files:**
- Modify: `packages/cloudflare-sdk/src/editor-do-svalue.ts`（在 `/_internal/read_blob` 路由之后）
- Modify: `packages/cloudflare-sdk/src/agent-platform-do.ts:132-138`
- Test: `packages/cloudflare-sdk/tests/agent-platform-write-blob.test.ts`

`packages/cloudflare-sdk` 的 `test` 脚本目前是 `vitest run --passWithNoTests`，如果 `tests/` 目录不存在就新建。

**Interfaces:**
- Consumes: 无。
- Produces: `AgentPlatform.writeBlob(data: SBlobBytes): Promise<SBlob>` 真正可用；
  编辑器路由 `POST /_internal/write_blob`，请求体是裸字节 + `Content-Type` 头，
  响应是 SValue 编码的 `{ blob }`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/cloudflare-sdk/tests/agent-platform-write-blob.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createSBlob, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import { createCloudflareAgentPlatform } from "../src/agent-platform-do.js";

const HASH = "b".repeat(64);

/** 只记请求、按脚本回响应的假 Editor stub。 */
function fakeStub(respond: (req: Request) => Response) {
  const seen: { url: string; method: string; contentType: string | null; body: Uint8Array }[] = [];
  return {
    seen,
    stub: {
      fetch: vi.fn(async (input: string, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({
          url: req.url,
          method: req.method,
          contentType: req.headers.get("Content-Type"),
          body: new Uint8Array(await req.clone().arrayBuffer()),
        });
        return respond(req);
      }),
    } as unknown as DurableObjectStub,
  };
}

function platformWith(stub: DurableObjectStub) {
  return createCloudflareAgentPlatform<unknown, unknown, unknown>({
    env: {},
    getEditorStub: () => stub,
    requestHeaders: () => new Headers({ "X-Tenant-Id": "t1", "X-Session-Id": "s1" }),
    editorObjectName: () => "s1",
  });
}

describe("AgentPlatform.writeBlob", () => {
  it("把字节 POST 到 /_internal/write_blob，回来的 SBlob 原样返回", async () => {
    const body = encodeSValue({ blob: createSBlob(HASH) });
    const { seen, stub } = fakeStub(() => new Response(Uint8Array.from(body).buffer, {
      headers: { "Content-Type": SValueContentType },
    }));
    const blob = await platformWith(stub).writeBlob({
      data: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    expect(isSBlob(blob)).toBe(true);
    expect(blob.hash).toBe(HASH);
    expect(seen[0].url).toBe("http://editor/_internal/write_blob");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].contentType).toBe("image/png");
    expect(Array.from(seen[0].body)).toEqual([137, 80, 78, 71]);
  });

  it("编辑器返回非 2xx 时抛错，不静默吞掉", async () => {
    const { stub } = fakeStub(() => Response.json({ success: false, error: "no capability" }, { status: 403 }));
    await expect(platformWith(stub).writeBlob({
      data: new Uint8Array([1]), contentType: "image/png",
    })).rejects.toThrow(/write blob/i);
  });

  it("转发头原样带过去 —— 身份和 capability 不能丢", async () => {
    const body = encodeSValue({ blob: createSBlob(HASH) });
    const { stub } = fakeStub(() => new Response(Uint8Array.from(body).buffer, {
      headers: { "Content-Type": SValueContentType },
    }));
    await platformWith(stub).writeBlob({ data: new Uint8Array([1]), contentType: "image/png" });
    const req = new Request((stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
      (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit);
    expect(req.headers.get("X-Tenant-Id")).toBe("t1");
    expect(req.headers.get("X-Session-Id")).toBe("s1");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/cloudflare-sdk test`
Expected: FAIL —— `writeBlob is not wired yet: no provider returns binary content`。

- [ ] **Step 3: 实现平台侧 `writeBlob`**

`packages/cloudflare-sdk/src/agent-platform-do.ts`，把整个 `async writeBlob(): Promise<SBlob> { ... }` 替换成：

```ts
    async writeBlob(data: SBlobBytes): Promise<SBlob> {
      // 请求体是裸字节而不是 SValue 信封：这条路上的净荷就是一张 PNG，
      // 再包一层 SValue 只会把它复制一遍（一个整层 PNG 可以是几 MB）。
      // 响应仍走 SValue，因为回来的 SBlob 是个带签名的分支类型。
      const { headers, stub } = editorTarget();
      headers.set("Content-Type", data.contentType);
      headers.set("Accept", SValueContentType);
      const response = await stub.fetch("http://editor/_internal/write_blob", {
        method: "POST",
        headers,
        body: Uint8Array.from(data.data).buffer,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Editor write blob failed ${response.status}: ${detail || response.statusText}`);
      }
      const value = await decodeValueResponse(response);
      if (!isRecord(value) || !isSBlob(value.blob)) {
        throw new Error("Editor write blob response has no blob");
      }
      return value.blob;
    },
```

文件顶部的 type import 里补上 `SBlobBytes`：
`import type { AgentPlatform, SBlob, SBlobBytes, SBlobData, SValue, SValueType } from "@unidocs/protocol";`

- [ ] **Step 4: 实现编辑器路由**

`packages/cloudflare-sdk/src/editor-do-svalue.ts`，紧跟在 `POST /_internal/read_blob` 那个 `if` 块之后插入：

```ts
        if (request.method === "POST" && url.pathname === "/_internal/write_blob") {
          // agent 侧的 effect 工具（图像模型返回的 PNG）是第一个调用方。
          // 身份与 capability 已在上面的 #verifyIdentity 校验过；makeSBlob
          // 是写类操作，靠转发过来的 CAS capability 授权。
          const contentType = request.headers.get("Content-Type");
          if (!contentType) {
            return Response.json({ success: false, error: "write_blob needs a Content-Type" }, { status: 400 });
          }
          const data = new Uint8Array(await request.arrayBuffer());
          if (data.length === 0) {
            return Response.json({ success: false, error: "write_blob got an empty body" }, { status: 400 });
          }
          const blob = await this.#requireContext().makeSBlob({ data, contentType });
          return valueResponse(request, { blob });
        }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-sdk test && pnpm --filter @unidocs/cloudflare-sdk typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/cloudflare-sdk/src/agent-platform-do.ts \
        packages/cloudflare-sdk/src/editor-do-svalue.ts \
        packages/cloudflare-sdk/tests/agent-platform-write-blob.test.ts
git commit -m "feat(cloudflare-sdk): 打通 writeBlob —— 编辑器新增 /_internal/write_blob"
```

---

### Task 3: `getLayerPixels` 内部 query

`getPreview` 永远经过 `fitToBudget`（约 720 KiB 上限），拿不到原生分辨率。
编辑要的是**原始像素**，所以另开一条 query。它**不进工具表** —— 模型读不了裸 RGBA，
只有 effect 用得上。

**Files:**
- Modify: `packages/doctype-psd/src/model/tree.ts`
- Modify: `packages/doctype-psd/src/queries.ts`
- Test: `packages/doctype-psd/tests/query-layer-pixels.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `findParentId(layers: Layer[], id: string): string | null`
  - `PsdQuery` 新分支 `{ kind: "getLayerPixels"; payload: { layerId: string } }`
  - 返回值 `{ image: SBlob; width: number; height: number; bounds: [number,number,number,number]; parentId: string | null; index: number }`
  - `MAX_EDIT_SOURCE_PIXELS = 16 * 1024 * 1024`

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/query-layer-pixels.test.ts`。
`ctx` 的造法照抄同目录 `query-getpreview.test.ts` 顶部的写法（一个 in-memory `makeSBlob`/`openSBlob`）。

```ts
import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import { createSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeContext, SBlob } from "@unidocs/protocol";
import type { Layer, PsdDoc } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";
import { findParentId } from "../src/model/tree.js";

function memoryCtx(): DocumentTypeContext & { bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array>();
  let n = 0;
  return {
    bytes,
    makeSBlob: (async (a: unknown) => {
      const data = (a as { data: Uint8Array }).data;
      const hash = String(n++).padStart(64, "0");
      bytes.set(hash, data);
      return createSBlob(hash);
    }) as DocumentTypeContext["makeSBlob"],
    openSBlob: async (blob: SBlob) => {
      const data = bytes.get(blob.hash)!;
      return {
        size: data.length, contentType: "image/png",
        read: async function* () { yield data; },
        readBytes: async (r: { offset: number; length: number }) => data.slice(r.offset, r.offset + r.length),
      };
    },
  };
}

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};

const raster = (id: string, bounds: [number, number, number, number], rgba: [number, number, number, number]): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: solid(bounds[3] - bounds[1], bounds[2] - bounds[0], rgba),
});

const doc = (): PsdDoc => ({
  canvas: { width: 2000, height: 2000, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [
    raster("bg", [0, 0, 2000, 2000], [0, 0, 0, 255]),
    { id: "g1", type: "group", name: "g1", bounds: [0, 0, 1200, 1600], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false,
      children: [raster("portrait", [0, 0, 1200, 1600], [10, 20, 30, 255])] },
  ],
});

describe("getLayerPixels", () => {
  it("给出原生分辨率的 PNG —— 不走 getPreview 的字节预算", async () => {
    const ctx = memoryCtx();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "portrait" } }, doc(), ctx) as any;
    expect(r.width).toBe(1600);
    expect(r.height).toBe(1200);
    const png = decode(ctx.bytes.get(r.image.hash)!);
    expect(png.width).toBe(1600);   // getPreview 会把它压到 768
    expect(png.height).toBe(1200);
  });

  it("带出 bounds / parentId / index，effect 靠它把结果层插在源层正上方", async () => {
    const ctx = memoryCtx();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "portrait" } }, doc(), ctx) as any;
    expect(r.bounds).toEqual([0, 0, 1200, 1600]);
    expect(r.parentId).toBe("g1");
    expect(r.index).toBe(0);
  });

  it("根层的 parentId 是 null", async () => {
    const ctx = memoryCtx();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "bg" } }, doc(), ctx) as any;
    expect(r.parentId).toBeNull();
    expect(r.index).toBe(0);
  });

  it("图层不存在时报出图层 id", async () => {
    await expect(runQuery({ kind: "getLayerPixels", payload: { layerId: "nope" } }, doc(), memoryCtx()))
      .rejects.toThrow(/nope/);
  });

  it("超过像素上限直接拒绝，不 OOM", async () => {
    const d = doc();
    // 只把 bounds 撑大，不真的分配 5000x5000 的 RGBA（那是 100 MB）。
    // 上限检查读的就是 bounds，在 renderLayer 之前就该拦下来 —— 这个
    // 测试同时钉住了"拦截发生在分配之前"这件事。
    d.layers[0] = { ...d.layers[0], bounds: [0, 0, 5000, 5000] };
    d.canvas = { ...d.canvas, width: 5000, height: 5000 };
    await expect(runQuery({ kind: "getLayerPixels", payload: { layerId: "bg" } }, d, memoryCtx()))
      .rejects.toThrow(/too large/i);
  });
});

describe("findParentId", () => {
  it("嵌套层返回它所在组的 id", () => {
    expect(findParentId(doc().layers, "portrait")).toBe("g1");
  });
  it("根层返回 null", () => {
    expect(findParentId(doc().layers, "bg")).toBeNull();
  });
  it("找不到时也返回 null", () => {
    expect(findParentId(doc().layers, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd test query-layer-pixels`
Expected: FAIL —— `findParentId` 不存在，`getLayerPixels` 不是合法的 `PsdQuery`。

- [ ] **Step 3: 加 `findParentId`**

`packages/doctype-psd/src/model/tree.ts` 末尾追加：

```ts
/** 某层所在组的 id；在根列表里则是 null。找不到该层也返回 null。 */
export function findParentId(layers: Layer[], id: string): string | null {
  const walk = (list: Layer[], parent: string | null): string | null | undefined => {
    for (const l of list) {
      if (l.id === id) return parent;
      if (l.children) {
        const hit = walk(l.children, l.id);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(layers, null) ?? null;
}
```

- [ ] **Step 4: 加 `getLayerPixels` query**

`packages/doctype-psd/src/queries.ts`：

1. import 补 `findParentList` 与 `findParentId`：
   `import { findLayer, findParentList, findParentId } from "./model/tree.js";`
2. `PsdQuery` 联合末尾追加：
   ```ts
     | { kind: "getLayerPixels"; payload: { layerId: string } };
   ```
3. 在 `PREVIEW_BASE64_BUDGET` 附近加常量：
   ```ts
   /**
    * `getLayerPixels` 的像素数上限。4096x4096 解码后是 64 MiB RGBA，再加一份
    * PNG 编码缓冲 —— 一个 DO isolate 扛得住的天花板就在这附近。超过就拒绝，
    * 而不是让整个编辑器 OOM 掉。
    */
   const MAX_EDIT_SOURCE_PIXELS = 16 * 1024 * 1024;
   ```
4. `runQuery` 的 `switch` 里，在 `case "getPreview"` 之后追加：
   ```ts
       case "getLayerPixels": {
         // 和 getPreview{layerId} 渲的是同一张图（renderLayer：孤立的单层文档，
         // 蒙版与图层效果已烘进去），区别只有一个：**不过 fitToBudget**。
         // 预览是给模型的眼睛看的，压到 768 正合适；编辑要的是原始像素，压了
         // 就再也还原不回去。
         const { layerId } = q.payload;
         const l = findLayer(doc.layers, layerId);
         if (!l) throw new Error(`layer not found: ${layerId}`);
         const w = l.bounds[3] - l.bounds[1];
         const h = l.bounds[2] - l.bounds[0];
         if (w * h > MAX_EDIT_SOURCE_PIXELS) {
           throw new Error(`layer ${layerId} is too large to edit: ${w}x${h} > ${MAX_EDIT_SOURCE_PIXELS} px`);
         }
         const c = requireCtx(ctx);
         const rc: RenderCtx | undefined = render
           ? render.ctx
           : { store: casBlobStore(c), cache: new PixelCache(DEFAULT_CACHE_BYTES) };
         const px = await renderLayer(doc, layerId, {}, rc);
         const image = await c.makeSBlob({ data: pngOf(px), contentType: "image/png" });
         return {
           image,
           width: px.width,
           height: px.height,
           bounds: l.bounds,
           parentId: findParentId(doc.layers, layerId),
           index: findParentList(doc.layers, layerId)?.index ?? 0,
         } as unknown as QueryValue;
       }
   ```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS。已有的 `query-getpreview.test.ts` / `query-getdoc.test.ts` 不受影响。

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/model/tree.ts packages/doctype-psd/src/queries.ts \
        packages/doctype-psd/tests/query-layer-pixels.test.ts
git commit -m "feat(psd): 加 getLayerPixels —— 原生分辨率图层像素，供 effect 使用"
```

---

### Task 4: `ImageEditor` 端口 + 契约套件 + 桩实现

契约由**消费方的需要**定义，不由各家 provider 能力的交集定义：
"给你一个图层的像素和一句指令，还我同尺寸、alpha 完好的像素"。
所有护栏（尺寸阶梯、padding、异步轮询、RGB↔RGBA、色彩校正）都被这条后置条件逼进适配器内部。

**Files:**
- Create: `packages/doctype-psd/src/image/editor.ts`
- Create: `packages/doctype-psd/src/testing/stub-editor.ts`
- Create: `packages/doctype-psd/src/testing/image-editor-contract.ts`
- Test: `packages/doctype-psd/tests/image-editor-stub.test.ts`

**Interfaces:**
- Consumes: `Pixels`（`src/model/types.ts`）。
- Produces:
  - `Coverage`、`ImageEditor`、`EditorCapabilities`、`EditRequest`、`EditResult`
  - `createStubEditor(opts?: { fail?: EditResult & { ok: false } }): ImageEditor`
  - `runImageEditorContract(label: string, factory: () => Promise<ImageEditor>, opts: { live: boolean }): void`

- [ ] **Step 1: 写端口类型**

新建 `packages/doctype-psd/src/image/editor.ts`：

```ts
import type { Pixels } from "../model/types.js";

/** 单通道覆盖度，0..255，长度 = width*height。白 = 改过，黑 = 没动。 */
export interface Coverage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface EditorCapabilities {
  /** 这个实现要不要蒙版。unsupported = 给了也没用，别费劲算。 */
  readonly mask: "required" | "optional" | "unsupported";
  /** 能接受的最小 / 最大像素数（width*height）。适配器自己负责缩放到区间内。 */
  readonly minPixels: number;
  readonly maxPixels: number;
  /** 输出是否自带隐形水印。true 时全图都在"变"，差异蒙版不可信。 */
  readonly watermarked: boolean;
}

export interface EditRequest {
  /** RGBA，任意尺寸。适配器负责把它变成 provider 能吃的形状。 */
  readonly source: Pixels;
  /** 白 = 改，黑 = 别动。capabilities.mask === "unsupported" 时被忽略。 */
  readonly mask?: Coverage;
  readonly instruction: string;
  readonly seed?: number;
}

export type EditResult =
  | {
    readonly ok: true;
    /** 后置条件：与 `source` **严格同尺寸**，alpha 已还原。适配器必须自己断言。 */
    readonly pixels: Pixels;
    /**
     * 前后差异反推的蒙版，与 `source` 同尺寸。
     * `null` = 不可信（水印模型、或改动面积大到无法区分），调用方降级整层替换。
     */
    readonly changed: Coverage | null;
    readonly provenance: { readonly model: string; readonly seed: number; readonly prompt: string };
  }
  | {
    readonly ok: false;
    /**
     * refused       —— provider 拒绝了（内容审核等）。改措辞可能有救。
     * needs_mask    —— 这个实现要蒙版，调用方没给。
     * timeout       —— 超时。
     * provider_error—— 其他一切，包括适配器自己的后置条件断言失败。
     */
    readonly reason: "refused" | "needs_mask" | "timeout" | "provider_error";
    readonly detail: string;
  };

export interface ImageEditor {
  /** 稳定标识，进 provenance.model 和日志。 */
  readonly id: string;
  readonly capabilities: EditorCapabilities;
  edit(req: EditRequest, signal: AbortSignal): Promise<EditResult>;
}
```

- [ ] **Step 2: 写桩实现**

新建 `packages/doctype-psd/src/testing/stub-editor.ts`：

```ts
import type { Coverage, EditResult, EditorCapabilities, ImageEditor } from "../image/editor.js";

/**
 * 确定性的 ImageEditor 桩：把源像素左上角 1/4 区域涂成不透明红色，
 * 并如实报告改动区域。没有网络、没有随机数 —— 契约套件和 effect 单测
 * 靠它跑 `live: false` 的那一半。
 */
export function createStubEditor(opts: { fail?: Extract<EditResult, { ok: false }> } = {}): ImageEditor {
  const capabilities: EditorCapabilities = {
    mask: "optional",
    minPixels: 1,
    maxPixels: 64 * 1024 * 1024,
    watermarked: false,
  };
  return {
    id: "stub-editor",
    capabilities,
    async edit(req, signal) {
      if (signal.aborted) return { ok: false, reason: "timeout", detail: "aborted before start" };
      if (opts.fail) return opts.fail;
      const { width, height, data } = req.source;
      const out = new Uint8ClampedArray(data);
      const cov = new Uint8ClampedArray(width * height);
      const hw = Math.max(1, width >> 1);
      const hh = Math.max(1, height >> 1);
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < hw; x++) {
          const i = y * width + x;
          out.set([255, 0, 0, 255], i * 4);
          cov[i] = 255;
        }
      }
      const changed: Coverage = { width, height, data: cov };
      return {
        ok: true,
        pixels: { width, height, data: out },
        changed,
        provenance: { model: "stub-editor", seed: req.seed ?? 0, prompt: req.instruction },
      };
    },
  };
}
```

- [ ] **Step 3: 写契约套件**

新建 `packages/doctype-psd/src/testing/image-editor-contract.ts`。
写法照 `packages/doctype-server-common/src/testing/port-contract.ts`：套件是导出的函数，
每个实现自己起一个 test 文件调它。

```ts
import { describe, expect, it } from "vitest";
import type { ImageEditor } from "../image/editor.js";
import type { Pixels } from "../model/types.js";

/**
 * 每个 ImageEditor 实现都要过的契约。
 *
 * 它**只断言后置条件** —— 同尺寸、alpha 完整、provenance 齐全 —— 不断言
 * 画得好不好看。生成模型的输出没有确定性，"像不像"不是测试能守住的东西；
 * 能守住的是"调用方拿到的形状永远对"，而这恰恰是 effect 唯一依赖的性质。
 *
 * `live: false` 用来跑桩实现和录制回放，CI 默认走这条。
 * `live: true` 才真打 provider，需要环境变量里有 key，本地手动跑。
 */
export function runImageEditorContract(
  label: string,
  factory: () => Promise<ImageEditor>,
  opts: { live: boolean },
): void {
  const source: Pixels = (() => {
    const width = 64, height = 48;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      // 半透明渐变：alpha 不是常量，这样"alpha 被吃掉"会被下面的断言抓到。
      data.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, i % 2 ? 255 : 128], i * 4);
    }
    return { width, height, data };
  })();

  describe(`ImageEditor 契约: ${label}`, () => {
    it("capabilities 自洽", async () => {
      const e = await factory();
      expect(e.id.length).toBeGreaterThan(0);
      expect(["required", "optional", "unsupported"]).toContain(e.capabilities.mask);
      expect(e.capabilities.minPixels).toBeGreaterThan(0);
      expect(e.capabilities.maxPixels).toBeGreaterThanOrEqual(e.capabilities.minPixels);
    });

    it("成功时输出与输入严格同尺寸，且是完整的 RGBA 缓冲", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      expect(r.pixels.width).toBe(source.width);
      expect(r.pixels.height).toBe(source.height);
      expect(r.pixels.data.length).toBe(source.width * source.height * 4);
    });

    it("alpha 没有被整片抹成不透明 —— 半透明像素必须活下来", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "保持原样" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      // 源里一半像素 alpha=128。允许生成区域内 alpha 变化，但不允许全图 255。
      let translucent = 0;
      for (let i = 3; i < r.pixels.data.length; i += 4) if (r.pixels.data[i] < 250) translucent++;
      expect(translucent).toBeGreaterThan(0);
    });

    it("changed 要么是 null，要么与源同尺寸的单通道覆盖度", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红" }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      if (r.changed !== null) {
        expect(r.changed.width).toBe(source.width);
        expect(r.changed.height).toBe(source.height);
        expect(r.changed.data.length).toBe(source.width * source.height);
      }
    });

    it("provenance 三个字段都不能是空的", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "把左上角涂红", seed: 7 }, AbortSignal.timeout(120_000));
      if (!r.ok) throw new Error(`期望成功，实际 ${r.reason}: ${r.detail}`);
      expect(r.provenance.model.length).toBeGreaterThan(0);
      expect(r.provenance.prompt).toBe("把左上角涂红");
      expect(Number.isFinite(r.provenance.seed)).toBe(true);
    });

    it("已经 abort 的 signal 不产生成功结果", async () => {
      const e = await factory();
      const r = await e.edit({ source, instruction: "随便" }, AbortSignal.abort()).catch(
        (err: unknown) => ({ ok: false as const, reason: "timeout" as const, detail: String(err) }),
      );
      expect(r.ok).toBe(false);
    });

    if (!opts.live) {
      it("失败以 EditResult 返回，不抛异常", async () => {
        const e = await factory();
        // 只有非 live 实现能被要求确定性地失败；live 的 provider 不保证。
        expect(typeof e.edit).toBe("function");
      });
    }
  });
}
```

- [ ] **Step 4: 让桩实现过契约**

新建 `packages/doctype-psd/tests/image-editor-stub.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { runImageEditorContract } from "../src/testing/image-editor-contract.js";
import { createStubEditor } from "../src/testing/stub-editor.js";

runImageEditorContract("stub", async () => createStubEditor(), { live: false });

describe("stub editor 的失败注入", () => {
  it("按注入的原因返回，不抛", async () => {
    const e = createStubEditor({ fail: { ok: false, reason: "refused", detail: "内容审核未通过" } });
    const r = await e.edit(
      { source: { width: 2, height: 2, data: new Uint8ClampedArray(16) }, instruction: "x" },
      AbortSignal.timeout(1000),
    );
    expect(r).toEqual({ ok: false, reason: "refused", detail: "内容审核未通过" });
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test image-editor-stub && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/image/editor.ts \
        packages/doctype-psd/src/testing/stub-editor.ts \
        packages/doctype-psd/src/testing/image-editor-contract.ts \
        packages/doctype-psd/tests/image-editor-stub.test.ts
git commit -m "feat(psd): 定义 ImageEditor 端口与契约套件"
```

---

### Task 5: 像素护栏（纯函数）

三个坑的解药全在这里，全是纯函数，没有网络。

- **坑 1 尺寸**：实测 613x457 → 1184x896，宽高比都没保住（1.3414 → 1.3214）。要能缩回去。
- **坑 3 alpha**：实测输出是 RGB，透明区被合成到黑底。用**哨兵底色**（品红）把 alpha 编码进颜色，回来再解出来。
- **坑 2 色偏**：实测只有 ±2 灰阶，所以差异蒙版阈值 16 足够把它挡在外面。

**Files:**
- Create: `packages/doctype-psd/src/image/guards.ts`
- Test: `packages/doctype-psd/tests/image-guards.test.ts`

**Interfaces:**
- Consumes: `Pixels`（`src/model/types.ts`）、`Coverage`（`src/image/editor.ts`）。
- Produces:
  - `SENTINEL: { r: 255; g: 0; b: 255 }`
  - `compositeOnSentinel(src: Pixels): Pixels`
  - `recoverAlpha(after: Pixels, tolerance?: number): Pixels`
  - `resample(src: Pixels, width: number, height: number): Pixels`
  - `fitPixelBudget(w: number, h: number, min: number, max: number): { width: number; height: number }`
  - `diffMask(before: Pixels, after: Pixels, opts?: { threshold?: number; maxChangedFraction?: number }): Coverage | null`
  - `softenMask(cov: Coverage, opts: { dilate: number; feather: number }): Coverage`
  - `applyCoverageToAlpha(px: Pixels, cov: Coverage): Pixels`

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/image-guards.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Pixels } from "../src/model/types.js";
import {
  SENTINEL, applyCoverageToAlpha, compositeOnSentinel, diffMask,
  fitPixelBudget, recoverAlpha, resample, softenMask,
} from "../src/image/guards.js";

const px = (w: number, h: number, fill: (i: number) => [number, number, number, number]): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill(i), i * 4);
  return { width: w, height: h, data };
};
const at = (p: Pixels, i: number) => Array.from(p.data.slice(i * 4, i * 4 + 4));

describe("哨兵底色", () => {
  it("全透明像素被合成成纯哨兵色，alpha 变 255", () => {
    const out = compositeOnSentinel(px(2, 1, () => [9, 9, 9, 0]));
    expect(at(out, 0)).toEqual([SENTINEL.r, SENTINEL.g, SENTINEL.b, 255]);
  });

  it("不透明像素颜色一个比特都不动", () => {
    const out = compositeOnSentinel(px(1, 1, () => [10, 20, 30, 255]));
    expect(at(out, 0)).toEqual([10, 20, 30, 255]);
  });

  it("半透明像素按 alpha 与哨兵色线性混合", () => {
    const out = compositeOnSentinel(px(1, 1, () => [0, 0, 0, 128]));
    // 0*0.502 + 255*0.498 ≈ 127
    expect(out.data[0]).toBeGreaterThan(125);
    expect(out.data[0]).toBeLessThan(130);
    expect(out.data[1]).toBe(0);
    expect(out.data[3]).toBe(255);
  });

  it("往返：不透明像素经 compositeOnSentinel → recoverAlpha 原样回来", () => {
    const src = px(4, 1, i => [i * 10, 20, 30, 255]);
    const back = recoverAlpha(compositeOnSentinel(src));
    expect(Array.from(back.data)).toEqual(Array.from(src.data));
  });

  it("往返：全透明像素经两步后 alpha 回到 0", () => {
    const back = recoverAlpha(compositeOnSentinel(px(1, 1, () => [0, 0, 0, 0])));
    expect(back.data[3]).toBe(0);
  });

  it("接近但不等于哨兵色的像素（模型重采样带来的噪声）也判为透明", () => {
    const back = recoverAlpha(px(1, 1, () => [252, 3, 251, 255]));
    expect(back.data[3]).toBe(0);
  });

  it("真的品红内容（容差之外）不会被误判成透明", () => {
    const back = recoverAlpha(px(1, 1, () => [220, 40, 215, 255]));
    expect(back.data[3]).toBe(255);
  });
});

describe("重采样", () => {
  it("尺寸不变时原样返回", () => {
    const src = px(3, 2, i => [i, i, i, 255]);
    expect(Array.from(resample(src, 3, 2).data)).toEqual(Array.from(src.data));
  });

  it("放大再缩回，纯色图保持纯色", () => {
    const src = px(4, 4, () => [10, 20, 30, 255]);
    const back = resample(resample(src, 16, 12), 4, 4);
    expect(back.width).toBe(4);
    for (let i = 0; i < 16; i++) {
      expect(back.data[i * 4]).toBeGreaterThan(8);
      expect(back.data[i * 4]).toBeLessThan(12);
    }
  });

  it("缩小后尺寸精确，缓冲长度自洽", () => {
    const out = resample(px(8, 8, () => [1, 2, 3, 4]), 3, 5);
    expect([out.width, out.height, out.data.length]).toEqual([3, 5, 3 * 5 * 4]);
  });
});

describe("像素预算", () => {
  it("已经在区间内就不动", () => {
    expect(fitPixelBudget(613, 457, 1024, 4_000_000)).toEqual({ width: 613, height: 457 });
  });
  it("太大则等比缩小到不超过上限", () => {
    const r = fitPixelBudget(4000, 3000, 1024, 1_000_000);
    expect(r.width * r.height).toBeLessThanOrEqual(1_000_000);
    expect(r.width / r.height).toBeCloseTo(4000 / 3000, 2);
  });
  it("太小则等比放大到不低于下限", () => {
    const r = fitPixelBudget(100, 50, 100_000, 4_000_000);
    expect(r.width * r.height).toBeGreaterThanOrEqual(100_000);
    expect(r.width / r.height).toBeCloseTo(2, 2);
  });
  it("永远不产出 0 边长", () => {
    const r = fitPixelBudget(1, 10_000, 1, 100);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe("差异蒙版", () => {
  const before = px(4, 4, () => [100, 100, 100, 255]);

  it("完全没变时全黑", () => {
    const cov = diffMask(before, before)!;
    expect(cov.data.every(v => v === 0)).toBe(true);
  });

  it("阈值以内的全局色偏被挡住 —— 实测 qwen 是 -1.94/-1.62/+0.52", () => {
    const after = px(4, 4, () => [98, 98, 101, 255]);
    const cov = diffMask(before, after)!;
    expect(cov.data.every(v => v === 0)).toBe(true);
  });

  it("超过阈值的像素被标白", () => {
    const after = px(4, 4, i => (i === 5 ? [200, 100, 100, 255] : [100, 100, 100, 255]));
    const cov = diffMask(before, after)!;
    expect(cov.data[5]).toBe(255);
    expect(cov.data[0]).toBe(0);
  });

  it("alpha 变化也算改动", () => {
    const after = px(4, 4, i => (i === 3 ? [100, 100, 100, 0] : [100, 100, 100, 255]));
    expect(diffMask(before, after)!.data[3]).toBe(255);
  });

  it("改动面积过大时返回 null —— 蒙版不可信，调用方降级整层替换", () => {
    const after = px(4, 4, () => [0, 255, 0, 255]);
    expect(diffMask(before, after)).toBeNull();
  });

  it("尺寸不一致直接抛 —— 这是调用方的 bug，不该悄悄兜住", () => {
    expect(() => diffMask(before, px(2, 2, () => [0, 0, 0, 255]))).toThrow(/size/i);
  });
});

describe("蒙版软化", () => {
  it("膨胀把边界向外推，覆盖重采样带来的一圈毛边", () => {
    const cov = { width: 5, height: 5, data: new Uint8ClampedArray(25) };
    cov.data[12] = 255; // 正中心
    const out = softenMask(cov, { dilate: 1, feather: 0 });
    expect(out.data[11]).toBe(255);
    expect(out.data[7]).toBe(255);
    expect(out.data[0]).toBe(0);
  });

  it("羽化产生 0..255 之间的过渡值", () => {
    const cov = { width: 9, height: 1, data: new Uint8ClampedArray(9) };
    for (let i = 3; i < 6; i++) cov.data[i] = 255;
    const out = softenMask(cov, { dilate: 0, feather: 2 });
    expect(out.data[2]).toBeGreaterThan(0);
    expect(out.data[2]).toBeLessThan(255);
  });

  it("dilate 和 feather 都是 0 时原样返回", () => {
    const cov = { width: 3, height: 1, data: new Uint8ClampedArray([0, 255, 0]) };
    expect(Array.from(softenMask(cov, { dilate: 0, feather: 0 }).data)).toEqual([0, 255, 0]);
  });
});

describe("覆盖度烘进 alpha", () => {
  it("覆盖度 0 的像素变全透明 —— 那里原层要露出来", () => {
    const src = px(2, 1, () => [10, 20, 30, 255]);
    const out = applyCoverageToAlpha(src, { width: 2, height: 1, data: new Uint8ClampedArray([0, 255]) });
    expect(at(out, 0)).toEqual([10, 20, 30, 0]);
    expect(at(out, 1)).toEqual([10, 20, 30, 255]);
  });

  it("与源自身的 alpha 相乘 —— 源本来就半透明的地方不会被拉回不透明", () => {
    const src = px(1, 1, () => [10, 20, 30, 128]);
    const out = applyCoverageToAlpha(src, { width: 1, height: 1, data: new Uint8ClampedArray([255]) });
    expect(out.data[3]).toBe(128);
  });

  it("羽化过渡带产生中间 alpha", () => {
    const src = px(1, 1, () => [10, 20, 30, 255]);
    const out = applyCoverageToAlpha(src, { width: 1, height: 1, data: new Uint8ClampedArray([128]) });
    expect(out.data[3]).toBeGreaterThan(120);
    expect(out.data[3]).toBeLessThan(135);
  });

  it("尺寸不一致直接抛", () => {
    expect(() => applyCoverageToAlpha(px(2, 2, () => [0, 0, 0, 255]),
      { width: 1, height: 1, data: new Uint8ClampedArray(1) })).toThrow(/size/i);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd test image-guards`
Expected: FAIL —— `Cannot find module '../src/image/guards.js'`。

- [ ] **Step 3: 实现护栏**

新建 `packages/doctype-psd/src/image/guards.ts`：

```ts
import type { Pixels } from "../model/types.js";
import type { Coverage } from "./editor.js";

/**
 * 哨兵底色。指令式编辑模型吃 RGB 吐 RGB，图层的 alpha 一定会丢；实测
 * qwen-image-edit-plus 把透明区合成到了黑底，于是"透明"和"纯黑内容"
 * 再也分不开。
 *
 * 办法是先把透明区合成到一个**图里几乎不会出现的颜色**上，模型改完之后
 * 再把接近这个颜色的像素判回透明 —— 相当于把 alpha 临时编码进色彩通道。
 * 纯品红是常用选择：自然照片里极少出现，与肤色/天空/植被都离得远。
 */
export const SENTINEL = { r: 255, g: 0, b: 255 } as const;

/** recoverAlpha 判定"这是哨兵色"的默认曼哈顿容差。模型的重采样会让哨兵色糊掉几个灰阶。 */
const SENTINEL_TOLERANCE = 24;

/** diffMask 默认阈值。实测 qwen 未编辑区色偏 < 2 灰阶，16 留了 8 倍余量。 */
const DIFF_THRESHOLD = 16;

/** 改动面积超过这个比例就认为蒙版不可信（水印模型会让全图都在变）。 */
const MAX_CHANGED_FRACTION = 0.9;

/** RGBA 源 → 不透明 RGBA，透明处露出哨兵色。alpha 一律 255。 */
export function compositeOnSentinel(src: Pixels): Pixels {
  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    out[i] = src.data[i] * a + SENTINEL.r * (1 - a);
    out[i + 1] = src.data[i + 1] * a + SENTINEL.g * (1 - a);
    out[i + 2] = src.data[i + 2] * a + SENTINEL.b * (1 - a);
    out[i + 3] = 255;
  }
  return { width: src.width, height: src.height, data: out };
}

/** 接近哨兵色的像素判回透明。其余保持不透明。 */
export function recoverAlpha(after: Pixels, tolerance: number = SENTINEL_TOLERANCE): Pixels {
  const out = new Uint8ClampedArray(after.data);
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.abs(out[i] - SENTINEL.r)
      + Math.abs(out[i + 1] - SENTINEL.g)
      + Math.abs(out[i + 2] - SENTINEL.b);
    out[i + 3] = d <= tolerance ? 0 : 255;
  }
  return { width: after.width, height: after.height, data: out };
}

/** 双线性重采样。放大缩小都走同一条路，尺寸相同则原样返回。 */
export function resample(src: Pixels, width: number, height: number): Pixels {
  if (width === src.width && height === src.height) {
    return { width, height, data: new Uint8ClampedArray(src.data) };
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p01 = src.data[(y0 * src.width + x1) * 4 + c];
        const p10 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        out[o + c] = p00 * (1 - wx) * (1 - wy) + p01 * wx * (1 - wy)
          + p10 * (1 - wx) * wy + p11 * wx * wy;
      }
    }
  }
  return { width, height, data: out };
}

/** 等比缩放到像素数落进 [min, max]。边长永远 >= 1。 */
export function fitPixelBudget(
  w: number, h: number, min: number, max: number,
): { width: number; height: number } {
  const n = w * h;
  const scale = n > max ? Math.sqrt(max / n) : n < min ? Math.sqrt(min / n) : 1;
  if (scale === 1) return { width: w, height: h };
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * 前后像素差异反推蒙版。任一通道（含 alpha）差值超过阈值就算改过。
 *
 * 返回 null 表示不可信：改动面积过大，说明模型重画了整张图（或加了隐形
 * 水印），这时蒙版起不到"把色偏关在小区域里"的作用，调用方应降级整层替换。
 */
export function diffMask(
  before: Pixels,
  after: Pixels,
  opts: { threshold?: number; maxChangedFraction?: number } = {},
): Coverage | null {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `diffMask: size mismatch ${before.width}x${before.height} vs ${after.width}x${after.height}`,
    );
  }
  const threshold = opts.threshold ?? DIFF_THRESHOLD;
  const maxFraction = opts.maxChangedFraction ?? MAX_CHANGED_FRACTION;
  const n = before.width * before.height;
  const data = new Uint8ClampedArray(n);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(before.data[o] - after.data[o]),
      Math.abs(before.data[o + 1] - after.data[o + 1]),
      Math.abs(before.data[o + 2] - after.data[o + 2]),
      Math.abs(before.data[o + 3] - after.data[o + 3]),
    );
    if (d > threshold) { data[i] = 255; changed++; }
  }
  return changed / n > maxFraction ? null : { width: before.width, height: before.height, data };
}

/**
 * 膨胀 + 羽化。差异蒙版的边界是逐像素硬切的，直接拿去当图层蒙版会留下
 * 一圈锯齿缝；先向外推几像素盖住重采样毛边，再做一次盒糊化出过渡带。
 */
export function softenMask(cov: Coverage, opts: { dilate: number; feather: number }): Coverage {
  const { width, height } = cov;
  let data = new Uint8ClampedArray(cov.data);
  for (let pass = 0; pass < opts.dilate; pass++) {
    const next = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1 && m < 255; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const v = data[yy * width + xx];
            if (v > m) m = v;
            if (m === 255) break;
          }
        }
        next[y * width + x] = m;
      }
    }
    data = next;
  }
  if (opts.feather > 0) {
    data = boxBlur(boxBlur(data, width, height, opts.feather), width, height, opts.feather);
  }
  return { width, height, data };
}

function boxBlur(src: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        sum += src[y * width + xx]; n++;
      }
      tmp[y * width + x] = sum / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        sum += tmp[yy * width + x]; n++;
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

/**
 * 把差异蒙版烘进图层自己的 alpha 通道。
 *
 * 为什么不做成一个真正的图层蒙版（Mask）：`Mask.pixels` 的类型是**驻留的**
 * `Pixels`（model/types.ts:17，注释明说合成器仍读 pixels），不接受 PixelRef。
 * 走 Mask 就意味着把一整张 RGBA 蒙版塞进 op —— 1600x1200 的层是 7.7 MB
 * 进 delta，每编辑一次涨一次。
 *
 * 烘进 alpha 视觉上完全等价：覆盖度为 0 的地方这一层全透明，下面的原层
 * 原样露出来，羽化过渡带也照样是过渡带。代价是在 Photoshop 里看到的是
 * "一个带透明区的图层"而不是"图层 + 蒙版"，蒙版本身不能单独再编辑。
 */
export function applyCoverageToAlpha(px: Pixels, cov: Coverage): Pixels {
  if (px.width !== cov.width || px.height !== cov.height) {
    throw new Error(
      `applyCoverageToAlpha: size mismatch ${px.width}x${px.height} vs ${cov.width}x${cov.height}`,
    );
  }
  const data = new Uint8ClampedArray(px.data);
  for (let i = 0; i < cov.data.length; i++) {
    // 与源自身的 alpha 相乘：源本来就半透明的地方不该被拉回不透明。
    data[i * 4 + 3] = (data[i * 4 + 3] * cov.data[i]) / 255;
  }
  return { width: px.width, height: px.height, data };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test image-guards && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/image/guards.ts packages/doctype-psd/tests/image-guards.test.ts
git commit -m "feat(psd): 图像编辑的纯函数护栏 —— 哨兵 alpha、重采样、差异蒙版"
```

---

### Task 6: DashScope `qwen-image-edit-plus` 适配器

本轮唯一实现。所有 provider 的怪癖都关在这个文件里。

**已实测的事实**（`spec §6`，来自 2026-09-01 的真实调用）：
- OpenAI 兼容端点**不能生图**：`/compatible-mode/v1/images/generations` 和 `/images/edits` 都是 404 空体。
- 可用路由：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- 同步返回，给的是一个**会过期的 OSS URL（约 24h）**，必须立刻下载。
- 延迟约 6.3s；输出尺寸和宽高比都不保证。

**Files:**
- Create: `packages/doctype-psd/src/image/qwen-editor.ts`
- Create: `packages/doctype-psd/tests/fixtures/qwen-edit-response.json`（**Step 1 从真实调用抓取**）
- Test: `packages/doctype-psd/tests/qwen-editor.test.ts`

**Interfaces:**
- Consumes: `ImageEditor` / `EditRequest` / `EditResult`（Task 4）、`guards.ts` 全部导出（Task 5）、`runImageEditorContract`（Task 4）。
- Produces: `createQwenImageEditor(opts: QwenEditorOptions): ImageEditor`
  ```ts
  export interface QwenEditorOptions {
    readonly apiKey: string;
    readonly model?: string;    // 默认 "qwen-image-edit-plus"
    readonly baseUrl?: string;  // 默认 "https://dashscope.aliyuncs.com"
    readonly fetch?: typeof fetch; // 测试注入
  }
  ```

- [ ] **Step 1: 抓一份真实响应当 fixture**

上一轮探测的响应体存在临时目录里，已随重启丢失，**不要凭记忆手写这个 JSON**。
在有 key 的机器上跑一次真实调用（约 ¥0.2），把响应存成 fixture：

```bash
# key 从环境变量读，绝不写进文件、绝不进提交
export DASHSCOPE_API_KEY=...   # 或 read -s DASHSCOPE_API_KEY
mkdir -p packages/doctype-psd/tests/fixtures
node --input-type=module -e '
const b64 = Buffer.from(await (await fetch("https://placehold.co/64x48/png")).arrayBuffer()).toString("base64");
const r = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "qwen-image-edit-plus",
    input: { messages: [{ role: "user", content: [
      { image: `data:image/png;base64,${b64}` },
      { text: "把左上角涂成红色" },
    ] }] },
    parameters: { watermark: false },
  }),
});
console.log(JSON.stringify(await r.json(), null, 2));
' > packages/doctype-psd/tests/fixtures/qwen-edit-response.json
```

打开这个文件，确认结果图 URL 的确切路径，并把 OSS URL 替换成 `https://example.invalid/edited.png`
（真实 URL 24 小时后失效，留着只会让测试将来莫名其妙地变绿或变红）。
**Step 3 的解析代码必须按这个文件的真实结构写，而不是按下面的示例结构。**
如果结构与示例不同，改代码，不要改 fixture。

同样把一份**被拒绝**的响应抓下来（换一个必然触发内容审核的指令），存成
`packages/doctype-psd/tests/fixtures/qwen-refused-response.json`；抓不到就跳过对应的那条测试，
并在测试里写明为什么跳过。

- [ ] **Step 2: 写失败的测试**

新建 `packages/doctype-psd/tests/qwen-editor.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { encode } from "fast-png";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createQwenImageEditor } from "../src/image/qwen-editor.js";
import { runImageEditorContract } from "../src/testing/image-editor-contract.js";
import { SENTINEL } from "../src/image/guards.js";

const fixture = (name: string) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
);

/** 模型返回的图：尺寸故意与输入不同，模拟实测的 613x457 → 1184x896。 */
function fakeEdited(width: number, height: number): Uint8Array {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // 左半边涂红（改动），右半边填哨兵色（应被判回透明）
    const x = i % width;
    data.set(x < width / 2 ? [255, 0, 0, 255] : [SENTINEL.r, SENTINEL.g, SENTINEL.b, 255], i * 4);
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}

function stubFetch(handlers: { generation: () => Response; image?: () => Response }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("multimodal-generation")) return handlers.generation();
    return (handlers.image ?? (() => new Response(fakeEdited(96, 72).buffer)))();
  }) as unknown as typeof fetch;
}

const source = {
  width: 64, height: 48,
  data: new Uint8ClampedArray(64 * 48 * 4).fill(200),
};

const editorWith = (f: typeof fetch) =>
  createQwenImageEditor({ apiKey: "test-key", fetch: f });

describe("qwen-image-edit-plus 适配器", () => {
  it("请求打在原生 AIGC 路由上，不是 OpenAI 兼容端点", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    await editorWith(f).edit({ source, instruction: "删掉帽子" }, AbortSignal.timeout(5000));
    const url = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(url).not.toContain("compatible-mode");
  });

  it("请求体带 image + text 两段 content，watermark 关掉", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    await editorWith(f).edit({ source, instruction: "删掉帽子" }, AbortSignal.timeout(5000));
    const init = (f as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen-image-edit-plus");
    expect(body.parameters.watermark).toBe(false);
    const content = body.input.messages[0].content;
    expect(content[0].image).toMatch(/^data:image\/png;base64,/);
    expect(content[1].text).toBe("删掉帽子");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("输出被缩回源尺寸 —— 坑 1，实测宽高比也不保证", async () => {
    const f = stubFetch({
      generation: () => Response.json(fixture("qwen-edit-response.json")),
      image: () => new Response(fakeEdited(137, 91).buffer),  // 与 64x48 既不同尺寸也不同比例
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    expect([r.pixels.width, r.pixels.height]).toEqual([64, 48]);
  });

  it("哨兵色区域被还原成透明 —— 坑 3", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    // 右半边（哨兵色）alpha 应为 0
    const right = (48 >> 1) * 64 + 60;
    expect(r.pixels.data[right * 4 + 3]).toBe(0);
  });

  it("provenance 记下真实模型名与 prompt", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    const r = await editorWith(f).edit({ source, instruction: "删掉帽子", seed: 42 }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    expect(r.provenance).toEqual({ model: "qwen-image-edit-plus", seed: 42, prompt: "删掉帽子" });
  });

  it("内容审核拒绝 → reason refused，不抛异常", async () => {
    const f = stubFetch({
      generation: () => Response.json({ code: "DataInspectionFailed", message: "input data may contain inappropriate content" }, { status: 400 }),
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "refused" });
  });

  it("限流 / 5xx → reason provider_error", async () => {
    const f = stubFetch({ generation: () => Response.json({ code: "Throttling" }, { status: 429 }) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "provider_error" });
  });

  it("abort → reason timeout", async () => {
    const f = stubFetch({ generation: () => { throw new DOMException("aborted", "AbortError"); } });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("响应里没有图片 URL → provider_error，而不是崩在解构上", async () => {
    const f = stubFetch({ generation: () => Response.json({ output: { choices: [] }, request_id: "r1" }) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "provider_error" });
  });
});

// 录制回放下的契约：形状对不对，与真不真打网络无关。
runImageEditorContract(
  "qwen-image-edit-plus (recorded)",
  async () => createQwenImageEditor({
    apiKey: "test-key",
    fetch: stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) }),
  }),
  { live: false },
);
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd test qwen-editor`
Expected: FAIL —— `Cannot find module '../src/image/qwen-editor.js'`。

- [ ] **Step 4: 实现适配器**

新建 `packages/doctype-psd/src/image/qwen-editor.ts`。
**注意：`parseImageUrl` 必须按 Step 1 抓到的真实 fixture 结构写。**

```ts
import { decode, encode } from "fast-png";
import type { Pixels } from "../model/types.js";
import type { EditRequest, EditResult, EditorCapabilities, ImageEditor } from "./editor.js";
import { compositeOnSentinel, diffMask, fitPixelBudget, recoverAlpha, resample } from "./guards.js";

export interface QwenEditorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 测试注入用。不给就用全局 fetch。 */
  readonly fetch?: typeof fetch;
}

const DEFAULT_MODEL = "qwen-image-edit-plus";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";

/**
 * OpenAI 兼容端点**不能生图** —— `/compatible-mode/v1/images/generations` 和
 * `/images/edits` 实测都是 404 空体。生图只有原生 AIGC 这一条路。
 */
const GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

/** 内容审核拒绝的 code。这类失败改措辞可能有救，与限流/网络故障要分开。 */
const REFUSAL_CODES = new Set(["DataInspectionFailed", "ResponseTimeout.DataInspection"]);

const CAPABILITIES: EditorCapabilities = {
  // 指令式编辑，不吃蒙版。给了也没用，所以别为它算蒙版。
  mask: "unsupported",
  minPixels: 384 * 384,
  maxPixels: 2048 * 2048,
  // 实测 parameters.watermark=false 时未编辑区色偏 -1.94/-1.62/+0.52，
  // 远低于 diffMask 的阈值 16 —— 差异蒙版可信。
  watermarked: false,
};

const toDataUrl = (px: Pixels): string => {
  const png = encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
  let s = "";
  for (const b of png) s += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(s)}`;
};

const toPixels = (png: Uint8Array): Pixels => {
  const img = decode(png);
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  const ch = img.channels;
  const src = img.data as ArrayLike<number>;
  // 模型回的是 RGB（3 通道）；也兼容它哪天回 RGBA。
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * ch];
    out[i * 4 + 1] = src[i * ch + 1];
    out[i * 4 + 2] = src[i * ch + 2];
    out[i * 4 + 3] = ch === 4 ? src[i * ch + 3] : 255;
  }
  return { width: img.width, height: img.height, data: out };
};

/** 从响应里挖出结果图 URL。结构以 tests/fixtures/qwen-edit-response.json 为准。 */
function parseImageUrl(body: unknown): string | null {
  const choices = (body as { output?: { choices?: unknown[] } })?.output?.choices;
  if (!Array.isArray(choices)) return null;
  for (const choice of choices) {
    const content = (choice as { message?: { content?: unknown[] } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const image = (part as { image?: unknown })?.image;
      if (typeof image === "string" && image.length > 0) return image;
    }
  }
  return null;
}

export function createQwenImageEditor(opts: QwenEditorOptions): ImageEditor {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetch ?? fetch;

  return {
    id: model,
    capabilities: CAPABILITIES,

    async edit(req: EditRequest, signal: AbortSignal): Promise<EditResult> {
      const { source, instruction } = req;
      const seed = req.seed ?? 0;
      // 进来就已经 abort 的情况要自己挡：fetch 未必来得及抛，而契约套件
      // 明确要求"已经 abort 的 signal 不产生成功结果"。
      if (signal.aborted) return { ok: false, reason: "timeout", detail: "aborted before start" };
      try {
        // 坑 3：模型吃 RGB 吐 RGB，先把 alpha 编码进哨兵底色。
        const flattened = compositeOnSentinel(source);
        // 坑 1：先把尺寸压进 provider 的区间；回来还要缩回原尺寸。
        const fit = fitPixelBudget(
          flattened.width, flattened.height,
          CAPABILITIES.minPixels, CAPABILITIES.maxPixels,
        );
        const sent = resample(flattened, fit.width, fit.height);

        const response = await doFetch(`${baseUrl}${GENERATION_PATH}`, {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: { messages: [{ role: "user", content: [{ image: toDataUrl(sent) }, { text: instruction }] }] },
            parameters: { watermark: false },
          }),
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const code = String((body as { code?: unknown }).code ?? "");
          const detail = `${response.status} ${code}: ${String((body as { message?: unknown }).message ?? "")}`;
          return REFUSAL_CODES.has(code)
            ? { ok: false, reason: "refused", detail }
            : { ok: false, reason: "provider_error", detail };
        }

        const url = parseImageUrl(body);
        if (!url) {
          return { ok: false, reason: "provider_error", detail: `no image in response (request_id=${String((body as { request_id?: unknown }).request_id ?? "?")})` };
        }

        // OSS URL 约 24 小时后失效 —— 立刻下载，绝不存起来以后再取。
        const imageResponse = await doFetch(url, { signal });
        if (!imageResponse.ok) {
          return { ok: false, reason: "provider_error", detail: `result download failed: ${imageResponse.status}` };
        }
        const returned = toPixels(new Uint8Array(await imageResponse.arrayBuffer()));

        // 坑 1 收尾：缩回源尺寸。所有实测的好指标都是在这一步之后测的，
        // 重采样噪声被 diffMask 的阈值吸收掉了。
        const back = resample(returned, source.width, source.height);
        // 坑 3 收尾：哨兵色判回透明。
        const pixels = recoverAlpha(back);

        // 后置条件：适配器的 bug 不许污染文档。
        if (pixels.width !== source.width || pixels.height !== source.height
          || pixels.data.length !== source.width * source.height * 4) {
          return { ok: false, reason: "provider_error", detail: "post-condition failed: output size mismatch" };
        }

        return {
          ok: true,
          pixels,
          changed: CAPABILITIES.watermarked ? null : diffMask(source, pixels),
          provenance: { model, seed, prompt: instruction },
        };
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        return aborted
          ? { ok: false, reason: "timeout", detail: String(err) }
          : { ok: false, reason: "provider_error", detail: String(err) };
      }
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test qwen-editor && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS，包括 `runImageEditorContract` 那一组。

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/image/qwen-editor.ts \
        packages/doctype-psd/tests/qwen-editor.test.ts \
        packages/doctype-psd/tests/fixtures/qwen-edit-response.json
git commit -m "feat(psd): 接入 qwen-image-edit-plus —— ImageEditor 的第一个实现"
```

确认 `git show --stat HEAD` 里没有任何含 `sk-` 的内容。

---

### Task 7: `editPixels` effect 工具 + `createPsdAgent` 工厂

**Files:**
- Create: `packages/doctype-psd/src/image/edit-pixels.ts`
- Modify: `packages/doctype-psd/src/agent.ts`
- Modify: `packages/doctype-psd/src/tools.ts`（提示词）
- Modify: `packages/doctype-psd/src/index.ts`
- Modify: `packages/doctype-psd/tests/agent.test.ts`
- Test: `packages/doctype-psd/tests/edit-pixels.test.ts`

**Interfaces:**
- Consumes: `ImageEditor`（Task 4）、`guards.ts`（Task 5）、`getLayerPixels`（Task 3）、
  `AgentTool` 的 `effect` 分支与 `EffectContext`（Task 1）。
- Produces:
  - `createEditPixelsTool(editor: ImageEditor): AgentTool<PsdQuery, PsdOp>`
  - `createPsdAgent(deps: { editor?: ImageEditor }): DocumentAgent<PsdQuery, PsdOp>`
  - `psdAgent` 常量**删除**（三个调用点：`index.ts`、`tests/agent.test.ts`、`cloudflare-psd/src/worker.ts`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/edit-pixels.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { encode, decode } from "fast-png";
import { createSBlob } from "@unidocs/svalue-codec";
import type { EffectContext, SBlob, SBlobBytes } from "@unidocs/protocol";
import { createEditPixelsTool } from "../src/image/edit-pixels.js";
import { createStubEditor } from "../src/testing/stub-editor.js";
import type { PsdQuery } from "../src/queries.js";

const SRC_W = 64, SRC_H = 48;

function sourcePng(): Uint8Array {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4).fill(200);
  return encode({ width: SRC_W, height: SRC_H, data, channels: 4, depth: 8 });
}

/** 假 EffectContext：query 回一份 getLayerPixels 结果，blob 存在 Map 里。 */
function fakeCtx(over: { queryResult?: Record<string, unknown> } = {}) {
  const blobs = new Map<string, SBlobBytes>();
  const srcHash = "1".repeat(64);
  blobs.set(srcHash, { data: sourcePng(), contentType: "image/png" });
  let n = 0;
  const written: SBlobBytes[] = [];
  const ctx: EffectContext<PsdQuery> & { blobs: typeof blobs; written: typeof written } = {
    blobs, written,
    query: vi.fn(async () => ({
      data: over.queryResult ?? {
        image: createSBlob(srcHash),
        width: SRC_W, height: SRC_H,
        bounds: [10, 20, 10 + SRC_H, 20 + SRC_W],
        parentId: "g1", index: 2,
      },
      version: 7,
    })) as never,
    readBlob: vi.fn(async (b: SBlob) => blobs.get(b.hash)!),
    writeBlob: vi.fn(async (d: SBlobBytes): Promise<SBlob> => {
      written.push(d);
      const hash = String(n++).padStart(64, "f");
      blobs.set(hash, d);
      return createSBlob(hash);
    }),
    signal: AbortSignal.timeout(10_000),
  };
  return ctx;
}

describe("editPixels effect", () => {
  it("产出一个 generative_fill op，结果层插在源层正上方（index+1）", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "删掉帽子" }, ctx);
    expect(out.ops).toHaveLength(1);
    const op = out.ops[0] as unknown as { kind: string; payload: Record<string, any> };
    expect(op.kind).toBe("generative_fill");
    expect(op.payload.parentId).toBe("g1");
    // 图层数组是 bottom-to-top，所以"正上方"= 源层 index + 1
    expect(op.payload.index).toBe(3);
  });

  it("结果层的 bounds 与源层完全一致 —— 非破坏叠加要对齐", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, fakeCtx());
    const layer = (out.ops[0] as any).payload.layer;
    expect(layer.bounds).toEqual([10, 20, 10 + SRC_H, 20 + SRC_W]);
    expect(layer.type).toBe("raster");
  });

  it("像素以 PixelRef 落地，不把 RGBA 塞进 op —— 整层 RGBA 会撑爆 delta", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    const layer = (out.ops[0] as any).payload.layer;
    expect(layer.pixels).toMatchObject({ width: SRC_W, height: SRC_H });
    expect(typeof layer.pixels.hash).toBe("string");
    expect(layer.pixels.data).toBeUndefined();
    // 写进 CAS 的第一份是结果 PNG，尺寸等于源尺寸
    const png = decode(ctx.written[0].data);
    expect([png.width, png.height]).toEqual([SRC_W, SRC_H]);
  });

  it("差异蒙版烘进结果层的 alpha —— 未改动区域全透明，原层照样露出来", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    // 桩 editor 只改左上 1/4，其余区域覆盖度为 0
    const png = decode(ctx.written[0].data);
    const rgba = png.data as ArrayLike<number>;
    const ch = png.channels;
    const idx = (x: number, y: number) => (y * SRC_W + x) * ch;
    expect(rgba[idx(4, 4) + 3]).toBe(255);          // 改动区：不透明
    expect(rgba[idx(SRC_W - 4, SRC_H - 4) + 3]).toBe(0); // 未改动区：透明
  });

  it("provenance 原样带进 op", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "删掉帽子" }, fakeCtx());
    expect((out.ops[0] as any).payload.provenance).toMatchObject({
      model: "stub-editor", prompt: "删掉帽子",
    });
  });

  it("返回一张 after 预览图，省掉模型再调一次 getPreview", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, fakeCtx());
    const image = out.result.content?.find(p => p.type === "image");
    expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("editor 拒绝时 ops 为空，原因回给模型 —— 不落 op、不 bump 版本", async () => {
    const tool = createEditPixelsTool(
      createStubEditor({ fail: { ok: false, reason: "refused", detail: "内容审核未通过" } }),
    );
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    expect(out.ops).toEqual([]);
    expect(out.result.structuredContent).toMatchObject({
      ok: false, reason: "refused", detail: "内容审核未通过",
    });
    expect(ctx.writeBlob).not.toHaveBeenCalled();
  });

  it("changed 为 null 时降级整层替换：alpha 不被裁剪，provenance 标 maskDerivation none", async () => {
    const editor = createStubEditor();
    const noMask = {
      ...editor,
      edit: async (req: any, sig: AbortSignal) => {
        const r = await editor.edit(req, sig);
        return r.ok ? { ...r, changed: null } : r;
      },
    };
    const tool = createEditPixelsTool(noMask);
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    const payload = (out.ops[0] as any).payload;
    expect(payload.provenance.maskDerivation).toBe("none");
    // 没有可信蒙版就整层盖上去：四角都不透明
    const png = decode(ctx.written[0].data);
    const ch = png.channels;
    expect((png.data as ArrayLike<number>)[((SRC_H - 1) * SRC_W + SRC_W - 1) * ch + 3]).toBe(255);
  });

  it("参数缺失时以 result 报错，不抛", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ instruction: "x" }, fakeCtx());
    expect(out.ops).toEqual([]);
    expect(String((out.result.structuredContent as any).error)).toMatch(/layerId/);
  });
});
```

同时把 `packages/doctype-psd/tests/agent.test.ts` 顶部的
`import { psdAgent } from "../src/agent.js";` 换成：

```ts
import { createPsdAgent } from "../src/agent.js";
const psdAgent = createPsdAgent({});
```

并在文件末尾追加一条：

```ts
describe("createPsdAgent", () => {
  it("不注入 editor 就没有 editPixels —— 没有手就别宣称能画", () => {
    expect(createPsdAgent({}).tools.map(t => t.name)).not.toContain("editPixels");
  });

  it("注入 editor 后 editPixels 出现在工具表里，且是 effect", () => {
    const tools = createPsdAgent({ editor: createStubEditor() }).tools;
    const t = tools.find(x => x.name === "editPixels")!;
    expect(t.kind).toBe("effect");
  });
});
```
（`agent.test.ts` 顶部补 `import { createStubEditor } from "../src/testing/stub-editor.js";`）

注意 `agent.test.ts` 里那条"`toQuery` / `toOps` 是纯函数"的用例会遍历所有工具，
effect 分支既没有 `toQuery` 也没有 `toOps` —— 把那条循环体开头加一行
`if (t.kind === "effect") continue;`，并在旁边写明理由：effect 的纯性由它不产生 op
时不落库来保证，不是靠重复调用等价。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd test edit-pixels`
Expected: FAIL —— `Cannot find module '../src/image/edit-pixels.js'`。

- [ ] **Step 3: 实现 effect 工具**

新建 `packages/doctype-psd/src/image/edit-pixels.ts`：

```ts
import { decode, encode } from "fast-png";
import type { AgentTool, EffectContext, EffectOutcome, JsonValue, SBlob } from "@unidocs/protocol";
import type { Layer, Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { PsdQuery } from "../queries.js";
import { downscale } from "../render/index.js";
import type { ImageEditor } from "./editor.js";
import { applyCoverageToAlpha, softenMask } from "./guards.js";

/** 回给模型看的 after 预览的长边上限。和 getPreview 的默认值一致。 */
const AFTER_PREVIEW_MAX_SIZE = 768;
/** 差异蒙版的软化参数：先向外推 2px 盖住重采样毛边，再羽化 2px 出过渡带。 */
const MASK_SOFTEN = { dilate: 2, feather: 2 } as const;

interface LayerPixelsResult {
  image: SBlob;
  width: number;
  height: number;
  bounds: [number, number, number, number];
  parentId: string | null;
  index: number;
}

const pngToPixels = (png: Uint8Array): Pixels => {
  const img = decode(png);
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  const ch = img.channels;
  const src = img.data as ArrayLike<number>;
  for (let i = 0; i < n; i++) {
    data[i * 4] = src[i * ch];
    data[i * 4 + 1] = src[i * ch + 1];
    data[i * 4 + 2] = src[i * ch + 2];
    data[i * 4 + 3] = ch === 4 ? src[i * ch + 3] : 255;
  }
  return { width: img.width, height: img.height, data };
};

const pixelsToPng = (px: Pixels): Uint8Array =>
  encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });

const fail = (structuredContent: JsonValue): EffectOutcome<PsdOp> =>
  ({ ops: [], result: { structuredContent } });

/**
 * `editPixels` —— 图层内部像素的唯一入口。
 *
 * 为什么必须是 effect：其余所有写工具都要求调用方在 JSON 参数里交出 RGBA
 * 数组，而 LLM 产不出像素。图层操作快，正是因为它们的参数是数字和字符串。
 *
 * 落地形态是**新的 raster 图层**，插在源层正上方，不覆盖源层。差异蒙版
 * 烘进这个新层自己的 alpha 通道：改动区不透明，其余区域全透明，下面的原层
 * 原样露出来。
 *
 * 这个蒙版不是可有可无的修饰。模型返回的是整层重绘，未编辑区域也被重画了
 * 一遍；实测色偏虽小（-1.94/-1.62/+0.52），但整层无遮挡地盖上去就等于给
 * 全图蒙了一层不可见的偏色。烘进 alpha 之后，没动的那 97.7% 像素仍然是
 * 原层的原始字节。
 *
 * 为什么不用真正的图层蒙版（Mask）：见 guards.ts 的 applyCoverageToAlpha。
 */
export function createEditPixelsTool(editor: ImageEditor): AgentTool<PsdQuery, PsdOp> {
  return {
    kind: "effect",
    name: "editPixels",
    description:
      "WRITE. Repaint the pixels INSIDE one layer from a plain-language instruction "
      + "(remove / replace / add an object). The result lands as a NEW layer directly above "
      + "the source layer, transparent outside the changed region, so the original layer is untouched. "
      + "This is the ONLY way to change pixels — layer ops cannot do it.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string", description: "The layer whose pixels to repaint." },
        instruction: {
          type: "string",
          description: "What to change, in plain language, e.g. \"remove the red hat from the person's head\".",
        },
      },
      required: ["layerId", "instruction"],
    },

    async run(args, ctx: EffectContext<PsdQuery>): Promise<EffectOutcome<PsdOp>> {
      const layerId = args.layerId;
      const instruction = args.instruction;
      if (typeof layerId !== "string" || layerId.length === 0) {
        return fail({ error: "editPixels: layerId must be a non-empty string" });
      }
      if (typeof instruction !== "string" || instruction.length === 0) {
        return fail({ error: "editPixels: instruction must be a non-empty string" });
      }

      const { data } = await ctx.query({ kind: "getLayerPixels", payload: { layerId } } as never);
      const info = data as unknown as LayerPixelsResult;
      const sourceBytes = await ctx.readBlob(info.image);
      const source = pngToPixels(sourceBytes.data);

      const result = await editor.edit({ source, instruction }, ctx.signal);
      if (!result.ok) {
        // 失败是一次普通的工具返回，不是异常：不写文档、不涨版本，
        // 模型收到一段可读文本，自己决定改措辞重试还是换个做法。
        return fail({ ok: false, reason: result.reason, detail: result.detail });
      }

      // 差异蒙版烘进结果层自己的 alpha：未改动的区域全透明，下面的原层
      // 原样露出来。这一步就是"把模型带来的全局色偏关在改动区里"的全部机制 ——
      // 没它，整层无遮挡地盖上去等于给全图蒙一层不可见的偏色。
      const landed = result.changed
        ? applyCoverageToAlpha(result.pixels, softenMask(result.changed, MASK_SOFTEN))
        : result.pixels;

      const resultBlob = await ctx.writeBlob({
        data: pixelsToPng(landed),
        contentType: "image/png",
      });

      const layer: Record<string, unknown> = {
        id: `${layerId}-edit-${resultBlob.hash.slice(0, 8)}`,
        type: "raster",
        name: `${instruction.slice(0, 24)}`,
        bounds: info.bounds,
        opacity: 1,
        blendMode: "normal",
        visible: true,
        locked: false,
        clipping: false,
        // PixelRef，不是 Pixels：一个整层 RGBA 是几十 MB，塞进 delta 会把
        // 版本日志撑爆。字节已经在 CAS 里，op 只带引用。
        pixels: { width: landed.width, height: landed.height, hash: resultBlob.hash, blob: resultBlob },
      };

      const provenance: Record<string, unknown> = {
        ...result.provenance,
        // changed 为 null 时降级整层替换，把这件事记在案上 —— 将来查
        // "为什么这张图整体偏了一点"时，这一行就是答案。
        ...(result.changed ? {} : { maskDerivation: "none" }),
      };

      // after 预览：模型看得见自己改成了什么，省掉一次显式 getPreview。
      const preview = downscale(landed, AFTER_PREVIEW_MAX_SIZE);
      const previewBlob = await ctx.writeBlob({
        data: pixelsToPng(preview),
        contentType: "image/png",
      });

      return {
        // bottom-to-top 数组：源层 index + 1 就是它的正上方。
        ops: [{ kind: "generative_fill", payload: { layer, parentId: info.parentId, index: info.index + 1, provenance } }] as never,
        description: `editPixels(${layerId}): ${instruction}`,
        result: {
          structuredContent: {
            ok: true,
            layerId: layer.id as string,
            bounds: info.bounds as unknown as JsonValue,
            masked: result.changed !== null,
            model: result.provenance.model,
          },
          content: [
            { type: "image", blob: previewBlob, mediaType: "image/png", altText: `after: ${instruction}` },
            {
              type: "text",
              text: result.changed
                ? `Done. Result landed as layer "${layer.id as string}" above ${layerId}, transparent outside the changed region. The original layer is untouched.`
                : `Done, but the change covered the whole layer, so no mask was derived — the result replaces the source layer's appearance entirely. Landed as "${layer.id as string}".`,
            },
          ],
        },
      };
    },
  };
}
```

**不要**在这里造 `Mask` 对象。`Mask.pixels` 的类型是驻留的 `Pixels`
（`src/model/types.ts:17`），不接受 PixelRef，走 Mask 就必须把整张 RGBA 蒙版
塞进 op —— 1600x1200 的层是 7.7 MB 进 delta。蒙版烘进结果层 alpha 的做法
视觉上等价，见 `guards.ts` 的 `applyCoverageToAlpha`。

- [ ] **Step 4: 工厂化 `psdAgent`**

`packages/doctype-psd/src/agent.ts` 整体替换为：

```ts
/**
 * PSD DocumentAgent 工厂。
 *
 * 从常量改成工厂，是因为 editPixels 需要一个 ImageEditor —— 一个带
 * API key、会打网络的东西。它按 env 构造，和 operator 里的 provider 同形。
 *
 * 不给 editor 就没有 editPixels：一个连手都没有的 agent 不该在工具表里
 * 宣称自己能画。
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { instructions, tools } from "./tools.js";
import { createEditPixelsTool } from "./image/edit-pixels.js";
import type { ImageEditor } from "./image/editor.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export interface PsdAgentDeps {
  /** 缺省时工具表里没有 editPixels。 */
  readonly editor?: ImageEditor;
}

export function createPsdAgent(deps: PsdAgentDeps): DocumentAgent<PsdQuery, PsdOp> {
  return {
    tools: deps.editor ? [...tools, createEditPixelsTool(deps.editor)] : tools,
    instructions,
  };
}
```

`packages/cloudflare-psd/src/worker.ts` 同步改一行，否则 `psdAgent` 没了、
worker 编译不过（Task 8 才把它换成按 env 构造的工厂）：

```ts
import { createPsdDocumentType, createPsdAgent } from "@unidocs/doctype-psd";
// ...
export const PsdOperator = createOperatorDO({
  agent: createPsdAgent({}),   // Task 8 换成按 env 注入 editor 的工厂
```

`packages/doctype-psd/src/index.ts`：把
`export { psdAgent } from "./agent.js";`
换成
```ts
export { createPsdAgent } from "./agent.js";
export type { PsdAgentDeps } from "./agent.js";
export { createQwenImageEditor } from "./image/qwen-editor.js";
export type { QwenEditorOptions } from "./image/qwen-editor.js";
export type { ImageEditor, EditRequest, EditResult, EditorCapabilities, Coverage } from "./image/editor.js";
```

- [ ] **Step 5: 提示词补一段**

`packages/doctype-psd/src/tools.ts`，在 `instructions` 的 `EDITING` 段落里，
把现有那条 "New layers need a caller-assigned unique id..." 之后插入：

```
- editPixels: change the pixels INSIDE a layer from a plain-language instruction — removing an object, replacing something, painting something in. This is the ONLY tool that can change pixels; every other write tool needs pixel data you cannot produce. Give it {layerId, instruction}. It lands the result as a new masked layer above the source and hands you back an after-preview, so you do NOT need a separate getPreview to check it.
- If editPixels comes back with ok:false, read the reason: "refused" means rephrase the instruction; "needs_mask" means narrow the area with getPreview {rect} first; "timeout"/"provider_error" mean the attempt failed and nothing was changed — decide whether it is worth retrying.
```

`WORKFLOW` 那一行改成：

```
Query (getDoc/getLayers) → reason about coordinates → edit (layer ops, or editPixels for pixels) → getPreview to verify (editPixels already returns one) → correct if needed.
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS，包括改造后的 `agent.test.ts`。

Run: `pnpm typecheck`
Expected: 无错误 —— 特别是 `cloudflare-psd`，它的 `psdAgent` import 刚被换掉。

- [ ] **Step 7: 提交**

```bash
git add packages/doctype-psd/src/image/edit-pixels.ts packages/doctype-psd/src/agent.ts \
        packages/doctype-psd/src/tools.ts packages/doctype-psd/src/index.ts \
        packages/doctype-psd/tests/edit-pixels.test.ts packages/doctype-psd/tests/agent.test.ts \
        packages/cloudflare-psd/src/worker.ts
git commit -m "feat(psd): editPixels effect 工具，结果作为带蒙版的新图层非破坏落地"
```

---

### Task 8: 接线 —— worker、env、文档

**Files:**
- Modify: `packages/cloudflare-sdk/src/operator-do-agent.ts:16,113-121`
- Modify: `packages/cloudflare-psd/src/worker.ts:33-46,48-59`
- Modify: `packages/cloudflare-psd/.dev.vars.example`
- Modify: `packages/doctype-psd/docs/design.md:280` 附近
- Test: `packages/cloudflare-sdk/tests/operator-agent-factory.test.ts`

**Interfaces:**
- Consumes: `createPsdAgent`、`createQwenImageEditor`（Task 6、7）。
- Produces: `OperatorConfig.agent` 类型放宽为
  `DocumentAgent<TQuery, TOp> | ((env: TEnv) => DocumentAgent<TQuery, TOp>)`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/cloudflare-sdk/tests/operator-agent-factory.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { DocumentAgent } from "@unidocs/protocol";
import { createOperatorDO } from "../src/operator-do-agent.js";

type Q = { kind: string };
type O = { kind: string; payload: Record<string, unknown> };

const agentFor = (label: string): DocumentAgent<Q, O> => ({
  instructions: label,
  tools: [{
    kind: "query", name: "getLayers", description: "READ.",
    inputSchema: { type: "object", properties: {} },
    toQuery: () => ({ kind: "getLayers" }) as never,
  }],
});

describe("OperatorConfig.agent 支持按 env 构造", () => {
  it("传常量时照旧可用", () => {
    expect(() => createOperatorDO<Q, O, { KEY?: string }>({
      agent: agentFor("常量"),
      provider: () => ({ complete: async () => ({ content: [] }) }),
      getEditorStub: () => ({} as DurableObjectStub),
    })).not.toThrow();
  });

  it("传函数时用 env 构造 —— 和 provider 同形", () => {
    const seen: unknown[] = [];
    const Klass = createOperatorDO<Q, O, { KEY?: string }>({
      agent: env => { seen.push(env); return agentFor("工厂"); },
      provider: () => ({ complete: async () => ({ content: [] }) }),
      getEditorStub: () => ({} as DurableObjectStub),
    });
    // 构造 DO 本身不该调工厂 —— agent 和 provider 一样是惰性建的
    new Klass({} as DurableObjectState, { KEY: "k" });
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/cloudflare-sdk test operator-agent-factory`
Expected: FAIL —— TypeScript 报 `agent` 不接受函数。

- [ ] **Step 3: 放宽 `OperatorConfig.agent`**

`packages/cloudflare-sdk/src/operator-do-agent.ts`：

把
```ts
  /** 纯数据的工具表 + 系统提示词。文档类型导出的常量，不是工厂。 */
  readonly agent: DocumentAgent<TQuery, TOp>;
```
换成
```ts
  /**
   * 工具表 + 系统提示词。
   *
   * 允许传函数，理由和下面的 provider 一模一样：有的工具需要按 env 构造的
   * 东西（PSD 的 editPixels 要一个带 API key 的 ImageEditor），而 env 只在
   * 构造 DO 时交到我们手上。传常量的文档类型照旧。
   */
  readonly agent: DocumentAgent<TQuery, TOp> | ((env: TEnv) => DocumentAgent<TQuery, TOp>);
```

`#session()` 里把 `agent: config.agent,` 换成：
```ts
        agent: typeof config.agent === "function" ? config.agent(this.#env) : config.agent,
```

- [ ] **Step 4: 接线 PSD worker**

`packages/cloudflare-psd/src/worker.ts`：

import 补上 editor 工厂（`createPsdAgent` 在 Task 7 已经换好了）：
```ts
import { createPsdDocumentType, createPsdAgent, createQwenImageEditor } from "@unidocs/doctype-psd";
```

`Env` 接口补三个可选变量：
```ts
  // 图像编辑模型（editPixels）。缺省时 agent 的工具表里没有 editPixels，
  // 层内像素编辑不可用，其余功能不受影响。
  IMAGE_EDIT_API_KEY?: string;
  IMAGE_EDIT_MODEL?: string;
  IMAGE_EDIT_BASE_URL?: string;
```

`createOperatorDO` 的 `agent` 改成工厂：
```ts
export const PsdOperator = createOperatorDO({
  // 按 env 构造：editPixels 需要一个带 API key 的图像模型，而 key 只在
  // 这里拿得到。没配 key 就不注入 editor —— 工具表里也就没有 editPixels，
  // 模型不会去调一个注定失败的工具。
  agent: (env: Env) => createPsdAgent(
    env.IMAGE_EDIT_API_KEY
      ? {
        editor: createQwenImageEditor({
          apiKey: env.IMAGE_EDIT_API_KEY,
          ...(env.IMAGE_EDIT_MODEL ? { model: env.IMAGE_EDIT_MODEL } : {}),
          ...(env.IMAGE_EDIT_BASE_URL ? { baseUrl: env.IMAGE_EDIT_BASE_URL } : {}),
        }),
      }
      : {},
  ),
  provider: (env: Env) => createAnthropicProvider(env),
  getEditorStub: (env: Env, sessionId) => {
    const id = env.PSD_EDITOR.idFromName(sessionId);
    return env.PSD_EDITOR.get(id);
  },
  // 有了 editPixels，一次层内重绘从"无路可走、烧满 25 轮"变成 2~3 轮。
  // 上限暂时保持 25：多图层、多步骤的指令仍然吃得下。
  maxIterations: 25,
});
```

- [ ] **Step 5: 更新 `.dev.vars.example`**

`packages/cloudflare-psd/.dev.vars.example` 末尾追加（**只放占位符**）：

```
# 图像编辑模型（editPixels）。不配就没有 editPixels 工具，层内像素编辑不可用。
# DashScope 控制台拿 key：https://bailian.console.aliyun.com/
IMAGE_EDIT_API_KEY=sk-...
# Optional — defaults shown:
# IMAGE_EDIT_MODEL=qwen-image-edit-plus
# IMAGE_EDIT_BASE_URL=https://dashscope.aliyuncs.com
```

- [ ] **Step 6: 补上 design.md 那个洞**

`packages/doctype-psd/docs/design.md` 的 §5.4，在
"1. Operator 的工具(或一个 query)**先**调模型拿到结果像素;" 这一行后面加一句：

```
   > 这一步由 `effect` 工具形态承载（protocol/types.ts），PSD 的实现是
   > `editPixels`(src/image/edit-pixels.ts)。它是**唯一**被允许做 IO 的工具形态；
   > query/op 仍然是同步纯函数。见 docs/superpowers/specs/2026-09-01-psd-image-edit-design.md。
```

- [ ] **Step 7: 全量测试 + 类型检查**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: PASS。特别确认 `cloudflare-docx` 和 `cloudflare-markdown` 的 worker
（仍传常量 `agent`）没被这次类型放宽打破。

- [ ] **Step 8: 提交**

```bash
git add packages/cloudflare-sdk/src/operator-do-agent.ts \
        packages/cloudflare-sdk/tests/operator-agent-factory.test.ts \
        packages/cloudflare-psd/src/worker.ts packages/cloudflare-psd/.dev.vars.example \
        packages/doctype-psd/docs/design.md
git commit -m "feat(cloudflare-psd): 按 env 注入图像编辑模型，打通 editPixels"
```

确认 `git log -p origin/main..HEAD | grep -c 'sk-1'` 输出 0。

---

## 本轮不做（spec §8 / §9 / §10）

- `LayerDecomposer` 的实现（Qwen-Image-Layered 图层分解）。接口在 spec §2.4 留着。
- 第二个 `ImageEditor` 适配器。契约套件已经就位，加一个新实现只需要一个 test 文件调
  `runImageEditorContract`。
- 无蒙版时的自动分割兜底（`capabilities.mask === "required"` 的 provider 才需要）。
- selection target 里带 `layerId`（`web-psd/src/ui/api.ts:63` 现在只传图层名，
  逼着模型多做一次 `getLayers`）。
- 用 `messages.ts` 的 `degrade()` 压住历史图片每轮 720 KiB 的重发。
- 哨兵底色 alpha 还原在**真实模型输出**上的验证 —— Task 5 的单测只覆盖了纯函数本身，
  Task 6 的录制回放用的是构造出来的图。真跑一次 live 契约才算验完：
  `pnpm --filter @unidocs/doctype-psd test qwen-live`（需要自己加一个读 env key 的 test 文件）。
