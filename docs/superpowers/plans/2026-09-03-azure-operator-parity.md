# Azure Operator 对齐 Cloudflare — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Azure 上的三个 doc service 支持 agent（`/run`、`/reset`），与 Cloudflare 功能对齐；会话历史落 Postgres。

**Architecture:** ReAct 循环 `AgentSession` 已经云中立，只需注入 `agent` / `platform` / `provider`。本计划给它开一个历史进出口，把 Cloudflare 的 `AgentPlatform` 实现提为两条运行时共用，再在 `azure-sdk` 里写一个用 Postgres 存历史、用行级租约防并发的 operator 命名空间，替换现在一律 501 的 stub。

**Tech Stack:** TypeScript / Node 24 / pnpm 11 / vitest / Postgres (`pg`) / Azure Container Apps + bicep

**设计稿：** `docs/superpowers/specs/2026-09-03-azure-operator-parity-design.md`

## Global Constraints

- **Cloudflare 本轮一行行为都不改。** 唯一允许碰 `cloudflare-sdk` 的是 Task 3 的文件移动，且要求 CF 调用点（`operator-do-agent.ts:124`）逐字不变、运行时零变化。
- **`doctype-server-common` 与 `packages/protocol` 是云中立包**：不得出现 Cloudflare 或 Azure 类型（`DurableObjectStub`、`Pool`、`@azure/*`）。
- **历史里的 `SBlob` 只存 hash，不存字节。** 字节在 CAS 里；`AgentMessage` 的文档注释（`protocol/src/types.ts:315`）写着"附件是 SBlob 引用，不是字节"。
- **未知的 content part 类型解码时抛错，不静默丢弃。**
- **历史写回放 `finally`，不是成功路径。** `session.ts:81` 的 user 消息 push 在 try 之前，CF 今天的行为就是失败那轮也留在历史里。
- **表主键用 `(tenant_id, doc_type, session_id)`**，与 `doc_sessions`（`migrations/0003`）一致。这个代码库里一个 "session" 就是一份文档，没有 `doc_id` 这个列名。
- **租约 1800 秒**，与 `/run` 的能力票窗口一致（`gateway-common/src/capability-policy.ts:74-80`）。
- **`/reset` 强制清空租约**，作为崩溃后的人工逃生口。
- 每个任务结束前跑 `pnpm --filter <包名> typecheck`。

---

### Task 1: `AgentSession` 的历史进出口

**Files:**
- Modify: `packages/doctype-server-common/src/agent/session.ts:29-62,178-180`
- Test: `packages/doctype-server-common/tests/agent/session-history.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `AgentSessionDeps.history?: readonly AgentMessage[]`
  - `AgentSession.snapshotHistory(): readonly AgentMessage[]`

- [ ] **Step 1: 写失败的测试**

`packages/doctype-server-common/tests/agent/session-history.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentPlatform, DocumentAgent } from "@unidocs/protocol";
import { AgentSession } from "../../src/agent/session.js";
import type { LlmProvider } from "../../src/agent/index.js";

/** 只回一句话就收工的 provider：把它收到的 messages 记下来供断言。 */
function recordingProvider(): { provider: LlmProvider; seen: unknown[][] } {
  const seen: unknown[][] = [];
  return {
    seen,
    provider: {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        return { text: "done", toolCalls: [] };
      },
    } as unknown as LlmProvider,
  };
}

const agent: DocumentAgent<unknown, unknown> = { tools: [], instructions: "sys" };

const platform = {
  query: async () => ({ data: null, version: 0 }),
  apply: async () => ({ version: 1 }),
  readBlob: async () => ({ data: new Uint8Array(), contentType: "application/octet-stream" }),
  writeBlob: async () => { throw new Error("unused"); },
} as unknown as AgentPlatform<unknown, unknown>;

const priorTurn: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "第一轮问的" }] },
  { role: "assistant", content: [{ type: "text", text: "第一轮答的" }] },
];

describe("AgentSession 的历史进出口", () => {
  it("传入 history 就能续上对话 —— 模型看得见上一轮", async () => {
    const { provider, seen } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    await session.run([{ type: "text", text: "第二轮" }]);

    // 第一次模型调用收到的 messages 里必须含上一轮的两条。
    expect(JSON.stringify(seen[0])).toContain("第一轮问的");
    expect(JSON.stringify(seen[0])).toContain("第一轮答的");
  });

  it("不传 history 时行为与今天一致 —— 模型只看得见本轮", async () => {
    const { provider, seen } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider });

    await session.run([{ type: "text", text: "只有这一轮" }]);

    expect(JSON.stringify(seen[0])).not.toContain("第一轮");
    expect(seen[0]).toHaveLength(1);
  });

  it("snapshotHistory 返回本轮之后的完整历史", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    await session.run([{ type: "text", text: "第二轮" }]);
    const snap = session.snapshotHistory();

    expect(snap.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(snap)).toContain("第一轮问的");
    expect(JSON.stringify(snap)).toContain("第二轮");
  });

  // 交出内部数组会让调用方在写回之前不小心改坏历史，而这种 bug 只在
  // "下一次 run 读到脏历史"时才暴露，离现场很远。
  it("snapshotHistory 给的是副本，改它不影响内部", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    const snap = session.snapshotHistory() as AgentMessage[];
    snap.length = 0;

    expect(session.snapshotHistory()).toHaveLength(2);
  });

  // 构造时也要复制：调用方手上的那个数组不该随 run 增长。
  it("传进来的 history 被复制，调用方的数组不会被 run 改动", async () => {
    const { provider } = recordingProvider();
    const caller = [...priorTurn];
    const session = new AgentSession({ agent, platform, provider, history: caller });

    await session.run([{ type: "text", text: "第二轮" }]);

    expect(caller).toHaveLength(2);
  });

  it("reset 之后 snapshotHistory 是空的", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });
    session.reset();
    expect(session.snapshotHistory()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/session-history.test.ts`
Expected: FAIL —— `history` 不是 `AgentSessionDeps` 的属性（类型错误），且 `snapshotHistory` 不存在。

- [ ] **Step 3: 加 `history` 到 deps**

`packages/doctype-server-common/src/agent/session.ts` 的 `AgentSessionDeps` 里，在 `maxIterations` 之后加：

```ts
  /**
   * 起始对话历史。省略 = 空数组，即 Cloudflare 今天的行为。
   *
   * 给需要跨请求持久化的运行时用：Azure 是多副本无亲和的容器，每次 /run 都要
   * 重建 AgentSession，历史只能从外部灌进来。Cloudflare 把 AgentSession 对象
   * 本身留在 DO 字段上跨请求存活，所以它不传这个。
   */
  readonly history?: readonly AgentMessage[];
```

`AgentMessage` 已经在本文件 import 过（来自 `@unidocs/protocol`）；若没有则加进现有的 type import。

- [ ] **Step 4: 构造函数吃掉它**

把字段声明 `#history: AgentMessage[] = [];` 改成 `#history: AgentMessage[];`，并在构造函数体第一行加：

```ts
    // 复制而不是直接持有：调用方那份数组不该随 run 增长。
    this.#history = deps.history ? [...deps.history] : [];
```

- [ ] **Step 5: 加 `snapshotHistory`**

紧挨着 `reset()` 加：

```ts
  /**
   * 当前对话历史的快照，供需要跨请求持久化的运行时取出写回。
   *
   * 返回副本，不把内部数组交出去 —— 调用方在写回之前改坏它，只会在下一次
   * run 读到脏历史时才暴露，离现场很远。
   */
  snapshotHistory(): readonly AgentMessage[] {
    return [...this.#history];
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/session-history.test.ts`
Expected: PASS（6 条）

- [ ] **Step 7: 确认 CF 没被影响**

Run: `pnpm --filter @unidocs/doctype-server-common test && pnpm --filter @unidocs/cloudflare-sdk test && pnpm --filter @unidocs/doctype-server-common typecheck`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add packages/doctype-server-common/src/agent/session.ts packages/doctype-server-common/tests/agent/session-history.test.ts
git commit -m "feat(agent): AgentSession 开历史进出口 —— history 注入与 snapshotHistory

纯新增:不传 history 时行为逐字不变,Cloudflare 一个都不用。给 Azure 用 ——
它是多副本无亲和的容器,每次 /run 都要重建 AgentSession,历史只能从外部灌进来。

两处都复制而不是共享数组:构造时复制,免得调用方那份随 run 增长;快照也复制,
免得调用方在写回前改坏内部历史 —— 那种 bug 只在下一次 run 读到脏历史时暴露。"
```

---

### Task 2: 历史编解码器

**Files:**
- Create: `packages/doctype-server-common/src/agent/history-codec.ts`
- Modify: `packages/doctype-server-common/src/agent/index.ts`（导出）
- Test: `packages/doctype-server-common/tests/agent/history-codec.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` / `AgentContentPart` / `AgentToolCall`（`@unidocs/protocol`）
- Produces:
  - `encodeHistory(history: readonly AgentMessage[]): JsonValue`
  - `decodeHistory(raw: JsonValue): AgentMessage[]`

**背景（实现者必读）：** `AgentContentPart` 是三元联合（`protocol/src/types.ts:114-131`）：
`{type:"text", text}`、`{type:"image", blob: SBlob, mediaType, altText?}`、
`{type:"file", blob: SBlob, mediaType, filename?}`。
`AgentMessage` 是三元联合（`:316-328`）：`user`、`assistant`（可选 `toolCalls`）、
`tool`（有 `callId`，可选 `structuredContent`）。
`SBlob` 是**品牌对象**，必须用 `createSBlob(hash)` 重建，不能手搓 `{hash}`。

- [ ] **Step 1: 写失败的测试**

`packages/doctype-server-common/tests/agent/history-codec.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createSBlob, isSBlob } from "@unidocs/svalue-codec";
import type { AgentMessage } from "@unidocs/protocol";
import { decodeHistory, encodeHistory } from "../../src/agent/history-codec.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const history: AgentMessage[] = [
  { role: "user", content: [
    { type: "text", text: "把这张图去掉背景" },
    { type: "image", blob: createSBlob(HASH_A), mediaType: "image/png", altText: "原图" },
  ] },
  { role: "assistant",
    content: [{ type: "text", text: "好的" }],
    toolCalls: [{ id: "call-1", name: "editPixels", arguments: { layerId: "l0" } }] },
  { role: "tool", callId: "call-1",
    content: [{ type: "file", blob: createSBlob(HASH_B), mediaType: "application/pdf", filename: "r.pdf" }],
    structuredContent: { ok: true } },
];

describe("历史编解码器", () => {
  it("往返一致", () => {
    expect(decodeHistory(encodeHistory(history))).toEqual(history);
  });

  // 这是本编解码器存在的全部理由。字节在 CAS 里,历史里存的一直是引用
  // (protocol/src/types.ts:315)。存字节会让每条历史带上几 MB 的 base64,
  // 一份长对话能把 jsonb 撑爆。
  it("SBlob 只编成 hash，编码结果里不出现字节", () => {
    const encoded = JSON.stringify(encodeHistory(history));
    expect(encoded).toContain(HASH_A);
    expect(encoded).not.toContain("data");
    expect(encoded).not.toContain("Uint8Array");
    expect(encoded.length).toBeLessThan(1000);
  });

  it("解码出来的是真正的 SBlob 品牌对象，不是手搓的 {hash}", () => {
    const decoded = decodeHistory(encodeHistory(history));
    const part = (decoded[0] as { content: { type: string; blob?: unknown }[] }).content[1]!;
    expect(part.type).toBe("image");
    expect(isSBlob(part.blob)).toBe(true);
  });

  it("空历史往返成空数组", () => {
    expect(decodeHistory(encodeHistory([]))).toEqual([]);
  });

  it("可选字段缺席时不会凭空长出来", () => {
    const minimal: AgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "无工具调用" }] },
    ];
    const decoded = decodeHistory(encodeHistory(minimal));
    expect(decoded).toEqual(minimal);
    expect("toolCalls" in decoded[0]!).toBe(false);
  });

  // 静默丢弃一条图片消息，会让模型在后续轮次里引用一张它其实没看到的图 ——
  // 表现是模型"胡说八道"，而根因在这里，隔着好几层。
  it.each([
    ["未知的 part 类型", { role: "user", content: [{ type: "video", url: "x" }] }],
    ["未知的 role", { role: "system", content: [] }],
    ["image 缺 hash", { role: "user", content: [{ type: "image", mediaType: "image/png" }] }],
    ["content 不是数组", { role: "user", content: "文本" }],
  ])("%s 一律抛错，不静默丢弃", (_label, bad) => {
    expect(() => decodeHistory([bad] as never)).toThrow();
  });

  it("顶层不是数组也抛错", () => {
    expect(() => decodeHistory({ role: "user" } as never)).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/history-codec.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现编解码器**

`packages/doctype-server-common/src/agent/history-codec.ts`：

```ts
/**
 * 对话历史与 JSON 之间的编解码。
 *
 * 存在的理由只有一条:`AgentMessage` 的 image / file part 带 `SBlob` ——
 * 一个**品牌对象**,`JSON.parse(JSON.stringify(x))` 拿回来的 `{hash}` 不是它,
 * 后续任何 `isSBlob` 校验都会失败。所以编码写 hash、解码用 `createSBlob()`
 * 重建。
 *
 * 只存引用不存字节:字节在 CAS 里,`AgentMessage` 的文档注释
 * (`protocol/src/types.ts:315`)写着"附件是 SBlob 引用,不是字节"。存字节会让
 * 一份长对话把 jsonb 撑爆。
 */
import { createSBlob } from "@unidocs/svalue-codec";
import type {
  AgentContentPart,
  AgentMessage,
  AgentToolCall,
  JsonValue,
} from "@unidocs/protocol";

function fail(what: string, got: unknown): never {
  throw new Error(`history-codec: ${what} — got ${JSON.stringify(got)?.slice(0, 120)}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function encodePart(part: AgentContentPart): JsonValue {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    return {
      type: "image",
      hash: part.blob.hash,
      mediaType: part.mediaType,
      ...(part.altText === undefined ? {} : { altText: part.altText }),
    };
  }
  return {
    type: "file",
    hash: part.blob.hash,
    mediaType: part.mediaType,
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  };
}

function decodePart(raw: unknown): AgentContentPart {
  if (!isRecord(raw)) fail("content part is not an object", raw);
  if (raw.type === "text") {
    if (typeof raw.text !== "string") fail("text part has no text", raw);
    return { type: "text", text: raw.text };
  }
  if (raw.type === "image" || raw.type === "file") {
    if (typeof raw.hash !== "string") fail(`${raw.type} part has no hash`, raw);
    if (typeof raw.mediaType !== "string") fail(`${raw.type} part has no mediaType`, raw);
    const blob = createSBlob(raw.hash);
    if (raw.type === "image") {
      return {
        type: "image", blob, mediaType: raw.mediaType,
        ...(raw.altText === undefined ? {} : { altText: String(raw.altText) }),
      };
    }
    return {
      type: "file", blob, mediaType: raw.mediaType,
      ...(raw.filename === undefined ? {} : { filename: String(raw.filename) }),
    };
  }
  // 静默丢弃会让模型在后续轮次里引用一张它其实没看到的图。
  fail("unknown content part type", raw);
}

function decodeToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) fail("toolCalls is not an array", raw);
  return raw.map((c) => {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.name !== "string") {
      fail("malformed tool call", c);
    }
    return { id: c.id, name: c.name, arguments: (c.arguments ?? null) as JsonValue };
  });
}

export function encodeHistory(history: readonly AgentMessage[]): JsonValue {
  return history.map((m) => {
    const content = m.content.map(encodePart);
    if (m.role === "user") return { role: "user", content };
    if (m.role === "assistant") {
      return {
        role: "assistant", content,
        ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls.map(c => ({ ...c })) }),
      };
    }
    return {
      role: "tool", callId: m.callId, content,
      ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent }),
    };
  }) as JsonValue;
}

export function decodeHistory(raw: JsonValue): AgentMessage[] {
  if (!Array.isArray(raw)) fail("history is not an array", raw);
  return raw.map((m) => {
    if (!isRecord(m)) fail("message is not an object", m);
    if (!Array.isArray(m.content)) fail("message content is not an array", m);
    const content = m.content.map(decodePart);
    if (m.role === "user") return { role: "user", content } as AgentMessage;
    if (m.role === "assistant") {
      return {
        role: "assistant", content,
        ...(m.toolCalls === undefined ? {} : { toolCalls: decodeToolCalls(m.toolCalls) }),
      } as AgentMessage;
    }
    if (m.role === "tool") {
      if (typeof m.callId !== "string") fail("tool message has no callId", m);
      return {
        role: "tool", callId: m.callId, content,
        ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent as JsonValue }),
      } as AgentMessage;
    }
    fail("unknown message role", m);
  });
}
```

- [ ] **Step 4: 导出**

在 `packages/doctype-server-common/src/agent/index.ts` 里加一行：

```ts
export { decodeHistory, encodeHistory } from "./history-codec.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/history-codec.test.ts`
Expected: PASS

- [ ] **Step 6: 变异验证（本任务的验收证据，必做）**

设计稿把这一项定为权重最高：CF 本轮不接持久化，**这个编解码器只有 Azure 一条路径在跑**，测试是它唯一的保障。

变异 A —— 把 `encodePart` 的 image 分支改成存字节的假象：

```ts
// 临时改：把 hash 换成一个 data 字段
return { type: "image", data: part.blob.hash, mediaType: part.mediaType };
```

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/history-codec.test.ts`
Expected: **FAIL**（往返一致、只编 hash、品牌对象三条中至少一条挂）。挂不掉就说明测试无效，重写测试。改回。

变异 B —— 把 `decodePart` 末尾的 `fail(...)` 换成静默丢弃：

```ts
return { type: "text", text: "" };
```

Expected: **FAIL**（"未知的 part 类型一律抛错"那条挂）。挂不掉就重写。改回。

- [ ] **Step 7: 提交**

```bash
git add packages/doctype-server-common/src/agent/history-codec.ts packages/doctype-server-common/src/agent/index.ts packages/doctype-server-common/tests/agent/history-codec.test.ts
git commit -m "feat(agent): 对话历史的 JSON 编解码器 —— SBlob 只存 hash

AgentMessage 的 image/file part 带 SBlob,是品牌对象:JSON 往返拿回来的 {hash}
过不了 isSBlob,所以编码写 hash、解码用 createSBlob() 重建。只存引用不存字节 ——
字节在 CAS 里,存进历史会让一份长对话把 jsonb 撑爆。

未知的 part 类型与 role 一律抛错,不静默丢弃:被悄悄吞掉的图片消息会让模型在
后续轮次里引用一张它其实没看到的图,表现是模型胡说八道,根因隔着好几层。

变异验证:把 SBlob 编码改成存字节、把未知类型改成静默丢弃,各自都挂掉了测试。"
```

---

### Task 3: 把 `AgentPlatform` 实现提为两条运行时共用

**Files:**
- Create: `packages/doctype-server-common/src/agent/platform-http.ts`（由 `cloudflare-sdk/src/agent-platform-do.ts` 移动而来）
- Delete: `packages/cloudflare-sdk/src/agent-platform-do.ts`
- Modify: `packages/cloudflare-sdk/src/index.ts`、新增 `packages/cloudflare-sdk/src/agent-platform-do.ts` 的再导出（见下）
- Modify: `packages/doctype-server-common/src/agent/index.ts`（导出）
- Test: `packages/doctype-server-common/tests/agent/platform-http.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface EditorFetcher { fetch(url: string, init?: RequestInit): Promise<Response> }`
  - `createHttpAgentPlatform<TQuery, TOp, TEnv>(deps: HttpAgentPlatformDeps<TEnv>): AgentPlatform<TQuery, TOp>`
  - `HttpAgentPlatformDeps<TEnv>` —— 与原 `CloudflarePlatformDeps<TEnv>` 同形，只有 `getEditorStub` 的返回类型从 `DurableObjectStub` 变成 `EditorFetcher`

**这一步为什么安全：** 原文件 174 行里，Cloudflare 特异性只有 `DurableObjectStub` **一个类型、五个出现位置**（`:18` `:35` `:45` `:53` `:139`），其余 import 全是 `@unidocs/*`。`DurableObjectStub.fetch(url, init)` 结构上满足 `EditorFetcher`，所以 CF 把 stub 原样传进去即可，运行时零变化。

- [ ] **Step 1: 移动文件**

```bash
git mv packages/cloudflare-sdk/src/agent-platform-do.ts packages/doctype-server-common/src/agent/platform-http.ts
```

- [ ] **Step 2: 换掉那一个类型**

在 `platform-http.ts` 顶部加：

```ts
/**
 * 编辑器的最小可调用面。
 *
 * Cloudflare 传 `DurableObjectStub`（结构上就是这个签名，原样传即可）；
 * Azure 传一层包住 `LocalNamespace` 的适配器。这个 interface 存在的唯一
 * 目的，就是让这 170 行不必认识 `DurableObjectStub`，从而离开 cloudflare-sdk。
 */
export interface EditorFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
```

把 `:18` `:35` 两处的 `DurableObjectStub` 改成 `EditorFetcher`（`:45` `:53` `:139` 是 `stub.fetch(...)` 调用，不用改）。

把 `CloudflarePlatformDeps` 改名为 `HttpAgentPlatformDeps`，`createCloudflareAgentPlatform` 改名为 `createHttpAgentPlatform`。文件头的注释把"`AgentPlatform` 的 Cloudflare 实现"改成"`AgentPlatform` 的 HTTP 实现（两条运行时共用）"，其余注释原样保留。

- [ ] **Step 3: `doctype-server-common` 导出**

`packages/doctype-server-common/src/agent/index.ts` 加：

```ts
export { createHttpAgentPlatform } from "./platform-http.js";
export type { EditorFetcher, HttpAgentPlatformDeps } from "./platform-http.js";
```

- [ ] **Step 4: `cloudflare-sdk` 保留旧名字，使调用点不变**

新建 `packages/cloudflare-sdk/src/agent-platform-do.ts`：

```ts
/**
 * 兼容层。实现已提到 `@unidocs/doctype-server-common/agent` 供两条运行时共用
 * （见那边的 `platform-http.ts`）；这里保留旧名字，让 `operator-do-agent.ts`
 * 的调用点一个字都不用改。
 */
export {
  createHttpAgentPlatform as createCloudflareAgentPlatform,
} from "@unidocs/doctype-server-common/agent";
export type {
  HttpAgentPlatformDeps as CloudflarePlatformDeps,
} from "@unidocs/doctype-server-common/agent";
```

`packages/cloudflare-sdk/src/index.ts` 若原本从该文件再导出，保持不变。

- [ ] **Step 5: 写测试**

`packages/doctype-server-common/tests/agent/platform-http.test.ts`：

```ts
/**
 * 本任务只搬运,不改行为,所以测试盯的是**这次真正新增的东西** ——
 * `EditorFetcher` 这层抽象:请求打到哪、转发头带没带、以及"任何带
 * fetch(url, init) 的对象都能满足它"。
 *
 * 刻意不断言响应解析:`query` 走的是 SValue 编码响应
 * (`decodeValueResponse`,见 platform-http.ts 的 query),伪造它等于把实现抄进
 * 测试;而那段解析逻辑本次一个字没动,已由 cloudflare-sdk 的既有测试覆盖。
 */
import { describe, expect, it } from "vitest";
import { createHttpAgentPlatform, type EditorFetcher } from "../../src/agent/platform-http.js";

function recordingEditor(): {
  fetcher: EditorFetcher; calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    // 回一个空体:调用方随后的解析会抛,但请求已经发出并被记下 —— 这正是
    // 本测试要看的东西。
    fetcher: { fetch: async (url, init) => { calls.push({ url, init }); return new Response("", { status: 200 }); } },
  };
}

describe("createHttpAgentPlatform", () => {
  it("query 打到编辑器的 /_internal/query，并原样带上转发头", async () => {
    const { fetcher, calls } = recordingEditor();
    const headers = new Headers({ "X-Tenant-Id": "t1", "X-Session-Id": "s1" });
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: () => fetcher,
      requestHeaders: () => headers,
      editorObjectName: () => "t1:psd:s1",
    });

    // 响应体是空的,解析必然抛 —— 我们要的是它抛之前发出的那个请求。
    await platform.query({ kind: "getText" } as never).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/_internal/query");
    expect(new Headers(calls[0]!.init!.headers).get("X-Tenant-Id")).toBe("t1");
    expect(new Headers(calls[0]!.init!.headers).get("X-Session-Id")).toBe("s1");
  });

  it("getEditorStub 拿到的是 editorObjectName() 的返回值", async () => {
    const { fetcher } = recordingEditor();
    const names: string[] = [];
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: (_env, name) => { names.push(name); return fetcher; },
      requestHeaders: () => new Headers(),
      editorObjectName: () => "t1:psd:s1",
    });

    await platform.query({ kind: "getText" } as never).catch(() => undefined);

    expect(names).toEqual(["t1:psd:s1"]);
  });

  // 这条钉住 EditorFetcher 这个抽象本身：只要它还只要求 `.fetch(url, init)`，
  // 一个纯对象就能满足 —— Azure 那侧才不需要 DurableObjectStub。把类型收回成
  // DurableObjectStub 的话，这行编译不过。
  it("接受任何带 fetch(url, init) 的纯对象，不要求 DurableObjectStub", () => {
    const plain = { fetch: async () => new Response("{}", { status: 200 }) };
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: () => plain,
      requestHeaders: () => new Headers(),
      editorObjectName: () => "n",
    });
    expect(platform).toBeDefined();
  });
});
```

- [ ] **Step 6: 跑测试与全量回归**

Run:
```
pnpm --filter @unidocs/doctype-server-common exec vitest run tests/agent/platform-http.test.ts
pnpm --filter @unidocs/doctype-server-common test
pnpm --filter @unidocs/cloudflare-sdk test
pnpm typecheck
```
Expected: 全部 PASS。**`cloudflare-sdk` 必须零改动地通过**——它是本任务"CF 行为不变"的证据。

- [ ] **Step 7: 确认 CF 调用点真的没动**

Run: `git diff --stat packages/cloudflare-sdk/src/operator-do-agent.ts`
Expected: 无输出（该文件未被修改）。

- [ ] **Step 8: 提交**

```bash
git add -A packages/cloudflare-sdk/src packages/doctype-server-common/src/agent packages/doctype-server-common/tests/agent/platform-http.test.ts
git commit -m "refactor(agent): AgentPlatform 的 HTTP 实现提为两条运行时共用

原文件 174 行里 Cloudflare 特异性只有 DurableObjectStub 一个类型、五个位置,
其余 import 全是 @unidocs/*。抽象成 EditorFetcher(只要求 fetch(url, init)),
DurableObjectStub 结构上就满足它,所以 CF 原样传 stub、运行时零变化。

cloudflare-sdk 保留 createCloudflareAgentPlatform 作为再导出别名,
operator-do-agent.ts 的调用点一个字没改(git diff --stat 为空)。

于是 Azure 侧不需要再写一份 AgentPlatform。"
```

---

### Task 4: Postgres 的历史表与租约

**Files:**
- Create: `packages/azure-sdk/migrations/0004_agent_sessions.sql`
- Create: `packages/azure-sdk/src/agent-session-store.ts`
- Modify: `packages/azure-sdk/src/index.ts`（导出）
- Test: `packages/azure-sdk/tests/agent-session-store.test.ts`

**Interfaces:**
- Consumes: `SessionIdentity`（`@unidocs/doctype-server-common`）、`Pool`（`pg`）
- Produces:
  - `class PgAgentSessionStore`
    - `constructor(pool: Pool, identity: SessionIdentity)`
    - `acquire(leaseSeconds: number): Promise<JsonValue | null>` —— 抢到租约返回历史（`JsonValue`，从未存过是 `[]`）；抢不到返回 `null`
    - `release(history: JsonValue): Promise<void>` —— 写回历史并释放租约
    - `clear(): Promise<void>` —— 清空历史**并强制释放租约**
  - `AGENT_LEASE_SECONDS = 1800`

**为什么租约与历史同一行：** 一次 `/run` 的第一个动作就是"拿到历史并宣告我在跑"，两件事必须原子。分两张表就要么开事务、要么容忍中间态。

- [ ] **Step 1: 写迁移**

`packages/azure-sdk/migrations/0004_agent_sessions.sql`：

```sql
BEGIN;

-- agent 的对话历史与"正在跑"租约。
--
-- 与 doc_sessions 同一套主键 (tenant_id, doc_type, session_id):这个代码库里
-- 一个 session 就是一份文档。外键跟着删,免得文档没了历史还留着。
--
-- 历史与租约刻意放同一行:一次 /run 的第一个动作是"拿到历史并宣告我在跑",
-- 两件事必须原子。分两张表就要么开事务、要么容忍中间态。
CREATE TABLE IF NOT EXISTS agent_sessions (
  tenant_id     TEXT        NOT NULL,
  doc_type      TEXT        NOT NULL,
  session_id    TEXT        NOT NULL,
  history       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- NULL = 没人在跑。过去的时间 = 上一个持有者崩了,租约已过期,可以抢。
  running_until TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, doc_type, session_id),
  CONSTRAINT agent_sessions_session_fk
    FOREIGN KEY (tenant_id, doc_type, session_id)
    REFERENCES doc_sessions (tenant_id, doc_type, session_id)
    ON DELETE CASCADE
);

COMMIT;
```

- [ ] **Step 2: 写失败的测试**

`packages/azure-sdk/tests/agent-session-store.test.ts`：

```ts
/**
 * 打真 Postgres（容器由 tests/containers.ts 的 globalSetup 起一次），
 * 与 ports.test.ts 同一套夹具。租约的正确性只有真库能证明 —— 它靠的是
 * 一条 UPDATE 的原子性，用假 pool 测等于测自己写的假货。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, runMigrations, PgSessionIdentityStore } from "../src/index.js";
import { PgAgentSessionStore, AGENT_LEASE_SECONDS } from "../src/agent-session-store.js";
import { DATABASE_URL } from "./containers.js";

const identity = { tenantId: "t-agent", docType: "psd", sessionId: "" };
let pool: Pool;
let seq = 0;

/** 每个用例一份新文档 —— 外键要求 doc_sessions 里先有行。 */
async function freshIdentity() {
  const id = { ...identity, sessionId: `s-${++seq}-${Date.now()}` };
  await new PgSessionIdentityStore(pool).register(id);
  return id;
}

beforeAll(async () => {
  pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
});
afterAll(async () => { await pool.end(); });

describe("PgAgentSessionStore", () => {
  it("第一次 acquire 拿到空历史", async () => {
    const id = await freshIdentity();
    const store = new PgAgentSessionStore(pool, id);
    expect(await store.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("release 写回的历史，下一次 acquire 读得到", async () => {
    const id = await freshIdentity();
    const store = new PgAgentSessionStore(pool, id);
    await store.acquire(AGENT_LEASE_SECONDS);
    await store.release([{ role: "user", content: [{ type: "text", text: "记住我" }] }] as never);

    expect(await store.acquire(AGENT_LEASE_SECONDS)).toEqual(
      [{ role: "user", content: [{ type: "text", text: "记住我" }] }],
    );
  });

  // 这条是租约存在的全部理由：Azure 是 2-5 副本无亲和，两个 /run 会真的
  // 同时打到同一份文档上。
  it("租约未释放时，第二个 acquire 拿不到", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);

    expect(await a.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toBeNull();
  });

  it("并发抢占只有一个赢", async () => {
    const id = await freshIdentity();
    const stores = Array.from({ length: 8 }, () => new PgAgentSessionStore(pool, id));
    const results = await Promise.all(stores.map(s => s.acquire(AGENT_LEASE_SECONDS)));
    expect(results.filter(r => r !== null)).toHaveLength(1);
  });

  it("release 之后可以再抢", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(AGENT_LEASE_SECONDS);
    await a.release([] as never);
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("租约过期后可以再抢", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(-1);                       // 立刻过期
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  // /reset 是崩溃后唯一的人工逃生口：租约 1800 秒，没有它就得干等 30 分钟。
  it("clear 清空历史，并强制释放租约", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(AGENT_LEASE_SECONDS);
    await a.release([{ role: "user", content: [{ type: "text", text: "旧的" }] }] as never);
    await a.acquire(AGENT_LEASE_SECONDS);      // 故意不 release，模拟崩溃

    await b.clear();

    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("不同文档之间互不影响", async () => {
    const one = await freshIdentity();
    const two = await freshIdentity();
    await new PgAgentSessionStore(pool, one).acquire(AGENT_LEASE_SECONDS);
    expect(await new PgAgentSessionStore(pool, two).acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/agent-session-store.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 store**

`packages/azure-sdk/src/agent-session-store.ts`：

```ts
/**
 * agent 对话历史 + "正在跑"租约的 Postgres 实现。表见
 * `migrations/0004_agent_sessions.sql`。
 *
 * 为什么要租约:Cloudflare 那边靠 Durable Object 的 `#requestTail`——单线程
 * isolate 里的一条 promise 链——把同一文档上的并发 /run 串起来,等待不占任何
 * 资源。Azure 是 2-5 副本、无会话亲和,没有等价物:跨副本的等待要么攥着 Postgres
 * 连接(几个等待者就能吃干连接池),要么攥着 HTTP 请求槽最长 30 分钟。所以这里
 * 是"抢不到就快速失败",由调用方回 409。
 */
import type { Pool } from "pg";
import type { JsonValue } from "@unidocs/protocol";
import type { SessionIdentity } from "@unidocs/doctype-server-common";

/**
 * 租约时长，与 `/run` 自己的能力票窗口一致
 * （`gateway-common/src/capability-policy.ts:74-80`，注释："窗口必须覆盖整次
 * run"）。票过期后这次 run 再写也是 401，所以它就是一次 run 的硬上限。
 *
 * 代价:持有者进程崩溃后,同一份文档最多 30 分钟抢不到租约。`/reset` 走
 * `clear()` 强制释放,是明确的人工逃生口。
 */
export const AGENT_LEASE_SECONDS = 1800;

export class PgAgentSessionStore {
  readonly #pool: Pool;
  readonly #identity: SessionIdentity;

  constructor(pool: Pool, identity: SessionIdentity) {
    this.#pool = pool;
    this.#identity = identity;
  }

  get #key(): [string, string, string] {
    return [this.#identity.tenantId, this.#identity.docType, this.#identity.sessionId];
  }

  /**
   * 抢租约并取回历史。抢到返回历史（从未存过是 `[]`），抢不到返回 `null`。
   *
   * 一条语句完成"插入或抢占":`ON CONFLICT ... DO UPDATE ... WHERE` 的 WHERE
   * 不满足时不返回行,于是 `rowCount === 0` 就是"别人正在跑"。分成先 SELECT
   * 再 UPDATE 会在两句之间留下竞态窗口,而这正是租约要消灭的东西。
   */
  async acquire(leaseSeconds: number): Promise<JsonValue | null> {
    const { rows } = await this.#pool.query<{ history: JsonValue }>(
      `INSERT INTO agent_sessions (tenant_id, doc_type, session_id, running_until)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (tenant_id, doc_type, session_id) DO UPDATE
         SET running_until = now() + make_interval(secs => $4), updated_at = now()
         WHERE agent_sessions.running_until IS NULL
            OR agent_sessions.running_until < now()
       RETURNING history`,
      [...this.#key, leaseSeconds],
    );
    return rows.length === 0 ? null : rows[0]!.history;
  }

  /** 写回历史并释放租约。调用方必须放在 finally 里。 */
  async release(history: JsonValue): Promise<void> {
    await this.#pool.query(
      `UPDATE agent_sessions
          SET history = $4::jsonb, running_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND doc_type = $2 AND session_id = $3`,
      [...this.#key, JSON.stringify(history)],
    );
  }

  /** 清空历史并**强制**释放租约 —— `/reset` 是崩溃后的人工逃生口。 */
  async clear(): Promise<void> {
    await this.#pool.query(
      `UPDATE agent_sessions
          SET history = '[]'::jsonb, running_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND doc_type = $2 AND session_id = $3`,
      this.#key,
    );
  }
}
```

- [ ] **Step 5: 导出**

`packages/azure-sdk/src/index.ts` 加：

```ts
export { AGENT_LEASE_SECONDS, PgAgentSessionStore } from "./agent-session-store.js";
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/agent-session-store.test.ts`
Expected: PASS（8 条）

- [ ] **Step 7: 变异验证（本任务的验收证据，必做）**

变异 —— 把 `acquire` 里的租约条件去掉：

```sql
       ON CONFLICT (tenant_id, doc_type, session_id) DO UPDATE
         SET running_until = now() + make_interval(secs => $4), updated_at = now()
       RETURNING history
```
（删掉 `WHERE agent_sessions.running_until IS NULL OR agent_sessions.running_until < now()` 两行）

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/agent-session-store.test.ts`
Expected: **FAIL** —— "租约未释放时第二个 acquire 拿不到" 与 "并发抢占只有一个赢" 至少挂一条。挂不掉说明测试无效，重写测试。改回。

- [ ] **Step 8: 提交**

```bash
git add packages/azure-sdk/migrations/0004_agent_sessions.sql packages/azure-sdk/src/agent-session-store.ts packages/azure-sdk/src/index.ts packages/azure-sdk/tests/agent-session-store.test.ts
git commit -m "feat(azure): agent 会话的 Postgres 历史表与租约

历史与租约同一行:一次 /run 的第一个动作是"拿到历史并宣告我在跑",两件事必须
原子。一条 INSERT ... ON CONFLICT DO UPDATE ... WHERE 完成插入或抢占,WHERE 不
满足就不返回行,rowCount === 0 即"别人正在跑"。先 SELECT 再 UPDATE 会在两句之间
留下竞态窗口,而那正是租约要消灭的东西。

租约 1800 秒与 /run 的能力票窗口一致 —— 票过期后再写也是 401,它就是一次 run 的
硬上限。代价是崩溃后 30 分钟抢不到,clear() 给 /reset 当强制逃生口。

打真 Postgres 测(与 ports.test.ts 同一套容器夹具):租约靠的是一条 UPDATE 的
原子性,用假 pool 测等于测自己写的假货。变异验证:去掉 WHERE 条件后并发抢占
那两条挂掉。"
```

---

### Task 5: Azure 的 operator 命名空间

**Files:**
- Create: `packages/azure-sdk/src/local-operator.ts`
- Modify: `packages/azure-sdk/src/index.ts`（导出）
- Test: `packages/azure-sdk/tests/local-operator.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `history` / `snapshotHistory()`；Task 2 的 `encodeHistory` / `decodeHistory`；Task 3 的 `createHttpAgentPlatform` / `EditorFetcher`；Task 4 的 `PgAgentSessionStore` / `AGENT_LEASE_SECONDS`
- Produces:
  - `createLocalOperatorNamespace<TQuery, TOp>(deps: LocalOperatorDeps<TQuery, TOp>): LocalNamespace`
  - `interface LocalOperatorDeps<TQuery, TOp> { pool: Pool; editor: LocalNamespace; agent: DocumentAgent<TQuery, TOp>; provider: LlmProvider; docType: string; leaseSeconds?: number }`

**端点契约（与 Cloudflare 逐字对齐，见 `operator-do-agent.ts:83-107`）：**

| 请求 | 响应 |
|---|---|
| `POST /_internal/run`，body `{instruction: string}` | 成功 `{success:true, data:{response, iterations}}`；`instruction` 非字符串 400；缺身份头 401；outcome 失败 500 |
| `POST /_internal/reset` | `{success:true}` |
| 其它 | 404 `{success:false, error:"Unknown endpoint: …"}` |

**新增（CF 没有）：** 抢不到租约 → **409** `{success:false, error:"Another agent run is in progress for this document"}`。

- [ ] **Step 1: 写失败的测试**

`packages/azure-sdk/tests/local-operator.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { AgentPlatform, DocumentAgent } from "@unidocs/protocol";
import { createPool, runMigrations, PgSessionIdentityStore } from "../src/index.js";
import { createLocalOperatorNamespace } from "../src/local-operator.js";
import { DATABASE_URL } from "./containers.js";

let pool: Pool;
let seq = 0;

const agent: DocumentAgent<unknown, unknown> = { tools: [], instructions: "sys" };

/** 每次 complete 都直接收工，并把收到的 messages 记下来。 */
function recordingProvider() {
  const seen: unknown[][] = [];
  return {
    seen,
    provider: {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        return { text: "ok", toolCalls: [] };
      },
    } as never,
  };
}

/** 编辑器永远不会被这个 agent 调到（工具表是空的）。 */
const editor = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) };

function headers(sessionId: string): HeadersInit {
  return {
    "X-Tenant-Id": "t-op",
    "X-Session-Id": sessionId,
    "X-Doc-Type": "psd",
    "X-UniDocs-Auth-Context": "capability",
    "Content-Type": "application/json",
  };
}

async function freshSession(): Promise<string> {
  const sessionId = `op-${++seq}-${Date.now()}`;
  await new PgSessionIdentityStore(pool).register({ tenantId: "t-op", docType: "psd", sessionId });
  return sessionId;
}

beforeAll(async () => {
  pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
});
afterAll(async () => { await pool.end(); });

function ns(provider: never) {
  return createLocalOperatorNamespace({ pool, editor, agent, provider, docType: "psd" });
}

describe("createLocalOperatorNamespace", () => {
  it("/run 跑通并返回与 CF 同形的响应体", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: "你好" }) },
    ));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { response: "ok" } });
  });

  // 这是整件事的目的：Azure 是多副本，历史必须活过请求边界。
  it("第二次 /run 时模型看得见第一次的对话", async () => {
    const sessionId = await freshSession();
    const { provider, seen } = recordingProvider();
    const namespace = ns(provider);
    const call = (text: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: text }) },
    ));

    await call("第一句");
    await call("第二句");

    expect(JSON.stringify(seen[1])).toContain("第一句");
  });

  it("/reset 之后历史清空", async () => {
    const sessionId = await freshSession();
    const { provider, seen } = recordingProvider();
    const namespace = ns(provider);
    const call = (text: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: text }) },
    ));

    await call("第一句");
    const reset = await namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/reset", { method: "POST", headers: headers(sessionId) },
    ));
    expect(await reset.json()).toEqual({ success: true });

    await call("第二句");
    expect(JSON.stringify(seen[1])).not.toContain("第一句");
  });

  it("instruction 不是字符串 -> 400", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: 42 }) },
    ));
    expect(res.status).toBe(400);
  });

  it("缺身份头 -> 401", async () => {
    const { provider } = recordingProvider();
    const res = await ns(provider).get("x").fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: "a" }) },
    ));
    expect(res.status).toBe(401);
  });

  it("未知端点 -> 404", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/nope", { method: "POST", headers: headers(sessionId) },
    ));
    expect(res.status).toBe(404);
  });

  // 租约在 HTTP 这一层的表现。慢 provider 让第一次 run 悬着，第二次就撞上。
  it("同一文档并发 /run -> 第二个 409", async () => {
    const sessionId = await freshSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = {
      async complete() { await gate; return { text: "ok", toolCalls: [] }; },
    } as never;
    const namespace = ns(provider);
    const call = () => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: "a" }) },
    ));

    const first = call();
    await new Promise((r) => setTimeout(r, 50));   // 让第一次抢到租约
    const second = await call();
    expect(second.status).toBe(409);

    release();
    expect((await first).status).toBe(200);
  });

  // 写回放 finally 的证据。CF 的 #history.push 在 try 之前(session.ts:81),
  // 失败那轮也留在历史里;两条运行时在"重试时模型看到什么"上必须一致。
  it("run 失败时历史仍被写回，含失败那轮的 user 消息", async () => {
    const sessionId = await freshSession();
    const seen: unknown[][] = [];
    let failNext = true;
    const provider = {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        if (failNext) { failNext = false; throw new Error("provider 挂了"); }
        return { text: "ok", toolCalls: [] };
      },
    } as never;
    const namespace = ns(provider);
    const call = (t: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: t }) },
    ));

    await call("失败的那句");
    await call("重试");

    expect(JSON.stringify(seen[1])).toContain("失败的那句");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/local-operator.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`packages/azure-sdk/src/local-operator.ts`：

```ts
/**
 * Azure 的 operator 命名空间 —— 替换掉一律 501 的
 * `createStubOperatorNamespace()`。
 *
 * 与 Cloudflare 的 `OperatorDO` 端点逐字对齐（`operator-do-agent.ts:83-107`），
 * 只多一个状态码:抢不到租约返回 409。
 *
 * 与编辑器命名空间同理（见 `local-editor.ts` 的模块注释）：每次请求新建
 * `AgentSession`，不缓存。Azure 是 2-5 副本、无会话亲和，缓存在进程里的会话
 * 下一次请求就落到别的副本上了。历史因此必须落库，这正是
 * `PgAgentSessionStore` 存在的原因。
 */
import type { Pool } from "pg";
import type { AgentContentPart, DocumentAgent, JsonValue } from "@unidocs/protocol";
import {
  AgentSession,
  createHttpAgentPlatform,
  decodeHistory,
  encodeHistory,
  type EditorFetcher,
  type LlmProvider,
} from "@unidocs/doctype-server-common/agent";
import type { SessionIdentity } from "@unidocs/doctype-server-common";
import { AGENT_LEASE_SECONDS, PgAgentSessionStore } from "./agent-session-store.js";
import type { LocalNamespace } from "./local-editor.js";

/** 转发给编辑器的头，与 CF 的 `#captureIdentity` 同一张表。 */
const FORWARDED_HEADERS = [
  "X-Tenant-Id",
  "X-Session-Id",
  "X-Doc-Type",
  "X-Internal-Token",
  "X-UniDocs-Auth-Context",
  "X-UniDocs-Doc-Operation",
  "X-UniDocs-CAS-Capability",
] as const;

export interface LocalOperatorDeps<TQuery, TOp> {
  readonly pool: Pool;
  /** 同一个进程里的编辑器命名空间；agent 的读写都打到它。 */
  readonly editor: LocalNamespace;
  readonly agent: DocumentAgent<TQuery, TOp>;
  readonly provider: LlmProvider;
  readonly docType: string;
  /** 只给测试用；生产走 AGENT_LEASE_SECONDS。 */
  readonly leaseSeconds?: number;
}

const json = (body: JsonValue, status = 200): Response =>
  Response.json(body as never, { status });

export function createLocalOperatorNamespace<TQuery, TOp>(
  deps: LocalOperatorDeps<TQuery, TOp>,
): LocalNamespace {
  const leaseSeconds = deps.leaseSeconds ?? AGENT_LEASE_SECONDS;

  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const tenantId = request.headers.get("X-Tenant-Id");
        const sessionId = request.headers.get("X-Session-Id");
        if (!tenantId || !sessionId) {
          return json({ success: false, error: "Missing tenant or session identity" }, 401);
        }
        const identity: SessionIdentity = { tenantId, docType: deps.docType, sessionId };
        const store = new PgAgentSessionStore(deps.pool, identity);

        try {
          if (request.method === "POST" && url.pathname === "/_internal/reset") {
            await store.clear();
            return json({ success: true });
          }

          if (request.method === "POST" && url.pathname === "/_internal/run") {
            const body = await request.json() as { instruction?: unknown };
            if (typeof body.instruction !== "string") {
              return json({ success: false, error: "instruction must be a string" }, 400);
            }

            const raw = await store.acquire(leaseSeconds);
            if (raw === null) {
              // CF 那边是排队等（DO 单线程里的 promise 链，等待不占资源）。
              // 跨副本没有等价物，所以这里快速失败，由调用方重试。
              return json({
                success: false,
                error: "Another agent run is in progress for this document",
              }, 409);
            }

            const headers = new Headers();
            for (const name of FORWARDED_HEADERS) {
              const value = request.headers.get(name);
              if (value) headers.set(name, value);
            }
            const editorFetcher: EditorFetcher = {
              fetch: (u, init) => deps.editor.get(deps.editor.idFromName(sessionId))
                .fetch(new Request(u, init)),
            };

            const session = new AgentSession<TQuery, TOp>({
              agent: deps.agent,
              platform: createHttpAgentPlatform<TQuery, TOp, undefined>({
                env: undefined,
                getEditorStub: () => editorFetcher,
                requestHeaders: () => headers,
                editorObjectName: () => sessionId,
              }),
              provider: deps.provider,
              history: decodeHistory(raw),
              docType: deps.docType,
            });

            const content: readonly AgentContentPart[] = [{ type: "text", text: body.instruction }];
            try {
              const outcome = await session.run(content);
              if (!outcome.ok) return json({ success: false, error: outcome.error }, 500);
              return json({
                success: true,
                data: { response: outcome.response, iterations: outcome.iterations },
              });
            } finally {
              // finally,不是成功路径。CF 的 #history.push 在 try 之前
              // (session.ts:81),失败那轮也留在历史里 —— 两条运行时在"重试时
              // 模型看到什么"上不一致是最难查的那种 bug。
              await store.release(encodeHistory(session.snapshotHistory()));
            }
          }

          return json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, 404);
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    }),
  };
}
```

若 `LocalNamespace` 在 `local-editor.ts` 里没有被 `export`，把它导出（它已经是 `export interface`，见 `local-editor.ts:37`）。

- [ ] **Step 4: 导出**

`packages/azure-sdk/src/index.ts` 加：

```ts
export { createLocalOperatorNamespace } from "./local-operator.js";
export type { LocalOperatorDeps } from "./local-operator.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/local-operator.test.ts`
Expected: PASS（8 条）

- [ ] **Step 6: 提交**

```bash
git add packages/azure-sdk/src/local-operator.ts packages/azure-sdk/src/index.ts packages/azure-sdk/tests/local-operator.test.ts
git commit -m "feat(azure): operator 命名空间 —— /run 与 /reset 真的能跑了

端点与 Cloudflare 逐字对齐(operator-do-agent.ts:83-107),只多一个状态码:抢不到
租约 409。CF 那边是排队等(DO 单线程里的 promise 链,等待不占资源),跨副本没有
等价物,所以快速失败由调用方重试。

每次请求新建 AgentSession 不缓存,与编辑器命名空间同理:2-5 副本无亲和,缓存在
进程里的会话下一次请求就落到别的副本上了。历史因此落库。

历史写回放 finally:CF 的 #history.push 在 try 之前(session.ts:81),失败那轮
也留在历史里 —— 两条运行时在"重试时模型看到什么"上不一致是最难查的那种 bug。"
```

---

### Task 6: 接线 —— `runDocTypeService` 与三个入口

**Files:**
- Modify: `packages/azure-sdk/src/doc-type-service.ts:75-90,208-232,268-296`
- Modify: `packages/azure-psd/src/main.ts`
- Modify: `packages/azure-docx/src/main.ts`
- Modify: `packages/azure-markdown/src/main.ts`
- Test: `packages/azure-sdk/tests/doc-type-service.test.ts`（追加）

**Interfaces:**
- Consumes: Task 5 的 `createLocalOperatorNamespace`
- Produces: `DocTypeServiceOptions` / `runDocTypeService` 的 `documentAgent?` 与 `llmProvider?` 两个可选字段

- [ ] **Step 1: 写失败的测试**

追加到 `packages/azure-sdk/tests/doc-type-service.test.ts`：

先把文件里已有的 `start(port, overrides)` 助手（`doc-type-service.test.ts:69-92`）
的 `overrides` 加两个透传字段——**只加透传，不动它现有的任何一行**：

```ts
async function start(
  port: number,
  overrides: {
    docType?: string;
    documentType?: DocumentType<any, any, any>;
    documentAgent?: any;
    llmProvider?: any;
  } = {},
) {
```

并在它内部的 `startDocTypeService({...})` 参数里追加：

```ts
    ...(overrides.documentAgent === undefined ? {} : { documentAgent: overrides.documentAgent }),
    ...(overrides.llmProvider === undefined ? {} : { llmProvider: overrides.llmProvider }),
```

然后追加用例（`PORT_*` 用文件里既有的端口分配写法，取一个未被占用的值）：

```ts
describe("agent 接线", () => {
  // 只给一半是那种"容器起来了、跑到第一次 /run 才炸"的配置错误。启动期响亮
  // 失败,不要等 15 分钟部署完看崩溃日志。
  it("只给 documentAgent 不给 llmProvider -> 启动期抛错", async () => {
    await expect(start(0, { documentAgent: { tools: [], instructions: "" } }))
      .rejects.toThrow(/llmProvider/);
  });

  it("只给 llmProvider 不给 documentAgent -> 启动期抛错", async () => {
    await expect(start(0, { llmProvider: { complete: async () => ({ text: "", toolCalls: [] }) } }))
      .rejects.toThrow(/documentAgent/);
  });

  it("两个都不给 -> operator 维持 501，不报错", async () => {
    const handle = await start(0);
    try {
      const res = await internal(handle.url, "tenant-1", `svc-${Date.now()}`, "run", {});
      expect(res.status).toBe(501);
    } finally {
      await handle.close();
    }
  });
});
```

`internal(...)` 是该文件里已有的助手（`:94`），负责拼内部路由与测试用能力票；
`start` 的 `port: 0` 交给系统分端口。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/doc-type-service.test.ts`
Expected: FAIL —— 传 `documentAgent` 是类型错误。

- [ ] **Step 3: 扩展 options 类型**

`packages/azure-sdk/src/doc-type-service.ts` 的 `DocTypeServiceOptions<TDoc, TQuery, TOp>` 加：

```ts
  /**
   * 给了就挂真 operator，省略则维持 501 stub —— markdown/docx/psd 可以分批接。
   *
   * 是**值**不是工厂：Azure 侧 `process.env` 在 `main.ts` 里就读得到，不需要
   * Cloudflare 那种"env 只在 DO 构造时才拿得到"的延迟构造。
   */
  documentAgent?: DocumentAgent<TQuery, TOp>;
  /** 与 `documentAgent` 必须同时给；只给一个在启动期抛错。 */
  llmProvider?: LlmProvider;
```

import 补上 `DocumentAgent`（`@unidocs/protocol`）与 `LlmProvider`（`@unidocs/doctype-server-common/agent`）。

- [ ] **Step 4: 在 `startDocTypeService` 里接上**

替换 `doc-type-service.ts:225` 的 `operator: createStubOperatorNamespace(),`。先在函数体靠前处加校验：

```ts
  // 只给一半是那种"容器起来了、跑到第一次 /run 才炸"的配置错误。启动期响亮
  // 失败，不要等部署完看崩溃日志。
  if ((options.documentAgent === undefined) !== (options.llmProvider === undefined)) {
    throw new Error(
      "documentAgent 与 llmProvider 必须同时提供：只给一个会让 operator 在第一次 /run 时才失败",
    );
  }
```

然后：

```ts
    operator: options.documentAgent && options.llmProvider
      ? createLocalOperatorNamespace({
        pool,
        editor: editorNamespace,
        agent: options.documentAgent,
        provider: options.llmProvider,
        docType,
      })
      : createStubOperatorNamespace(),
```

`editorNamespace` 是原本内联在 `createDocTypeHandler({ editor: ... })` 里的那个
`createLocalEditorNamespace(...)` 调用 —— 把它提成一个 `const editorNamespace = createLocalEditorNamespace(...)`
再在两处引用，避免建两份。

- [ ] **Step 5: `runDocTypeService` 透传**

签名加两个可选字段并透传给 `startDocTypeService`：

```ts
export async function runDocTypeService<TDoc, TQuery, TOp>(options: {
  docType: string;
  documentTypeFactory: DocumentTypeFactory<TDoc, TQuery, TOp>;
  defaultPort: number;
  documentAgent?: DocumentAgent<TQuery, TOp>;
  llmProvider?: LlmProvider;
}): Promise<void> {
```

并在 `startDocTypeService({...})` 的参数里加：

```ts
    ...(options.documentAgent === undefined ? {} : { documentAgent: options.documentAgent }),
    ...(options.llmProvider === undefined ? {} : { llmProvider: options.llmProvider }),
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/azure-sdk exec vitest run tests/doc-type-service.test.ts`
Expected: PASS

- [ ] **Step 7: 三个入口接线**

`packages/azure-psd/src/main.ts`——把顶部注释里"**Operator 在 Azure 上不可用**"那段改写成现状（operator 已接，历史落 Postgres，并发是租约 + 409），然后：

```ts
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createPsdAgent, createPsdDocumentType, createQwenImageEditor } from "@unidocs/doctype-psd";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
  // 与 Cloudflare 的条件化同形（cloudflare-psd/src/worker.ts:36-52）：没有 key
  // 就不注入 editor，于是工具表里没有 editPixels、提示词里也没有。
  // doctype-psd/src/agent.ts:23-26 记着这条的由来 —— 只条件化其中一个会得到一个
  // “提示词里有、工具表里没有”的幽灵工具，那是线上真实发生过的故障。
  documentAgent: createPsdAgent(
    process.env.IMAGE_EDIT_API_KEY
      ? {
        editor: createQwenImageEditor({
          apiKey: process.env.IMAGE_EDIT_API_KEY,
          observe: consoleObserver,
          ...(process.env.IMAGE_EDIT_MODEL ? { model: process.env.IMAGE_EDIT_MODEL } : {}),
          ...(process.env.IMAGE_EDIT_BASE_URL ? { baseUrl: process.env.IMAGE_EDIT_BASE_URL } : {}),
        }),
      }
      : {},
  ),
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
```

`packages/azure-docx/src/main.ts`——**没有图像模型那一段**，agent 是
`@unidocs/doctype-docx` 导出的 `docxAgent`（与 `cloudflare-docx/src/worker.ts:19,33`
用的是同一个）：

```ts
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createDocxDocumentType, docxAgent } from "@unidocs/doctype-docx";

runDocTypeService({
  docType: "docx",
  documentTypeFactory: createDocxDocumentType,
  defaultPort: 41810,
  documentAgent: docxAgent,
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
}).catch((err) => {
  console.error("azure-docx failed to start:", err);
  process.exit(1);
});
```

`packages/azure-markdown/src/main.ts` 同形，把 `docx` 换成 `markdown`、
`createDocxDocumentType` 换成 `createMarkdownDocumentType`、`docxAgent` 换成
`markdownAgent`（`@unidocs/doctype-markdown`，见 `cloudflare-markdown/src/worker.ts:19,33`），
`defaultPort` 用 `41800`。

- [ ] **Step 8: 全量回归**

Run: `pnpm typecheck && pnpm --filter @unidocs/azure-sdk test && pnpm --filter @unidocs/cloudflare-sdk test`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
git add packages/azure-sdk/src/doc-type-service.ts packages/azure-sdk/tests/doc-type-service.test.ts packages/azure-psd/src/main.ts packages/azure-docx/src/main.ts packages/azure-markdown/src/main.ts
git commit -m "feat(azure): 三个 doc service 接上 operator

documentAgent 与 llmProvider 是值不是工厂:Azure 侧 process.env 在 main.ts 就读
得到,不需要 Cloudflare 那种"env 只在 DO 构造时才拿得到"的延迟构造。两者必须同时
给,只给一个在启动期响亮失败 —— 否则是"容器起来了、跑到第一次 /run 才炸"。

都不给则维持 501 stub,所以三家可以分批接。

psd 的图像模型沿用 Cloudflare 的条件化(worker.ts:36-52):没有 IMAGE_EDIT_API_KEY
就不注入 editor,工具表与提示词一起去掉。只条件化其中一个会得到一个"提示词里有、
工具表里没有"的幽灵工具,那是线上真实发生过的故障(doctype-psd/src/agent.ts:23-26)。"
```

---

### Task 7: 基础设施 —— bicep 与部署参数

**Files:**
- Modify: `stacks/unidocs-azure/deploy/service.bicep`
- Modify: `stacks/unidocs-azure/deploy/deploy.mjs`
- Test: `tests/unit/scripts/`（若该目录下已有 deploy.mjs 的 parseArgs 测试则追加；没有则新建 `azure-deploy-args.test.mjs`）

**Interfaces:**
- Consumes: Task 6 读的 env 名
- Produces: `deploy.mjs` 新增 `--llm-api-key-secret`、`--image-edit-api-key-secret` 两个可选参数

- [ ] **Step 1: bicep 加参数与 env**

`service.bicep` 加参数（都可选、默认空串，空串表示不注入）：

```bicep
@description('Key Vault 里 Anthropic API key 的 secret 名。空 = 不接 agent，operator 维持 501。')
param llmApiKeySecretName string = ''

@description('模型名。空 = 用 anthropic.ts 的默认 claude-opus-5。')
param llmModel string = ''

@description('Key Vault 里图像编辑模型 API key 的 secret 名。空 = psd 没有 editPixels 工具。')
param imageEditApiKeySecretName string = ''

@description('图像编辑模型名。空 = 用 qwen-editor.ts 的默认 qwen-image-edit-plus。')
param imageEditModel string = ''
```

在容器的 `env` 数组里按现有那批 env 的同一写法追加 `LLM_API_KEY`、`LLM_MODEL`、
`IMAGE_EDIT_API_KEY`、`IMAGE_EDIT_MODEL` 四项；两个 key 走 `secretRef`（照
`CAPABILITY_PRIVATE_KEY_PKCS8` 在本文件里已有的 Key Vault secret 写法逐字模仿），
两个 model 是明文 `value`。空串时不追加该项。

- [ ] **Step 2: deploy.mjs 加参数**

在 `parseArgs` 的 `switch` 里加两个 case，并加进 `args` 的默认值（默认空串）：

```js
      case "--llm-api-key-secret": args.llmApiKeySecretName = argv[++i]; break;
      case "--llm-model": args.llmModel = argv[++i]; break;
      case "--image-edit-api-key-secret": args.imageEditApiKeySecretName = argv[++i]; break;
      case "--image-edit-model": args.imageEditModel = argv[++i]; break;
```

在 service 部署的 `parameters` 数组（`deploy.mjs:1020` 那一段）里追加四行，与
`casBaseUrl=${args.casBaseUrl}` 同一写法。

**不加必填校验**：省略就是"这个 doc type 不接 agent"，operator 维持 501。这与
`--cas-base-url` 的既有语义一致。

- [ ] **Step 3: 写测试**

```js
import { expect, test } from "vitest";
import { parseArgs } from "../../../stacks/unidocs-azure/deploy/deploy.mjs";

const base = [
  "--service", "psd",
  "--cas-stack-id", "cas_TESTTEST",
  "--cas-stack-issuer", "https://example.test/issuer",
  "--cas-capability-audience", "aud",
];

test("省略 agent 参数时是空串 —— 语义是不接 agent，不是报错", () => {
  const args = parseArgs(base);
  expect(args.llmApiKeySecretName).toBe("");
  expect(args.imageEditApiKeySecretName).toBe("");
});

test("给了就带进来", () => {
  const args = parseArgs([...base, "--llm-api-key-secret", "llm-key", "--image-edit-model", "wan2.6-image"]);
  expect(args.llmApiKeySecretName).toBe("llm-key");
  expect(args.imageEditModel).toBe("wan2.6-image");
});
```

- [ ] **Step 4: 跑测试**

Run: `pnpm exec vitest run tests/unit/scripts/azure-deploy-args.test.mjs`
Expected: PASS

- [ ] **Step 5: bicep 语法校验**

Run: `az bicep build --file stacks/unidocs-azure/deploy/service.bicep --stdout > /dev/null && echo OK`
Expected: `OK`（无错误输出）

- [ ] **Step 6: 提交**

```bash
git add stacks/unidocs-azure/deploy/service.bicep stacks/unidocs-azure/deploy/deploy.mjs tests/unit/scripts/azure-deploy-args.test.mjs
git commit -m "feat(azure): 部署参数接上 LLM 与图像模型的 env

四个参数都可选,空串 = 这个 doc type 不接 agent、operator 维持 501,与
--cas-base-url 的既有语义一致。两个 API key 走 Key Vault secretRef,两个 model
名是明文。"
```

---

## 收尾验证（全部任务完成后）

- [ ] `pnpm typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm test:local`（`tests/unit` + `tests/integration/cloudflare`；若本机 8787/8794 被 `pnpm dev` 占着会失败，属环境问题，如实报告不要杀进程）
- [ ] `pnpm test:azure`（Postgres 容器）
- [ ] `git diff --stat 主分支..HEAD -- packages/cloudflare-sdk/src/operator-do-agent.ts` 为空 —— CF 调用点未动的证据
- [ ] 两项变异验证的结果已贴出（Task 2 的编解码器、Task 4 的租约）
