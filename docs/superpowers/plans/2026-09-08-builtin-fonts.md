# 默认字体随包发行 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把默认字体（拉丁全量 + 中文 8105 字子集）带进安装包，让 `setText` 在任何新环境、任何新租户上零配置可用；同时把 `FontRegistry` 升为多来源门面，CAS 降格为其中一种来源。

**Architecture:** 中立层新增内部 SPI `FontProvider`（`list` / `read` / `blobFor`）与门面实现 `createFontRegistry({ providers })`，按顺序合成、后者按 postScriptName 覆盖前者。内置来源（`packages/fonts-builtin`）从包里读字节、`blobFor` 返回 `null`；租户来源（现有 Postgres 表 / Durable Object，SQL 与表结构一行不动）返回 SBlob。外层（`setText`、路由、接线）只认门面。

**Tech Stack:** TypeScript 5.9 / Node ≥ 24 / pnpm 11（workspace）、vitest 3、opentype.js（经 `scripts/psd-fonts-kit.ts`）、fonttools（仅人工重跑子集化时用）、esbuild（两个本地栈打包）、wrangler（CF 生产）。

**依据的设计文档：** `docs/superpowers/specs/2026-09-08-builtin-fonts-design.md`

## Global Constraints

- **分层不可破**：`packages/core`、`packages/doctype-*`、`packages/fonts-builtin` 是 cloud-neutral，不许出现任何 Cloudflare / Azure 类型；平台代码只许在 `cloudflare-*` / `azure-*` 包里。
- **`package-deps` 门禁**：任何含中立层包名的行，只放行以 `import type` 开头的写法。不要写 `export type { X } from "…"`——门禁按子串匹配，会误判。见 `packages/doctype-psd/src/text/registry.ts` 顶部那段注释。
- **裁定 R29 收窄后仍然成立**：租户登记表只存元数据、绝不碰 CAS。字节由预置脚本写进 CAS、由跑在编辑会话里的 effect 读。
- **裁定 R19 改写为**：字体字节可以进仓库，但只许是有明确公开字表依据的子集，单文件不超过约 3 MB；全量字体仍走 CAS。
- **既有存储一行不动**：Postgres 表 `font_registry`、`packages/azure-sdk/migrations/0005_font_registry.sql`、Cloudflare 的 `PsdFonts` DO 与它的 sqlite 表，全部保持原样。改的只是 TypeScript 这一侧的类名与它实现的接口。
- **`POST /tenants/{t}/fonts` 的行为与鉴权一字不改**，只改它接收的类型。
- **`install` 本次只声明不实现**，且必须声明为**可选成员**（`install?`），不许写只会抛异常的空壳。
- **命令**：`pnpm --filter <pkg> exec vitest run <path>` 跑单个测试文件；`pnpm -r build`；`pnpm typecheck`。
- **提交信息用中文**，正文说清「为什么」，不只说「做了什么」。

## 关键类型（贯穿全计划，名字与签名不许漂）

```ts
// packages/doctype-server-common/src/font-provider.ts
export interface FontIo { readonly readBlob: (blob: SBlob) => Promise<{ data: Uint8Array }>; }
export interface FontProvider {
  readonly id: string;
  list(): Promise<readonly FontEntry[]>;
  read(entry: FontEntry, io: FontIo): Promise<Uint8Array>;
  blobFor(entry: FontEntry): SBlob | null;
}

// packages/doctype-server-common/src/font-registry.ts
export interface RegisteredFont { readonly entry: FontEntry; readonly source: string; }
export type FontIndex = ReadonlyMap<string, RegisteredFont>;
export interface FontRegistry {
  index(): Promise<FontIndex>;
  read(font: RegisteredFont, io: FontIo): Promise<Uint8Array>;
  blobFor(font: RegisteredFont): SBlob | null;
  install?(entry: FontEntry): Promise<void>;
}
export function createFontRegistry(options: {
  readonly providers: readonly FontProvider[];
  readonly now?: () => number;
}): FontRegistry;

// packages/fonts-builtin/src/index.ts
export type BuiltinFontLoader = (fileName: string) => Promise<Uint8Array>;
export interface BuiltinFontRecord { readonly entry: FontEntry; readonly file: string; }
export const BUILTIN_FONTS: readonly BuiltinFontRecord[];   // src/fonts.generated.ts 产出
export const BUILTIN_FALLBACKS: readonly string[];          // ["NotoSans-Regular", "NotoSansSC-Regular"]
export function createBuiltinFontProvider(options: { readonly load: BuiltinFontLoader }): FontProvider;
```

---

### Task 1: `FontProvider` 契约与 `createFontRegistry` 门面

纯逻辑，用内存假 provider 就能测完，先做它能让后面每一步都有地方挂。

**Files:**
- Create: `packages/doctype-server-common/src/font-provider.ts`
- Modify: `packages/doctype-server-common/src/font-registry.ts`（新增门面类型与实现；`FontEntry` / `fontEntryProblem` 原样保留，只改 `hash` 那段注释）
- Modify: `packages/doctype-server-common/src/index.ts:2`（导出新模块）
- Test: `packages/doctype-server-common/tests/font-registry-compose.test.ts`

**Interfaces:**
- Consumes: 既有 `FontEntry`、`FontCoverage`、`fontEntryProblem`（`font-registry.ts`）；`SBlob`（`@unidocs/protocol`）
- Produces: `FontIo`、`FontProvider`、`WritableFontProvider`、`casFontBytes`、`RegisteredFont`、`FontIndex`、`FontRegistry`、`createFontRegistry`——签名见上方「关键类型」，后续每个 Task 都按那份签名写

- [ ] **Step 1: 写失败的测试**

创建 `packages/doctype-server-common/tests/font-registry-compose.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { FontEntry, FontIo, FontProvider } from "../src/index.js";
import { createFontRegistry } from "../src/index.js";

const entry = (postScriptName: string, hash: string): FontEntry => ({
  postScriptName,
  family: postScriptName.split("-")[0]!,
  hash,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
});

/** 只读来源：blobFor 返回 null，字节直接给。 */
function fakeBuiltin(entries: readonly FontEntry[], bytes = 1): FontProvider {
  return {
    id: "builtin",
    list: async () => entries,
    read: async e => new Uint8Array([bytes, e.postScriptName.length]),
    blobFor: () => null,
  };
}

/** CAS 来源：blobFor 返回 SBlob，read 必须经过 io.readBlob。 */
function fakeTenant(entries: readonly FontEntry[]): FontProvider {
  return {
    id: "tenant",
    list: async () => entries,
    read: async (e, io) => (await io.readBlob(createSBlob(e.hash))).data,
    blobFor: e => createSBlob(e.hash),
  };
}

const io: FontIo = { readBlob: async blob => ({ data: new Uint8Array([0xca, Number.parseInt(blob.hash.slice(0, 2), 16)]) }) };

describe("createFontRegistry", () => {
  it("按顺序合成，后者按 postScriptName 覆盖前者", async () => {
    const registry = createFontRegistry({
      providers: [
        fakeBuiltin([entry("NotoSans-Regular", "a".repeat(64)), entry("NotoSansSC-Regular", "b".repeat(64))]),
        fakeTenant([entry("NotoSansSC-Regular", "c".repeat(64))]),
      ],
    });
    const index = await registry.index();
    expect([...index.keys()].sort()).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
    expect(index.get("NotoSans-Regular")!.source).toBe("builtin");
    // 同名被后来的租户来源盖掉 —— 这就是"用户主动装 external 字体"的扩展点。
    expect(index.get("NotoSansSC-Regular")!.source).toBe("tenant");
    expect(index.get("NotoSansSC-Regular")!.entry.hash).toBe("c".repeat(64));
  });

  it("read 按来源分发：内置不碰 io，租户经 io.readBlob", async () => {
    const registry = createFontRegistry({
      providers: [fakeBuiltin([entry("A-Regular", "a".repeat(64))]), fakeTenant([entry("B-Regular", "b".repeat(64))])],
    });
    const index = await registry.index();
    expect(await registry.read(index.get("A-Regular")!, io)).toEqual(new Uint8Array([1, 9]));
    expect(await registry.read(index.get("B-Regular")!, io)).toEqual(new Uint8Array([0xca, 0xbb]));
  });

  it("blobFor：内置返回 null，租户返回 SBlob", async () => {
    const registry = createFontRegistry({
      providers: [fakeBuiltin([entry("A-Regular", "a".repeat(64))]), fakeTenant([entry("B-Regular", "b".repeat(64))])],
    });
    const index = await registry.index();
    expect(registry.blobFor(index.get("A-Regular")!)).toBeNull();
    expect(registry.blobFor(index.get("B-Regular")!)!.hash).toBe("b".repeat(64));
  });

  it("索引缓存 60 秒；到期后重新合成", async () => {
    let calls = 0;
    const counting: FontProvider = {
      id: "tenant",
      list: async () => { calls++; return [entry("A-Regular", "a".repeat(64))]; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    let clock = 0;
    const registry = createFontRegistry({ providers: [counting], now: () => clock });
    await registry.index();
    await registry.index();
    expect(calls).toBe(1);
    clock = 60_000;
    await registry.index();
    expect(calls).toBe(2);
  });

  it("缓存的是 Promise：并发两次只打一次后端", async () => {
    let calls = 0;
    const slow: FontProvider = {
      id: "tenant",
      list: async () => { calls++; await Promise.resolve(); return []; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    const registry = createFontRegistry({ providers: [slow], now: () => 0 });
    await Promise.all([registry.index(), registry.index()]);
    expect(calls).toBe(1);
  });

  it("失败不留在缓存里：一次抖动不会被记住一整个 TTL", async () => {
    let calls = 0;
    const flaky: FontProvider = {
      id: "tenant",
      list: async () => { calls++; if (calls === 1) throw new Error("boom"); return []; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    const registry = createFontRegistry({ providers: [flaky], now: () => 0 });
    await expect(registry.index()).rejects.toThrow("boom");
    await expect(registry.index()).resolves.toBeInstanceOf(Map);
    expect(calls).toBe(2);
  });

  it("一个来源挂了不拖垮其它来源，但必须报出来", async () => {
    // 这条是设计文档「错误处理」里那句"租户 provider 不可达：只影响租户那一层，
    // 内置那一层仍然可用"的守卫。静默吞掉是不行的 —— 租户装的字体凭空消失、
    // 排出来的字换了个字形而没有任何信号，正是这条链一直在消灭的故障形态。
    const reported: Array<{ id: string; message: string }> = [];
    const registry = createFontRegistry({
      providers: [
        fakeBuiltin([entry("A-Regular", "a".repeat(64))]),
        { id: "tenant", list: async () => { throw new Error("DO unreachable"); },
          read: async () => new Uint8Array(), blobFor: () => null },
      ],
      onProviderError: (id, error) => reported.push({ id, message: (error as Error).message }),
    });
    const index = await registry.index();
    expect([...index.keys()]).toEqual(["A-Regular"]);
    expect(reported).toEqual([{ id: "tenant", message: "DO unreachable" }]);
  });

  it("没配 onProviderError 时，来源出错就整体失败 —— 不静默降级", async () => {
    const registry = createFontRegistry({
      providers: [{ id: "tenant", list: async () => { throw new Error("boom"); },
        read: async () => new Uint8Array(), blobFor: () => null }],
    });
    await expect(registry.index()).rejects.toThrow("boom");
  });

  it("install 本次不提供 —— 可选成员，不是会抛的空壳", () => {
    const registry = createFontRegistry({ providers: [] });
    expect(registry.install).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-compose.test.ts`
Expected: FAIL，报 `createFontRegistry` 不存在（`does not provide an export named 'createFontRegistry'`）

- [ ] **Step 3: 写 `font-provider.ts`**

创建 `packages/doctype-server-common/src/font-provider.ts`：

```ts
/**
 * 字体来源的内部 SPI。
 *
 * **它不是外层概念** —— 外层（setText、路由、接线）只认 `FontRegistry` 那个门面。
 * 把 provider 数组交给外层，外层就会开始依赖它的顺序和成员，将来加第四种来源
 * （系统字体目录、字体 CDN）要改的地方会散开。
 */
import type { SBlob } from "@unidocs/protocol";
import type { FontEntry } from "./font-registry.js";

/**
 * effect 侧的读字节能力。
 *
 * 收窄成一个字段而不是把整个 `EffectContext` 拖进中立契约：这里只需要读 blob，
 * 而 `EffectContext` 还带着 query / makeSBlob 一大串跟字体无关的东西。
 * `EffectContext` 结构上满足它，调用方直接传 `ctx` 即可。
 */
export interface FontIo {
  readonly readBlob: (blob: SBlob) => Promise<{ data: Uint8Array }>;
}

export interface FontProvider {
  /** 稳定标识（"builtin" / "tenant"）。它会进索引条目的 `source` ——
   *  排查"为什么这个字用的不是我装的那套"时唯一的抓手。 */
  readonly id: string;

  /** 这个来源提供哪些字体。只返回元数据，不读字节。 */
  list(): Promise<readonly FontEntry[]>;

  /** 取字节。`entry` 必须是本来源自己 `list` 出来的那一条。
   *  CAS 来源要用 `io.readBlob` 带着会话身份去读，内置来源忽略 `io`。 */
  read(entry: FontEntry, io: FontIo): Promise<Uint8Array>;

  /** 这条要不要被文档钉住。CAS 来源返回 SBlob（`doc.fonts` 靠它保活），
   *  内置来源返回 null —— 字节随包走，没有可回收的对象。 */
  blobFor(entry: FontEntry): SBlob | null;
}
```

- [ ] **Step 4: 在 `font-registry.ts` 里加门面**

在 `packages/doctype-server-common/src/font-registry.ts` **文件末尾**追加（`FontEntry`、`FontCoverage`、`fontEntryProblem` 原封不动留在原处）：

```ts
import type { SBlob } from "@unidocs/protocol";
import type { FontIo, FontProvider } from "./font-provider.js";

/** 索引里的一条。`source` 是 provider id：冲突解决之后，这条到底来自哪个来源。 */
export interface RegisteredFont {
  readonly entry: FontEntry;
  readonly source: string;
}

export type FontIndex = ReadonlyMap<string, RegisteredFont>;

/**
 * 字体的门面 —— **外层唯一要认识的东西**。字体从哪来、同名冲突谁赢、字节怎么取、
 * 装到哪儿，全部收在实现里。
 */
export interface FontRegistry {
  /** 合成、去冲突之后的索引，按 postScriptName。带 TTL 缓存。 */
  index(): Promise<FontIndex>;

  /** 取字节。内部按这条的来源分发。
   *  收 `RegisteredFont` 而不是名字：调用方本来就是从 `index()` 里取出来的，
   *  收名字就要在这里再查一次索引 —— 而索引是异步的，同步的 `blobFor` 查不了。 */
  read(font: RegisteredFont, io: FontIo): Promise<Uint8Array>;

  /** 这条要不要被文档钉住。转发给它的来源。 */
  blobFor(font: RegisteredFont): SBlob | null;

  /**
   * 装一套字体：内部路由到可写的那个来源，一个都没有时明确失败。
   *
   * **本次不实现。** 声明成可选，于是合成实现可以干脆不提供它 —— 必选会逼出一个
   * 只会抛异常的空壳，那既是死代码，也在类型上骗人（签名说它能装，实际调用必炸）。
   * 将来补实现时把 `?` 去掉，所有调用点会当场变红。
   *
   * 缺的是**保活那一半**，不是权限：会话里能用 `ctx.makeSBlob` 往 CAS 写字节，但
   * 只被租户登记表引用的字体 24 小时租约到期后会被 GC 收走（见
   * docs/psd-text-layers.md §5.4「看起来好了一天，然后凭空消失」）。
   */
  install?(entry: FontEntry): Promise<void>;
}

/**
 * 索引缓存的存活时长。
 *
 * `setText` 每调用一次就取一次索引，而索引几乎不变 —— 每次排版前多打一次后端纯属
 * 浪费。反过来，永久缓存会让"新登记一套字体"在所有已经热起来的 operator DO 里都
 * 看不见，直到实例被回收，而 operator DO 是跨请求存活的。一分钟的上限把这个窗口
 * 关掉，代价是每分钟至多多打一次后端。
 */
const INDEX_TTL_MS = 60_000;

export function createFontRegistry(options: {
  readonly providers: readonly FontProvider[];
  readonly now?: () => number;
  /**
   * 某个来源 `list()` 失败时的去处。
   *
   * **配了它就 fail-soft**：那个来源这一轮被跳过，其余来源照常合成 —— 租户的
   * 字体 DO 打不通时，内置那一档仍然可用，`setText` 不整体失效。
   * **没配就 fail-hard**：整个 `index()` 拒绝。默认不降级是刻意的 —— 静默吞掉
   * 一个来源，表现是"租户装的字体凭空消失、字换了个字形"，没有任何信号。
   * 降级必须是调用方明确选的，并且它得说清降级之后往哪儿喊。
   */
  readonly onProviderError?: (providerId: string, error: unknown) => void;
}): FontRegistry {
  const now = options.now ?? (() => Date.now());
  const providerById = new Map(options.providers.map(p => [p.id, p]));
  let cached: { at: number; index: Promise<FontIndex> } | null = null;

  const compose = async (): Promise<FontIndex> => {
    const merged = new Map<string, RegisteredFont>();
    // 顺序即优先级：后面的 provider 按 postScriptName 覆盖前面的。租户装的
    // 同名字体盖掉内置的，这就是"用户主动装 external 字体"的扩展点。
    for (const provider of options.providers) {
      let entries: readonly FontEntry[];
      try {
        entries = await provider.list();
      } catch (error) {
        if (!options.onProviderError) throw error;
        options.onProviderError(provider.id, error);
        continue;
      }
      for (const entry of entries) {
        merged.set(entry.postScriptName, { entry, source: provider.id });
      }
    }
    return merged;
  };

  const providerOf = (font: RegisteredFont): FontProvider => {
    const provider = providerById.get(font.source);
    if (!provider) {
      // 只可能是调用方拿了另一个 registry 实例的索引条目过来。静默返回空字节
      // 会表现成"这套字体解析失败"，查起来毫无线索。
      throw new Error(`Unknown font source ${JSON.stringify(font.source)}`);
    }
    return provider;
  };

  return {
    index: () => {
      if (cached && now() - cached.at < INDEX_TTL_MS) return cached.index;
      // 缓存的是 Promise 而不是结果：一个 operator DO 里并发的两次 setText 只该
      // 打一次后端。失败不留在缓存里 —— 否则一次网络抖动会被整整记住一个 TTL，
      // 期间每次 setText 都拿同一个 rejected promise。
      const index = compose();
      const record = { at: now(), index };
      cached = record;
      index.catch(() => { if (cached === record) cached = null; });
      return index;
    },
    read: (font, io) => providerOf(font).read(font.entry, io),
    blobFor: font => providerOf(font).blobFor(font.entry),
  };
}
```

同时把 `FontEntry.hash` 那段注释改成（含义从"在 CAS 里"改成"字节的内容哈希"）：

```ts
  /** 这份字体字节的内容哈希。**不代表它在 CAS 里** —— 内置字体的字节随包走，
   *  同样有合法的哈希。"在不在 CAS 里"由 provider 的 `blobFor()` 回答。 */
  readonly hash: string;
```

在同一个文件（`font-provider.ts`）末尾再加：

```ts
/**
 * CAS 来源的读取语义。两个平台**逐字相同** —— `createSBlob` 住在中立的
 * `@unidocs/svalue-codec`，两个平台 SDK 只是再导出它，这里没有任何平台差异。
 *
 * 抽出来不是为了少写八行，是为了让"两边一致"不依赖两个人各自记得。它**不是**
 * 一个存储层抽象：平台各自实现的仍然是完整的 `WritableFontProvider`，只是把这
 * 两个成员摊开来复用。
 */
export interface WritableFontProvider extends FontProvider {
  /** 幂等：同一个 postScriptName 重登记覆盖旧的一条，不是报冲突 ——
   *  预置脚本每次跑都会把配置里的全套字体登记一遍。
   *
   *  今天只有租户那一档实现它（`POST /tenants/{t}/fonts` 与
   *  `scripts/seed-psd-fonts.mjs` 靠它）；内置来源不实现 —— 字节随包走，装不进去。
   *  门面的 `FontRegistry.install` 将来就路由到这里。 */
  put(entry: FontEntry): Promise<void>;
}

export const casFontBytes = {
  /** 字节在 CAS，由跑在编辑会话里的 effect 带着会话身份去读（裁定 R29）。 */
  read: async (entry: FontEntry, io: FontIo): Promise<Uint8Array> =>
    (await io.readBlob(createSBlob(entry.hash))).data,
  blobFor: (entry: FontEntry): SBlob => createSBlob(entry.hash),
} as const;
```

顶部 import 补一行：`import { createSBlob } from "@unidocs/svalue-codec";`

- [ ] **Step 5: 导出新模块**

修改 `packages/doctype-server-common/src/index.ts`，在第 2 行 `export * from "./font-registry.js";` 之前插入：

```ts
export * from "./font-provider.js";
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-compose.test.ts`
Expected: PASS，7 条全绿

- [ ] **Step 7: 提交**

```bash
git add packages/doctype-server-common/src/font-provider.ts \
        packages/doctype-server-common/src/font-registry.ts \
        packages/doctype-server-common/src/index.ts \
        packages/doctype-server-common/tests/font-registry-compose.test.ts
git commit -m "feat(fonts): FontRegistry 升为多来源门面, FontProvider 作为内部 SPI

外层只认门面 —— 把 provider 数组交给外层, 外层就会开始依赖它的顺序和成员,
将来加第四种来源要改的地方会散开。install 声明成可选成员而不是必选: 必选会
逼出一个只会抛异常的空壳, 那既是死代码, 也在类型上骗人。"
```

---

### Task 2: 内置字体资产 —— 字表、子集、生成的索引

产出二进制。这一步跑完，仓库里就有了"随包走"的那套字体。

**Files:**
- Create: `packages/fonts-builtin/package.json`
- Create: `packages/fonts-builtin/tsconfig.json`
- Create: `packages/fonts-builtin/charset/tongyong-guifan-8105.txt`（8105 行，每行一个字）
- Create: `packages/fonts-builtin/fonts/NotoSans-Regular.ttf`（621 KB，从仓库根 `fonts/` 复制，全量不子集化）
- Create: `packages/fonts-builtin/fonts/NotoSansSC-Regular.subset.otf`（约 1.91 MB，脚本产出）
- Create: `packages/fonts-builtin/scripts/build-subset.py`
- Create: `packages/fonts-builtin/scripts/generate-index.mjs`
- Create: `packages/fonts-builtin/src/fonts.generated.ts`（脚本产出）
- Create: `packages/fonts-builtin/OFL.txt`（从仓库根 `OFL.txt` 复制）
- Create: `packages/fonts-builtin/README.md`
- Modify: `tsconfig.json`（根，`references` 加一项）
- Modify: `pnpm-workspace.yaml`（若它不是 `packages/*` 通配则要加）
- Test: `packages/fonts-builtin/tests/generated-index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FontEntry`；`scripts/psd-fonts-kit.ts` 的 `loadKit()`（提供 `parseFontFace` / `fontCoverage`）
- Produces: `BUILTIN_FONTS: readonly BuiltinFontRecord[]`（`src/fonts.generated.ts`），`BuiltinFontRecord = { entry: FontEntry; file: string }`，其中 `file` 是 `fonts/` 下的**文件名**（不含目录）

- [ ] **Step 1: 建包骨架**

创建 `packages/fonts-builtin/package.json`：

```json
{
  "name": "@unidocs/fonts-builtin",
  "version": "0.1.0",
  "description": "Default fonts shipped inside the install package (Noto Sans + subsetted Noto Sans SC)",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
    "./fonts/*": "./fonts/*",
    "./package.json": "./package.json"
  },
  "files": ["dist", "fonts"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc -b",
    "clean": "rimraf --glob dist \"*.tsbuildinfo\""
  },
  "dependencies": {
    "@unidocs/doctype-server-common": "workspace:*",
    "@unidocs/protocol": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "publishConfig": {
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
      "./fonts/*": "./fonts/*",
      "./package.json": "./package.json"
    }
  }
}
```

`"files": ["dist", "fonts"]` 是**关键**：`pnpm deploy --prod`（Dockerfile 用的那条）严格按它裁剪，漏了 `fonts` 镜像里就没有字节，症状与"从没灌过字体"一模一样。

创建 `packages/fonts-builtin/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "lib": ["ES2024"],
    "types": []
  },
  "include": ["src"],
  "references": [
    { "path": "../doctype-server-common" },
    { "path": "../protocol" }
  ]
}
```

在根 `tsconfig.json` 的 `references` 数组里，紧跟 `{ "path": "packages/doctype-server-common" }` 之后加一项：

```json
    { "path": "packages/fonts-builtin" },
```

- [ ] **Step 2: 取字表并提交**

字表来源已核实：两个互不相干的仓库各存一份，**内容逐字相同**，正好 8105 字（7832 在 CJK 基本区、77 在扩展 A、196 在扩展 B），且 `NotoSansSC-Regular` 一个不缺。

```bash
cd packages/fonts-builtin
mkdir -p charset fonts scripts src tests
curl -sSL -o /tmp/a.txt "https://raw.githubusercontent.com/iDvel/The-Table-of-General-Standard-Chinese-Characters/master/1-8105%E7%BA%AF%E6%B1%89%E5%AD%97%EF%BC%88%E6%8C%89%E9%A1%BA%E5%BA%8F%E6%8E%92%E5%88%97%EF%BC%89.txt"
curl -sSL -o /tmp/b.txt "https://raw.githubusercontent.com/jaywcjlove/table-of-general-standard-chinese-characters/main/data/characters.txt"
node -e '
const fs=require("fs");
const pick=p=>[...fs.readFileSync(p,"utf8")].filter(c=>!/\s/.test(c));
const A=pick("/tmp/a.txt"), B=pick("/tmp/b.txt");
if (A.join("") !== B.join("")) throw new Error("两份字表不一致，停手");
if (A.length !== 8105) throw new Error(`字数不是 8105 而是 ${A.length}`);
if (new Set(A).size !== 8105) throw new Error("字表里有重复");
fs.writeFileSync("charset/tongyong-guifan-8105.txt", A.join("\n") + "\n");
console.log("已写 charset/tongyong-guifan-8105.txt，8105 字");
'
```

两份必须逐字相同才写盘——**这就是这份数据的可信来源**：两个互不相干的维护者各自录入、结果一致。

- [ ] **Step 3: 放字体原件与许可证**

```bash
cp ../../fonts/NotoSans-Regular.ttf fonts/NotoSans-Regular.ttf
cp ../../OFL.txt OFL.txt
ls -la fonts/ OFL.txt
```

Expected: `NotoSans-Regular.ttf` 约 621572 字节。

拉丁那套**全量提交、不子集化**：它 621 KB，而它那 2436 个非拉丁码位（希腊、西里尔、符号）真要砍也只省 400 KB，换不来多一条要维护的生成路径。

CJK 那套的**原件不进仓库**（8.33 MB，仍受 R19 约束），只提交子集。原件由跑脚本的人自备，仓库根的 `fonts/` 已 gitignore。

- [ ] **Step 4: 写子集化脚本**

创建 `packages/fonts-builtin/scripts/build-subset.py`：

```python
#!/usr/bin/env python3
"""从全量 NotoSansSC-Regular.otf 生成本包内置的子集。

**这个脚本不在构建流程里。** 它是人工升级字体版本时跑一次的工具，产物（字节 +
src/fonts.generated.ts）提交进仓库。这样构建既不依赖 Python 也不依赖公网，
`pnpm deploy --prod` 直接把字节带进镜像。

用法（需要 fonttools）：
    python3 -m pip install fonttools brotli
    python3 scripts/build-subset.py ../../fonts/NotoSansSC-Regular.otf
然后跑 `node scripts/generate-index.mjs` 重新生成索引。

所有影响输出的参数都写死在下面，不接受命令行覆盖 —— 「重跑一次得到逐字节相同的
结果」这条性质，是靠没有可变参数保证的。
"""
import sys, pathlib
from fontTools import subset

HERE = pathlib.Path(__file__).resolve().parent
PKG = HERE.parent
OUT = PKG / "fonts" / "NotoSansSC-Regular.subset.otf"

# 汉字之外还要带的码位：ASCII 可打印、Latin-1 补充、通用标点、CJK 标点、全角形式。
# 少了这些，中文里的逗号句号引号会掉出子集，而掉出去的结果是不报错的空白字形。
BASE = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
        + list(range(0x2000, 0x2070)) + list(range(0x3000, 0x3040))
        + list(range(0xFF00, 0xFFF0)))

def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("用法: build-subset.py <全量 NotoSansSC-Regular.otf 的路径>")
    src = pathlib.Path(sys.argv[1]).resolve()
    chars = [c for c in (PKG / "charset" / "tongyong-guifan-8105.txt").read_text("utf-8").split()]
    if len(chars) != 8105:
        raise SystemExit(f"字表应有 8105 字，实际 {len(chars)}")
    unicodes = sorted(set(BASE) | {ord(c) for c in chars})
    subset.main([
        str(src),
        f"--output-file={OUT}",
        "--unicodes=" + ",".join(f"U+{c:04X}" for c in unicodes),
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
    ])
    print(f"{OUT.name}: {OUT.stat().st_size:,} bytes，覆盖 {len(unicodes)} 个码位")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 跑子集化**

```bash
cd packages/fonts-builtin
python3 -m pip install --quiet fonttools brotli
python3 scripts/build-subset.py ../../fonts/NotoSansSC-Regular.otf
```

Expected: 打印约 `NotoSansSC-Regular.subset.otf: 2,002,388 bytes，覆盖 8712 个码位`。
体积必须 < 3 MB（Global Constraints 里 R19 改写后的上限），且 < 16 MiB（`scripts/seed-psd-fonts.mjs` 的 `MAX_FONT_BYTES`）。

- [ ] **Step 6: 写索引生成脚本**

创建 `packages/fonts-builtin/scripts/generate-index.mjs`：

```js
/**
 * 从 fonts/ 下的字节生成 src/fonts.generated.ts。
 *
 * **coverage / unitsPerEm / family / hash 全部从字节解析，一个都不许手写。**
 * 解析用的是 `scripts/psd-fonts-kit.ts` 的 `fontCoverage`/`parseFontFace` ——
 * 与 `seed-psd-fonts.mjs` 登记字体时用的**同一份实现**。第二份实现意味着两边
 * 对"覆盖了哪些码位"的判断可能分叉，而分叉的表现是某个字被判成"这套字体不认识"
 * 然后静默掉进回退链。
 *
 * 索引在构建期生成并提交、运行期零解析：一个 1.9 MB 的 CFF 字体每次进程启动解析
 * 一遍是白花的钱。
 *
 * 用法：node scripts/generate-index.mjs
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../../scripts/psd-fonts-kit.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

/** 要装哪几套。顺序即回退链顺序：拉丁在前、中文在后 —— 前者不覆盖 CJK，
 *  汉字自然落到后者。 */
const PLAN = [
  { file: "NotoSans-Regular.ttf", postScriptName: "NotoSans-Regular", family: "Noto Sans" },
  { file: "NotoSansSC-Regular.subset.otf", postScriptName: "NotoSansSC-Regular", family: "Noto Sans SC" },
];

const kit = await loadKit();
const records = [];
for (const font of PLAN) {
  const bytes = new Uint8Array(await readFile(join(PKG, "fonts", font.file)));
  const face = kit.parseFontFace(bytes);
  if (face.postScriptName !== font.postScriptName) {
    throw new Error(`${font.file} 解析出的 postScriptName 是 "${face.postScriptName}"，计划里写的是 "${font.postScriptName}"`);
  }
  const coverage = kit.fontCoverage(face);
  if (coverage.length === 0) throw new Error(`${font.file} 一个码位都不覆盖`);
  records.push({
    file: font.file,
    entry: {
      postScriptName: font.postScriptName,
      family: font.family,
      hash: createHash("sha256").update(bytes).digest("hex"),
      unitsPerEm: face.unitsPerEm,
      coverage,
    },
  });
}

const body = `/**
 * 由 scripts/generate-index.mjs 从 fonts/ 下的字节生成。**不要手改。**
 *
 * 改了字体文件就重跑：
 *   python3 scripts/build-subset.py <全量 NotoSansSC-Regular.otf>
 *   node scripts/generate-index.mjs
 * tests/generated-index.test.ts 会从字节重新解析并逐字段比对，手改会当场变红。
 */
import type { BuiltinFontRecord } from "./types.js";

export const BUILTIN_FONTS: readonly BuiltinFontRecord[] = Object.freeze(${
  JSON.stringify(records, null, 2)
} as const);
`;
await writeFile(join(PKG, "src", "fonts.generated.ts"), body);
console.log(`已写 src/fonts.generated.ts：${records.map(r => `${r.entry.postScriptName}(${r.entry.coverage.length} 段)`).join(", ")}`);
```

- [ ] **Step 7: 写类型与入口（生成物要引用它）**

`BuiltinFontRecord` 单独放一个文件，**不放 `index.ts`**：生成物要 import 它，而
`index.ts` 又要 re-export 生成物 —— 放一起就是一个 `index → generated → index` 的环。
今天它只是 `import type`（编译期擦除，运行时无环），但把一个环留在那儿等着有人加一行
值导入，是没必要的债。

创建 `packages/fonts-builtin/src/types.ts`：

```ts
import type { FontEntry } from "@unidocs/doctype-server-common";

export interface BuiltinFontRecord {
  readonly entry: FontEntry;
  /** `fonts/` 下的文件名，不含目录。字节怎么从包里拿出来由平台适配器决定。 */
  readonly file: string;
}
```

创建 `packages/fonts-builtin/src/index.ts`：

```ts
/**
 * 随安装包发行的默认字体。
 *
 * 它存在的理由是「即装即用」：在它之前，`setText` 能不能工作取决于有没有人对着
 * 这个环境、这个租户跑过一次 `scripts/seed-psd-fonts.mjs`。没跑过的表现不是报错，
 * 是中文层整层画不出来。
 *
 * 字节随包走、不进 CAS，所以它对应的 provider `blobFor()` 返回 null，
 * 排出来的字也不进 `doc.fonts` —— 没有可回收的对象，不需要保活。
 */
export type { BuiltinFontRecord } from "./types.js";
export { BUILTIN_FONTS } from "./fonts.generated.js";
```

- [ ] **Step 8: 生成索引**

```bash
cd packages/fonts-builtin && node scripts/generate-index.mjs
```

Expected: 打印两套字体各自的 coverage 段数（`NotoSans-Regular` 约 200+ 段，`NotoSansSC-Regular` 数百段）。

- [ ] **Step 9: 写生成物自洽测试**

创建 `packages/fonts-builtin/tests/generated-index.test.ts`：

```ts
/**
 * 守住「生成物与字节不漂移」。
 *
 * 这条测试防的不是 generate-index.mjs 写错了 —— 它防的是**有人手改了
 * fonts.generated.ts**，或者**换了字体文件但忘了重跑生成脚本**。两种情况的
 * 线上表现都是某些字被判成"这套字体不认识"然后静默掉进回退链，不报错。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_FONTS } from "../src/index.js";
import { loadKit } from "../../../scripts/psd-fonts-kit.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

describe("BUILTIN_FONTS", () => {
  it("两套字体：拉丁在前、中文在后（顺序即回退链顺序）", () => {
    expect(BUILTIN_FONTS.map(r => r.entry.postScriptName))
      .toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });

  for (const record of BUILTIN_FONTS) {
    it(`${record.entry.postScriptName}：索引与字节逐字段对得上`, async () => {
      const bytes = new Uint8Array(await readFile(join(PKG, "fonts", record.file)));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.entry.hash);
      const kit = await loadKit();
      const face = kit.parseFontFace(bytes);
      expect(face.postScriptName).toBe(record.entry.postScriptName);
      expect(face.unitsPerEm).toBe(record.entry.unitsPerEm);
      expect(kit.fontCoverage(face)).toEqual(record.entry.coverage);
    });
  }

  it("中文那套覆盖字表里全部 8105 个字，一个不漏", async () => {
    const chars = (await readFile(join(PKG, "charset", "tongyong-guifan-8105.txt"), "utf8")).split(/\s+/).filter(Boolean);
    expect(chars).toHaveLength(8105);
    const sc = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSansSC-Regular")!;
    const covers = (cp: number) => sc.entry.coverage.some(([a, b]) => cp >= a && cp <= b);
    const missing = chars.filter(c => !covers(c.codePointAt(0)!));
    expect(missing).toEqual([]);
  });

  it("拉丁那套覆盖全部 ASCII 可打印字符", () => {
    const latin = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSans-Regular")!;
    const covers = (cp: number) => latin.entry.coverage.some(([a, b]) => cp >= a && cp <= b);
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(covers(cp), `U+${cp.toString(16)}`).toBe(true);
  });

  it("每套字体的体积都在 R19 改写后的 3 MB 上限内", async () => {
    for (const record of BUILTIN_FONTS) {
      const bytes = await readFile(join(PKG, "fonts", record.file));
      expect(bytes.byteLength, record.file).toBeLessThan(3 * 1024 * 1024);
    }
  });
});
```

- [ ] **Step 10: 跑测试**

```bash
pnpm install
pnpm --filter @unidocs/fonts-builtin exec vitest run tests/generated-index.test.ts
```

Expected: PASS，7 条全绿（2 套字体各一条 + 5 条通用）。

- [ ] **Step 11: 写包内 README**

创建 `packages/fonts-builtin/README.md`：

```markdown
# @unidocs/fonts-builtin

随安装包发行的默认字体。`setText` 因此在任何新环境、任何新租户上零配置可用 ——
在它之前，那取决于有没有人对着这个环境跑过一次 `scripts/seed-psd-fonts.mjs`，
而没跑过的表现不是报错，是中文层整层画不出来。

| 文件 | 来源 | 体积 |
| --- | --- | --- |
| `fonts/NotoSans-Regular.ttf` | Noto Sans，全量 | 621 KB |
| `fonts/NotoSansSC-Regular.subset.otf` | Noto Sans SC，按 `charset/tongyong-guifan-8105.txt` 子集化 | 1.91 MB |

两套都是 OFL，允许分发，见 `OFL.txt`。子集同样受 OFL 约束。

## 升级字体版本

产物提交进仓库，**不在构建流程里生成** —— 构建因此既不依赖 Python 也不依赖公网。
代价是升级要有人手工跑一次：

```bash
python3 -m pip install fonttools brotli
python3 scripts/build-subset.py <全量 NotoSansSC-Regular.otf 的路径>
node scripts/generate-index.mjs
pnpm --filter @unidocs/fonts-builtin test
```

`src/fonts.generated.ts` 是生成物，**不要手改**：`tests/generated-index.test.ts`
会从字节重新解析并逐字段比对，手改会当场变红。

## 为什么是 8105 字

`charset/tongyong-guifan-8105.txt` 是《通用规范汉字表》。挑它不是因为体积合适，是
因为它是一份公开固定可引用的字表 —— 「装哪些字」于是有了可复现的依据，而不是一个
拍脑袋的数字。字表内容取自两个互不相干的公开仓库，两份**逐字相同**，这就是它的可信
来源。

港台字形、生僻人名地名字不在其中：那些字要用，走 CAS 装全量字体覆盖同名条目即可
（`scripts/seed-psd-fonts.mjs`）。内置这套保证的是**不出现空白字形**，不是还原原稿。
```

- [ ] **Step 12: 提交**

```bash
git add packages/fonts-builtin tsconfig.json pnpm-lock.yaml
git commit -m "feat(fonts): 新增 @unidocs/fonts-builtin —— 默认字体随包发行

拉丁全量 621KB + 中文按《通用规范汉字表》8105 字子集化到 1.91MB。裁定 R19 从
「字节不许进仓库」收窄为「只许提交有公开字表依据的子集, 单文件 3MB 以内」——
理由(不让 5-20MB 永久留在 git 历史里)不变, 只是把线划在了能换来即装即用的位置。

字表取自两个互不相干的公开仓库, 两份逐字相同, 这是它的可信来源。coverage /
unitsPerEm / hash 全部从字节解析, 用的是 seed-psd-fonts.mjs 登记字体时的同一份
实现 —— 第二份实现会让两边对'覆盖了哪些码位'的判断分叉, 而分叉的表现是某个字
被静默判成'不认识'。

子集化不进构建流程: 构建因此既不依赖 Python 也不依赖公网。"
```

---

### Task 3: `BuiltinFontProvider`

**Files:**
- Create: `packages/fonts-builtin/src/provider.ts`
- Modify: `packages/fonts-builtin/src/index.ts`（导出 provider 与回退链常量）
- Create: `packages/fonts-builtin/src/fallbacks.ts`
- Test: `packages/fonts-builtin/tests/provider.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FontProvider` / `FontIo`；Task 2 的 `BUILTIN_FONTS` / `BuiltinFontRecord`
- Produces: `BuiltinFontLoader = (fileName: string) => Promise<Uint8Array>`、`createBuiltinFontProvider({ load }): FontProvider`（`id` 恒为 `"builtin"`）、`BUILTIN_FALLBACKS: readonly string[]`

- [ ] **Step 1: 写失败的测试**

创建 `packages/fonts-builtin/tests/provider.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { FontIo } from "@unidocs/doctype-server-common";
import { BUILTIN_FALLBACKS, BUILTIN_FONTS, createBuiltinFontProvider } from "../src/index.js";

const neverCalled: FontIo = {
  readBlob: () => { throw new Error("内置来源不该碰 io.readBlob"); },
};

describe("createBuiltinFontProvider", () => {
  it("id 是 builtin", () => {
    expect(createBuiltinFontProvider({ load: async () => new Uint8Array() }).id).toBe("builtin");
  });

  it("list 原样交出生成的索引条目", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    expect(await provider.list()).toEqual(BUILTIN_FONTS.map(r => r.entry));
  });

  it("read 按 postScriptName 找到对应文件名，且不碰 io", async () => {
    const asked: string[] = [];
    const provider = createBuiltinFontProvider({
      load: async fileName => { asked.push(fileName); return new Uint8Array([1, 2, 3]); },
    });
    const [latin] = await provider.list();
    expect(await provider.read(latin!, neverCalled)).toEqual(new Uint8Array([1, 2, 3]));
    expect(asked).toEqual(["NotoSans-Regular.ttf"]);
  });

  it("read 收到不属于本来源的条目时响亮失败", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    const alien = { ...BUILTIN_FONTS[0]!.entry, postScriptName: "Helvetica" };
    await expect(provider.read(alien, neverCalled)).rejects.toThrow(/not a builtin font/i);
  });

  it("blobFor 恒为 null —— 内置字节不在 CAS 里，没有可回收的对象", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    for (const entry of await provider.list()) expect(provider.blobFor(entry)).toBeNull();
  });

  it("BUILTIN_FALLBACKS 与索引顺序一致：拉丁在前、中文在后", () => {
    expect(BUILTIN_FALLBACKS).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm --filter @unidocs/fonts-builtin exec vitest run tests/provider.test.ts`
Expected: FAIL，`createBuiltinFontProvider` / `BUILTIN_FALLBACKS` 不存在

- [ ] **Step 3: 写 provider**

创建 `packages/fonts-builtin/src/provider.ts`：

```ts
/**
 * 内置字体的 `FontProvider` 实现。
 *
 * 它是只读的：`blobFor` 恒为 null，因为字节随包走、不在 CAS 里，没有可回收的对象。
 * 这直接决定了排出来的字**不进 `doc.fonts`** —— 走那条路会撞上 state.ts 的
 * `"PSD font SBlob … was not stored during externalization"`。
 *
 * 字节怎么从包里拿出来由 `load` 决定，这是本包**唯一**必须分平台的东西：
 * Node 用 fs 读，Cloudflare 用 bundler 把字节内联进 worker。
 */
import type { FontEntry, FontIo, FontProvider } from "@unidocs/doctype-server-common";
import type { SBlob } from "@unidocs/protocol";
import { BUILTIN_FONTS } from "./fonts.generated.js";

/** 按 `fonts/` 下的文件名取字节。 */
export type BuiltinFontLoader = (fileName: string) => Promise<Uint8Array>;

export function createBuiltinFontProvider(options: { readonly load: BuiltinFontLoader }): FontProvider {
  const fileOf = new Map(BUILTIN_FONTS.map(r => [r.entry.postScriptName, r.file]));
  return {
    id: "builtin",
    list: async () => BUILTIN_FONTS.map(r => r.entry),
    read: async (entry: FontEntry, _io: FontIo): Promise<Uint8Array> => {
      const file = fileOf.get(entry.postScriptName);
      if (file === undefined) {
        // 门面按 source 分发，正常路径到不了这里。静默返回空字节会表现成
        // "这套字体解析失败"，查起来毫无线索。
        throw new Error(`${entry.postScriptName} is not a builtin font`);
      }
      return await options.load(file);
    },
    blobFor: (): SBlob | null => null,
  };
}
```

- [ ] **Step 4: 写回退链常量**

创建 `packages/fonts-builtin/src/fallbacks.ts`：

```ts
/**
 * `PSD_FONT_FALLBACKS` 的默认值。
 *
 * 住在这里而不是两个栈的配置文件里：两个平台读的是同一个环境变量、要的是同一套
 * 语义，各写一份迟早分叉。名字从生成的索引里取，**不硬编码字符串** —— 硬编码一个
 * 索引里没有的名字，回退链只会静默失效（`resolveFaceChain` 对没装载的候选是直接
 * 跳过，不报错）。
 *
 * 顺序即优先级：拉丁在前、中文在后 —— 前者不覆盖 CJK，汉字自然落到后者。
 */
import { BUILTIN_FONTS } from "./fonts.generated.js";

export const BUILTIN_FALLBACKS: readonly string[] =
  Object.freeze(BUILTIN_FONTS.map(record => record.entry.postScriptName));
```

- [ ] **Step 5: 导出**

修改 `packages/fonts-builtin/src/index.ts`，在文件末尾追加：

```ts
export { BUILTIN_FALLBACKS } from "./fallbacks.js";
export { createBuiltinFontProvider, type BuiltinFontLoader } from "./provider.js";
```

- [ ] **Step 6: 跑测试**

Run: `pnpm --filter @unidocs/fonts-builtin exec vitest run tests/provider.test.ts`
Expected: PASS，6 条全绿

- [ ] **Step 7: 提交**

```bash
git add packages/fonts-builtin/src packages/fonts-builtin/tests/provider.test.ts
git commit -m "feat(fonts): BuiltinFontProvider —— 只读来源, blobFor 恒为 null

blobFor 返回 null 不是省事, 是它直接决定了内置字体排出来的字不进 doc.fonts:
内置字节随包走、不在 CAS 里, 没有可回收的对象, 走保活那条路会撞上 state.ts 的
'PSD font SBlob … was not stored during externalization'。

回退链默认值从生成的索引里取而不是硬编码字符串: 硬编码一个索引里没有的名字,
回退链只会静默失效。"
```

---

### Task 4: 两个平台适配器改成 `FontProvider`

**Files:**
- Rename + Modify: `packages/azure-sdk/src/font-registry-pg.ts` → `packages/azure-sdk/src/font-provider-pg.ts`（`PgFontRegistry` → `PgFontProvider`）
- Modify: `packages/azure-sdk/src/index.ts`
- Rename + Modify: `packages/cloudflare-psd/src/font-registry-do.ts` → `packages/cloudflare-psd/src/font-provider-do.ts`（`createDoFontRegistry` → `createDoFontProvider`）
- Modify: `packages/doctype-server-common/src/memory-ports.ts`（内存实现改成 provider）
- Rename + Modify: `packages/doctype-server-common/src/testing/font-registry-contract.ts` → `.../testing/font-provider-contract.ts`（`runFontRegistryContract` → `runFontProviderContract`）
- Modify: `packages/doctype-server-common/package.json`（`exports` 与 `publishConfig.exports` 里 `./font-registry-contract` → `./font-provider-contract`）
- Modify: `packages/azure-sdk/tests/font-registry-pg.test.ts` → `font-provider-pg.test.ts`
- Modify: `packages/cloudflare-psd/tests/font-registry-do.test.ts` → `font-provider-do.test.ts`
- Modify: `packages/doctype-server-common/tests/font-registry-memory.test.ts` → `font-provider-memory.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FontProvider` / `FontIo`
- Produces: `class PgFontProvider implements FontProvider`（构造签名不变：`(q: Queryable, scope: FontRegistryScope)`，`FontRegistryScope` 类型名保持不变以免连累无关调用点）；`createDoFontProvider({ namespace, objectName }): FontProvider`；`runFontProviderContract(label, make: () => Promise<FontProvider>)`

**这一步的红线：SQL、表结构、迁移文件、DO 内部实现一行都不改。** 改的只有 TypeScript 类名与它实现的接口。

- [ ] **Step 1: 改共享契约测试**

租户那一档实现的是 Task 1 定义的 `WritableFontProvider`（`FontProvider` 加一个
`put`）。契约测试跟着从「registry 契约」变成「provider 契约」。

```bash
git mv packages/doctype-server-common/src/testing/font-registry-contract.ts \
       packages/doctype-server-common/src/testing/font-provider-contract.ts
```

编辑 `font-provider-contract.ts`：

- import 换成：
  ```ts
  import type { FontIo, WritableFontProvider } from "../index.js";
  import type { FontEntry } from "../font-registry.js";
  ```
- 导出的函数改名并换签名：
  `runFontRegistryContract(label, make: () => Promise<FontRegistry>)`
  → `runFontProviderContract(label, make: () => Promise<WritableFontProvider>)`
- 用例里的局部变量 `registry` 改名 `provider`；`put` / `list` 的调用**一个字不改**。
- 文件头那段「前提，`make` 必须满足：每次调用返回的实例互不共享底层作用域/存储」
  以及「两次 make() 互不可见」那条用例的长注释，**逐字保留** —— 它记录的是一次实测：
  把 `tenantId` 改成恒定值后 5 条里 4 条照样绿，删掉等于把那个教训作废。

再追加三条新用例（新接口带来的三个成员）：

```ts
    it("id 是 tenant —— 门面按它分发", async () => {
      expect((await make()).id).toBe("tenant");
    });

    it("blobFor 返回内容哈希对得上的 SBlob", async () => {
      const provider = await make();
      await provider.put(noto);
      const blob = provider.blobFor(noto);
      expect(blob).not.toBeNull();
      expect(blob!.hash).toBe(noto.hash);
    });

    it("read 经过 io.readBlob，不自己去碰 CAS（裁定 R29）", async () => {
      const provider = await make();
      await provider.put(noto);
      const seen: string[] = [];
      const io: FontIo = { readBlob: async b => { seen.push(b.hash); return { data: new Uint8Array([7]) }; } };
      expect(await provider.read(noto, io)).toEqual(new Uint8Array([7]));
      expect(seen).toEqual([noto.hash]);
    });
```

同步改 `packages/doctype-server-common/package.json`：`exports` 与
`publishConfig.exports` 两处的 `"./font-registry-contract"` 键名改成
`"./font-provider-contract"`，路径里的文件名同步改。

- [ ] **Step 2: 跑一遍确认现有适配器测试变红**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/font-registry-pg.test.ts
pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/font-registry-do.test.ts
```

Expected: 两个都 FAIL —— import 的 `@unidocs/doctype-server-common/font-registry-contract` 已不存在。

- [ ] **Step 3: 改 Azure 适配器**

```bash
git mv packages/azure-sdk/src/font-registry-pg.ts packages/azure-sdk/src/font-provider-pg.ts
git mv packages/azure-sdk/tests/font-registry-pg.test.ts packages/azure-sdk/tests/font-provider-pg.test.ts
```

编辑 `packages/azure-sdk/src/font-provider-pg.ts`：类名 `PgFontRegistry` → `PgFontProvider`，
`implements FontRegistry` → `implements WritableFontProvider`，`list` / `put` 的 SQL
**一个字不改**，import 改成：

```ts
import { casFontBytes } from "@unidocs/doctype-server-common";
import type { FontEntry, FontIo, WritableFontProvider } from "@unidocs/doctype-server-common";
import type { SBlob } from "@unidocs/protocol";
```

新增三个成员：

```ts
  readonly id = "tenant";

  /** 读取语义两个平台逐字相同（`createSBlob` 住在中立的 `@unidocs/svalue-codec`，
   *  两个平台 SDK 只是再导出它），所以复用中立层那份，不各写一遍。字节在 CAS，
   *  由跑在编辑会话里的 effect 带着会话身份去读 —— 这个 provider 自己拿不到
   *  CAS 权限，也不该拿到（裁定 R29）。 */
  read(entry: FontEntry, io: FontIo): Promise<Uint8Array> { return casFontBytes.read(entry, io); }

  blobFor(entry: FontEntry): SBlob { return casFontBytes.blobFor(entry); }
```

修改 `packages/azure-sdk/src/index.ts`：`export * from "./font-registry-pg.js";` → `export * from "./font-provider-pg.js";`

编辑 `packages/azure-sdk/tests/font-provider-pg.test.ts`：`runFontRegistryContract` → `runFontProviderContract`，import 路径 `@unidocs/doctype-server-common/font-registry-contract` → `.../font-provider-contract`，`new PgFontRegistry(...)` → `new PgFontProvider(...)`。

- [ ] **Step 4: 改 Cloudflare 适配器**

```bash
git mv packages/cloudflare-psd/src/font-registry-do.ts packages/cloudflare-psd/src/font-provider-do.ts
git mv packages/cloudflare-psd/tests/font-registry-do.test.ts packages/cloudflare-psd/tests/font-provider-do.test.ts
```

编辑 `packages/cloudflare-psd/src/font-provider-do.ts`：函数名 `createDoFontRegistry` →
`createDoFontProvider`，返回类型 `FontRegistry` → `WritableFontProvider`，`list`/`put`
的实现**一个字不改**，在返回的对象字面量里追加：

```ts
    id: "tenant",
    // 与 Azure 侧复用同一份 —— 两边的读取语义逐字相同，各写一遍迟早分叉。
    read: casFontBytes.read,
    blobFor: casFontBytes.blobFor,
```

顶部补 `import { casFontBytes } from "@unidocs/doctype-server-common";`。

测试文件同步改名引用。

- [ ] **Step 5: 改内存实现**

编辑 `packages/doctype-server-common/src/memory-ports.ts`：把里面的内存 `FontRegistry` 实现改成 `WritableFontProvider`，`id` 设为 `"tenant"`，`blobFor` 用 `createSBlob(entry.hash)`，`read` 走 `io.readBlob`。导出名 `createMemoryFontRegistry` → `createMemoryFontProvider`（若原名不同，按实际改）。

`packages/doctype-server-common/tests/font-registry-memory.test.ts` 改名为 `font-provider-memory.test.ts` 并同步引用。

- [ ] **Step 6: 跑三处适配器测试**

```bash
pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-provider-memory.test.ts
pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/font-provider-do.test.ts
pnpm --filter @unidocs/azure-sdk exec vitest run tests/font-provider-pg.test.ts
```

Expected: 三个都 PASS。Azure 那条需要 azure-sdk 既有的 Postgres compose 夹具在跑。

- [ ] **Step 7: 提交**

```bash
git add -A packages/azure-sdk packages/cloudflare-psd packages/doctype-server-common
git commit -m "refactor(fonts): 两个平台适配器改为实现 FontProvider

改名不是洁癖: 它们实现的接口变了, 名字不改就在说谎。SQL、表结构、迁移文件、
DO 内部实现一行都没动 —— 线上已有的登记数据不受影响。

新增 WritableFontProvider: 今天只有租户那一档实现 put, 内置来源装不进去。
门面的 install 将来路由到这里。"
```

---

### Task 5: 路由处理器改收 `WritableFontProvider`

**行为与鉴权一字不改**，只改它接收的类型——这是本任务唯一允许的改动。

**Files:**
- Modify: `packages/doctype-server-common/src/font-registry-handler.ts:33`（`registry: FontRegistry` → `provider: WritableFontProvider`）与 `:72`、`:81` 两处调用点
- Modify: `packages/cloudflare-psd/src/worker.ts`（构造 `FontsRequestConfig` 的地方）
- Modify: `packages/azure-sdk/src/doc-type-service.ts`（同上）
- Test: `packages/doctype-server-common/tests/font-registry-handler.test.ts`

- [ ] **Step 1: 改测试的桩**

编辑 `packages/doctype-server-common/tests/font-registry-handler.test.ts`：把构造 `FontsRequestConfig` 时传的那个 `registry: { list, put }` 桩改名为 `provider`，并补齐 provider 必须有的三个成员：

```ts
const provider: WritableFontProvider = {
  id: "tenant",
  list: async () => stored,
  put: async e => { stored = [...stored.filter(x => x.postScriptName !== e.postScriptName), e]; },
  read: async () => { throw new Error("路由不读字节"); },
  blobFor: e => createSBlob(e.hash),
};
```

再补一条新用例，钉住"路由的行为没变"：

```ts
it("GET 仍然只返回租户那一档，不掺内置字体", async () => {
  // 路由直接持有租户 provider，不经门面 —— 这个端点回答的是"这个租户登记了什么"，
  // 不是"这个租户能用什么"。掺进内置字体会让 seed 脚本的幂等判据（"索引里有没有"）
  // 每次都判成"已经有了"，于是一套字体都灌不进去。
  const response = await handleFontsRequest({ ...cfg, provider }, getRequest, route);
  expect(await response.json()).toEqual({ fonts: stored });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-handler.test.ts`
Expected: FAIL，类型不匹配 / `cfg.registry` 未定义

- [ ] **Step 3: 改处理器**

编辑 `packages/doctype-server-common/src/font-registry-handler.ts`：

- import 改成 `import type { FontEntry } from "./font-registry.js";` 加 `import type { WritableFontProvider } from "./font-provider.js";`
- `FontsRequestConfig` 里 `readonly registry: FontRegistry;` → 
  ```ts
  /** 租户那一档来源。**刻意不收门面**：这个端点回答的是"这个租户登记了什么"，
   *  不是"这个租户能用什么"。掺进内置字体会让 seed 脚本的幂等判据（"索引里
   *  有没有"）每次都判成"已经有了"，于是一套字体都灌不进去。 */
  readonly provider: WritableFontProvider;
  ```
- 第 72 行 `cfg.registry.list()` → `cfg.provider.list()`
- 第 81 行 `cfg.registry.put(...)` → `cfg.provider.put(...)`

其余（405、鉴权、`fontEntryProblem`、审计事件）**一个字不改**。

- [ ] **Step 4: 改两处接线**

在 `packages/cloudflare-psd/src/worker.ts` 与 `packages/azure-sdk/src/doc-type-service.ts` 里，把构造 `FontsRequestConfig` 时的 `registry:` 键改成 `provider:`，值改成新的 `createDoFontProvider(...)` / `new PgFontProvider(...)`。

- [ ] **Step 5: 跑测试**

```bash
pnpm --filter @unidocs/doctype-server-common exec vitest run tests/font-registry-handler.test.ts
pnpm --filter @unidocs/azure-sdk exec vitest run tests/doc-type-service.test.ts
```

Expected: 两个都 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-server-common packages/cloudflare-psd/src/worker.ts packages/azure-sdk/src/doc-type-service.ts
git commit -m "refactor(fonts): fonts 路由改收 WritableFontProvider, 行为一字不改

刻意不收门面: 这个端点回答的是'这个租户登记了什么', 不是'这个租户能用什么'。
掺进内置字体会让 seed 脚本的幂等判据('索引里有没有')每次都判成'已经有了',
于是一套字体都灌不进去。"
```

---

### Task 6: `setText` 接门面，内置字体不进 `doc.fonts`

**Files:**
- Modify: `packages/doctype-psd/src/text/set-text.ts:46-54`（`FontIndexSource` 塌缩）与 `:203-232`（`loadFonts`）
- Delete: `packages/doctype-psd/src/text/font-index.ts`（`createFontIndex` 并入门面；`parseFontFallbacks` 搬到新文件）
- Create: `packages/doctype-psd/src/text/font-fallbacks.ts`
- Modify: `packages/doctype-psd/src/text/registry.ts`（`FontIndex` 改从中立层 re-export，`selectFonts` 取 coverage 多一层 `.entry`）
- Modify: `packages/doctype-psd/src/index.ts`
- Modify: `packages/doctype-psd/tests/font-index.test.ts` → 删除（覆盖已由 Task 1 的 compose 测试接管）
- Test: `packages/doctype-psd/tests/set-text.test.ts`（补两条新断言）

**Interfaces:**
- Consumes: Task 1 的 `FontRegistry` / `FontIndex` / `RegisteredFont` / `FontIo`
- Produces: `FontIndexSource = { readonly registry: FontRegistry; readonly fallbacks: readonly string[] }`；`parseFontFallbacks(value: string | undefined, fallback: readonly string[]): readonly string[]`

- [ ] **Step 1: 写失败的测试**

在 `packages/doctype-psd/tests/set-text.test.ts` 末尾追加：

```ts
describe("字体来源与保活", () => {
  it("内置字体排完不进 doc.fonts —— 它不在 CAS 里，没有可回收的对象", async () => {
    // 走那条路会撞上 state.ts 的
    // "PSD font SBlob … was not stored during externalization"。
    const { ops } = await runSetText({ fontSource: "builtin", text: "hello" });
    const setTextOp = ops.find(o => o.kind === "set_text")!;
    expect(setTextOp.fonts).toEqual([]);
  });

  it("租户字体排完仍然进 doc.fonts —— 保活靠文档钉着", async () => {
    const { ops } = await runSetText({ fontSource: "tenant", text: "hello" });
    const setTextOp = ops.find(o => o.kind === "set_text")!;
    expect(setTextOp.fonts.map((f: { postScriptName: string }) => f.postScriptName))
      .toEqual(["Test-Regular"]);
  });
});
```

`runSetText` 是本文件已有的夹具；按它现有形状加一个 `fontSource` 开关：`"builtin"` 时构造的 `FontRegistry` 里 provider 的 `blobFor` 返回 `null`，`"tenant"` 时返回 `createSBlob(hash)`。测试字体沿用 `packages/doctype-psd/tests/text-test-font.ts`。

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/set-text.test.ts -t "字体来源与保活"`
Expected: FAIL

- [ ] **Step 3: 塌缩 `FontIndexSource`**

编辑 `packages/doctype-psd/src/text/set-text.ts`，把 `FontIndexSource` 换成：

```ts
/**
 * `setText` 的字体来源。
 *
 * 两个字段而不是三个：字节在哪儿、要不要保活，全都收进了 `FontRegistry` 门面
 * （`@unidocs/doctype-server-common`）。这里只剩"哪个 registry"和"回退链顺序"
 * —— 后者是排版语义，不属于 registry。
 */
export interface FontIndexSource {
  readonly registry: FontRegistry;
  /** 回退链，按优先级。请求的字体缺席、或者它不认识某个码位时逐个试。 */
  readonly fallbacks: readonly string[];
}
```

`loadFonts` 里那段循环改成：

```ts
  const loaded = new Map<string, FontFace>();
  const fonts: FontRef[] = [];
  for (const name of needed) {
    const found = index.get(name);
    if (!found) continue; // selectFonts 只会返回索引里有的名字；防御性。
    // ctx 结构上满足 FontIo（它有 readBlob）。
    const bytes = await source.registry.read(found, ctx);
    // 按**索引里的名字**入表，不是按 `face.postScriptName`：候选名单
    // （requested + fallbacks）用的是索引这套命名，`resolveFaceChain` 拿
    // 候选名去 `loaded` 里查，两边不同名就一个都查不到。
    loaded.set(name, parseFontFace(bytes));
    // 内置字体的 blobFor 返回 null：它不在 CAS 里，没有可回收的对象，也就
    // 不需要（而且不能）写进 doc.fonts —— state.ts 的 storeFont 会对一个
    // 不存在的 CAS 对象抛 "was not stored during externalization"。
    const blob = source.registry.blobFor(found);
    if (blob) fonts.push({ postScriptName: name, blob });
  }
```

`loadFonts` 的 `index` 参数类型从 `FontIndex`（本包旧定义）改成中立层的 `FontIndex`；取索引的地方改成 `await source.registry.index()`。

- [ ] **Step 4: 改 `registry.ts` 的取值路径**

编辑 `packages/doctype-psd/src/text/registry.ts`：

- 删掉本地的 `export type FontIndex = ReadonlyMap<string, FontEntry>;`，改成从中立层 re-export（注意 Global Constraints 里的门禁写法——先 `import type`，再单独 `export type { … };`，**不要**写带模块说明符的 `export type … from`）：

```ts
import type { FontIndex } from "@unidocs/doctype-server-common";
export type { FontIndex };
```

- `selectFonts` 里 `const entry = index.get(postScriptName); return entry !== undefined && coversCodePoint(entry.coverage, cp);` 改成 `coversCodePoint(entry.entry.coverage, cp)`。

- [ ] **Step 5: 搬 `parseFontFallbacks`，删 `font-index.ts`**

创建 `packages/doctype-psd/src/text/font-fallbacks.ts`：

```ts
/**
 * 回退链配置：`PSD_FONT_FALLBACKS="NotoSans-Regular,NotoSansSC-Regular"`，
 * 逗号分隔，顺序即优先级。
 *
 * **未设**（`undefined`）时取 `fallback` 参数给的默认值 —— 内置字体那两套的名字。
 * **显式设成空串**时是空链，作为逃生口。这两者今天返回值相同（都是 `[]`），改动之后
 * 必须可区分：以前"缺省空、不硬编码字体名"的理由是「硬编码一个 CAS 里可能不存在的
 * 名字，回退链只会静默失效」，而内置之后名字与字节同源、不可能不存在，那个理由消失了。
 *
 * 住在这里而不是某个平台包里，是因为两个平台读的是同一个环境变量、要的是同一套语义。
 */
export function parseFontFallbacks(
  value: string | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) return fallback;
  return value.split(",").map(name => name.trim()).filter(name => name.length > 0);
}
```

```bash
git rm packages/doctype-psd/src/text/font-index.ts packages/doctype-psd/tests/font-index.test.ts
```

修改 `packages/doctype-psd/src/index.ts`：把 `createFontIndex` / `parseFontFallbacks` 的导出改成只导出 `parseFontFallbacks`（来自新文件），`createFontIndex` 不再存在。

- [ ] **Step 6: 补一条 `parseFontFallbacks` 的测试**

创建 `packages/doctype-psd/tests/font-fallbacks.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseFontFallbacks } from "../src/text/font-fallbacks.js";

const builtin = ["NotoSans-Regular", "NotoSansSC-Regular"];

describe("parseFontFallbacks", () => {
  it("未设时取内置默认值", () => {
    expect(parseFontFallbacks(undefined, builtin)).toEqual(builtin);
  });

  it("显式空串是空链 —— 逃生口，与'未设'必须可区分", () => {
    expect(parseFontFallbacks("", builtin)).toEqual([]);
  });

  it("逗号分隔、trim、丢空段", () => {
    expect(parseFontFallbacks(" A , ,B ", builtin)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 7: 跑测试**

```bash
pnpm --filter @unidocs/doctype-psd exec vitest run tests/set-text.test.ts tests/font-fallbacks.test.ts
```

Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A packages/doctype-psd
git commit -m "refactor(fonts): setText 只认 FontRegistry 门面, 内置字体不进 doc.fonts

FontIndexSource 从三个字段塌缩成两个: 字节在哪儿、要不要保活全收进门面了,
这里只剩'哪个 registry'和'回退链顺序'。

blobFor 返回 null 时跳过 doc.fonts 不是优化, 是必须: state.ts 的 storeFont 对
一个不存在的 CAS 对象会抛 'was not stored during externalization'。

parseFontFallbacks 现在区分 undefined(取内置默认)与空串(空链, 逃生口)。以前
'缺省空、不硬编码字体名'的理由是硬编码的名字可能在 CAS 里不存在, 内置之后名字
与字节同源, 那个理由消失了。"
```

---

### Task 7: 两个平台的字节加载器与打包配置

这是本设计里**唯一**必须分平台的东西。

**Files:**
- Create: `packages/azure-psd/src/builtin-fonts.ts`
- Create: `packages/cloudflare-psd/src/builtin-fonts.ts`
- Create: `packages/cloudflare-psd/src/font-modules.d.ts`
- Modify: `packages/cloudflare-psd/wrangler.toml`（加 `[[rules]]`）
- Modify: `stacks/unidocs-cloudflare/local/runtime.mjs:45`（esbuild `loader`）
- Modify: `stacks/unidocs-azure/local/runtime.mjs:209`（esbuild `loader`，见下方说明）
- Test: `packages/azure-psd/tests/builtin-fonts.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `BuiltinFontLoader`
- Produces: 两个包各导出 `builtinFontLoader: BuiltinFontLoader`

- [ ] **Step 1: 写 Azure 侧加载器的失败测试**

创建 `packages/azure-psd/tests/builtin-fonts.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_FONTS } from "@unidocs/fonts-builtin";
import { builtinFontLoader } from "../src/builtin-fonts.js";

describe("builtinFontLoader (Node)", () => {
  it("每一套内置字体都读得出来，且哈希对得上", async () => {
    const { createHash } = await import("node:crypto");
    for (const record of BUILTIN_FONTS) {
      const bytes = await builtinFontLoader(record.file);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.entry.hash);
    }
  });

  it("文件不存在时响亮失败，不返回空字节", async () => {
    await expect(builtinFontLoader("NoSuchFont.ttf")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm --filter @unidocs/azure-psd exec vitest run tests/builtin-fonts.test.ts`
Expected: FAIL，`../src/builtin-fonts.js` 不存在

- [ ] **Step 3: 写 Azure 侧加载器**

创建 `packages/azure-psd/src/builtin-fonts.ts`：

```ts
/**
 * 内置字体在 Node 上的字节加载器。
 *
 * **不用 `new URL("../fonts/…", import.meta.url)`。** 那样解析出来的是"相对本模块
 * 文件"的路径，而本模块在本地 Azure 栈里是被 esbuild 打包进
 * `.azure-runtime/bundles/psd.mjs` 之后才跑的 —— 相对路径会指到 `.azure-runtime/`
 * 底下去，文件不存在。`createRequire` 走的是 node_modules 解析，打包前后都对：
 * 打包产物落在仓库内，向上找得到 workspace 的软链；镜像里 `pnpm deploy --prod`
 * 产出的是真实（非软链）的 node_modules，同样找得到。
 *
 * 这也是 `@unidocs/fonts-builtin` 的 package.json 必须导出 `"./package.json"`
 * 的原因 —— 没有那一条，`require.resolve` 在 Node 的 exports 封装下会被拒。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";

const require = createRequire(import.meta.url);
const FONTS_DIR = join(dirname(require.resolve("@unidocs/fonts-builtin/package.json")), "fonts");

export const builtinFontLoader: BuiltinFontLoader = async fileName =>
  new Uint8Array(await readFile(join(FONTS_DIR, fileName)));
```

- [ ] **Step 4: 跑 Azure 侧测试**

Run: `pnpm --filter @unidocs/azure-psd exec vitest run tests/builtin-fonts.test.ts`
Expected: PASS

- [ ] **Step 5: 写 Cloudflare 侧加载器**

创建 `packages/cloudflare-psd/src/font-modules.d.ts`：

```ts
/** wrangler 的 `[[rules]] type = "Data"` 与 esbuild 的 `binary` loader 都把字体
 *  文件变成一个默认导出的字节数组。声明它，好让 tsc 认得这个 import。 */
declare module "@unidocs/fonts-builtin/fonts/*" {
  const bytes: Uint8Array;
  export default bytes;
}
```

创建 `packages/cloudflare-psd/src/builtin-fonts.ts`：

```ts
/**
 * 内置字体在 Cloudflare 上的字节加载器。
 *
 * Workers 没有文件系统，字节必须在打包时内联进 worker 产物。三处配置缺一不可：
 * 生产的 `wrangler.toml` 的 `[[rules]] type = "Data"`、本地栈
 * `stacks/unidocs-cloudflare/local/runtime.mjs` 的 esbuild `loader`。漏配的表现是
 * **构建期报错**（可接受），不是运行时静默失效。
 *
 * 体积核对：psd 的 worker bundle 原本 1.69 MB / gzip 358 KB，加这两套字体后
 * gzip 约 2.4 MB，离 10 MB（压缩后）上限仍有大量余量。
 */
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";
import notoSans from "@unidocs/fonts-builtin/fonts/NotoSans-Regular.ttf";
import notoSansSC from "@unidocs/fonts-builtin/fonts/NotoSansSC-Regular.subset.otf";

const BYTES: Readonly<Record<string, Uint8Array>> = Object.freeze({
  "NotoSans-Regular.ttf": notoSans,
  "NotoSansSC-Regular.subset.otf": notoSansSC,
});

export const builtinFontLoader: BuiltinFontLoader = async fileName => {
  const bytes = BYTES[fileName];
  // 打包配置漏了某个文件时，这里比"字体解析失败"好查得多。
  if (!bytes) throw new Error(`Builtin font ${fileName} was not bundled into the worker`);
  return bytes;
};
```

- [ ] **Step 6: 配三处打包规则**

`packages/cloudflare-psd/wrangler.toml`，在 `compatibility_flags` 之后、任何 `[table]` 之前加：

```toml
# 内置字体的字节要内联进 worker 产物 —— Workers 没有文件系统。
# 必须在任何 [table] 头之前：TOML 里表头之后的所有键都归那张表
# （这个文件顶部已经因为 compatibility_flags 踩过一次同样的坑）。
[[rules]]
type = "Data"
globs = ["**/*.ttf", "**/*.otf"]
fallthrough = true
```

`stacks/unidocs-cloudflare/local/runtime.mjs` 的 `bundleWorker`（约第 45 行 `esbuild.build({`）里加一项：

```js
    loader: { ".ttf": "binary", ".otf": "binary" },
```

`stacks/unidocs-azure/local/runtime.mjs` 约第 209 行的 `esbuild.build({` 里加**同一项**。Azure 生产不打包（`node dist/main.js` + 真实 node_modules），走的是 Step 3 那个 fs 加载器；但本地 Azure 栈是 esbuild 打包跑的，`createRequire` 在那里仍然有效（打包产物落在仓库内，向上找得到 node_modules），所以这一项其实是**冗余的保险**——加上它，将来有人把 CF 侧的 import 写法搬过来也不会炸。

- [ ] **Step 7: 验证两个栈都打得出包**

```bash
pnpm build
node -e '
import("esbuild").then(async esbuild => {
  const out = await esbuild.build({
    entryPoints: ["packages/cloudflare-psd/src/worker.ts"],
    bundle: true, format: "esm", write: false, platform: "browser",
    loader: { ".ttf": "binary", ".otf": "binary" },
    external: ["cloudflare:workers", "node:*"],
  });
  const bytes = out.outputFiles[0].contents.length;
  const gz = require("node:zlib").gzipSync(out.outputFiles[0].contents).length;
  console.log(`worker bundle: ${bytes.toLocaleString()} bytes, gzip ${gz.toLocaleString()}`);
  if (gz > 9_000_000) throw new Error("gzip 后超过 9 MB，逼近 Cloudflare 10 MB 上限");
});'
```

Expected: 打印大小，gzip 在 2–3 MB 量级，不抛错。

- [ ] **Step 8: 提交**

```bash
git add packages/azure-psd/src/builtin-fonts.ts packages/azure-psd/tests/builtin-fonts.test.ts \
        packages/cloudflare-psd/src/builtin-fonts.ts packages/cloudflare-psd/src/font-modules.d.ts \
        packages/cloudflare-psd/wrangler.toml \
        stacks/unidocs-cloudflare/local/runtime.mjs stacks/unidocs-azure/local/runtime.mjs
git commit -m "feat(fonts): 两个平台的内置字节加载器 —— 唯一必须分平台的东西

Node 侧刻意不用 new URL(…, import.meta.url): 本地 Azure 栈把这个模块 esbuild
打包进 .azure-runtime/bundles/psd.mjs 之后才跑, 相对路径会指到那个目录底下。
createRequire 走 node_modules 解析, 打包前后、软链与真实目录都对。

Cloudflare 侧字节必须内联进 worker(没有文件系统), wrangler 的 [[rules]] 要写在
任何 [table] 头之前 —— 这个文件顶部已经因为 compatibility_flags 踩过一次。"
```

---

### Task 8: 两个 `psdAgentDeps` 接线 —— `fontIndex` 变成无条件

**这一步是本设计对可靠性最大的一笔改善**：`setText` 从此不再因为"某个绑定漏配"而从工具表里消失。

**Files:**
- Modify: `packages/azure-psd/src/agent-deps.ts`
- Modify: `packages/cloudflare-psd/src/agent-deps.ts`
- Delete: `packages/cloudflare-psd/src/fonts-source.ts`（内容并入 `agent-deps.ts`）
- Delete: `packages/cloudflare-psd/tests/fonts-source.test.ts`
- Modify: `packages/azure-psd/tests/agent-deps.test.ts`
- Modify: `tests/unit/psd-agent-parity.test.mjs`

**Interfaces:**
- Consumes: Task 1 `createFontRegistry`、Task 3 `createBuiltinFontProvider` / `BUILTIN_FALLBACKS`、Task 4 `PgFontProvider` / `createDoFontProvider`、Task 6 `parseFontFallbacks`、Task 7 两个 `builtinFontLoader`
- Produces: 两个包的 `psdAgentDeps` 签名不变，但 `fontIndex` 字段**恒存在**

- [ ] **Step 1: 写失败的测试**

在 `packages/azure-psd/tests/agent-deps.test.ts` 追加：

```ts
it("fontIndex 无条件注入：内置字体总在，setText 不会从工具表里消失", () => {
  const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
  expect(deps.fontIndex).toBeDefined();
});

it("回退链未配时取内置默认值", () => {
  const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
  expect(deps.fontIndex!.fallbacks).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
});

it("内置字体在索引里，且租户同名条目盖得掉它", async () => {
  const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
  const index = await deps.fontIndex!.registry.index();
  expect(index.get("NotoSans-Regular")!.source).toBe("builtin");
});
```

在 `packages/cloudflare-psd` 新建 `tests/agent-deps-fonts.test.ts` 写对称的三条（`PSD_FONTS` 绑定**不传**时 `fontIndex` 仍然存在，索引里仍有两套内置字体）。

- [ ] **Step 2: 跑一遍确认它失败**

```bash
pnpm --filter @unidocs/azure-psd exec vitest run tests/agent-deps.test.ts
pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/agent-deps-fonts.test.ts
```

Expected: 两个都 FAIL

- [ ] **Step 3: 改 Azure 接线**

编辑 `packages/azure-psd/src/agent-deps.ts`，把 `fontIndex` 那段换成：

```ts
    fontIndex: {
      registry: createFontRegistry({
        // 顺序即优先级：租户登记的同名字体盖掉内置的。这就是"用户主动装
        // external 字体"的扩展点 —— 想要全量 NotoSansSC（含港台字形与扩展区），
        // 用 scripts/seed-psd-fonts.mjs 装上去即可，不需要任何开关。
        providers: [
          createBuiltinFontProvider({ load: builtinFontLoader }),
          new PgFontProvider(pool, {
            stackId: requireStackId(env.CAS_STACK_ID),
            tenantId: identity.tenantId,
          }),
        ],
      }),
      fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS),
    },
```

并把模块顶部那段说明里"fontIndex 无条件注入"的理由改成新的（原文说的是"这边的后端是本进程已经在用的 Postgres 连接池，没有绑定漏配这种状态"）：

```
 * 1. **fontIndex 无条件注入,两个平台一致。** 以前 CF 那边它是条件的,判据是
 *    `PSD_FONTS` 这条可能漏配的 DO 绑定。内置字体随包走之后,"有没有字体可用"
 *    永远为真,条件化只会凭空造出一条 setText 静默消失的路。
```

`createFontRegistry` 的实例**必须每租户一个**这条约束不变，原注释第 2 条逐字保留。

- [ ] **Step 4: 改 Cloudflare 接线**

删除 `packages/cloudflare-psd/src/fonts-source.ts` 与 `tests/fonts-source.test.ts`（`createFontIndex` 已不存在，这个文件只剩构造参数）。

编辑 `packages/cloudflare-psd/src/agent-deps.ts`，把 `...(env.PSD_FONTS ? { fontIndex: … } : {})` 换成：

```ts
    fontIndex: {
      registry: createFontRegistry({
        providers: [
          createBuiltinFontProvider({ load: builtinFontLoader }),
          // 绑定漏配时只是少了租户那一档 —— 内置那档仍在，setText 照常可用。
          // 以前这里漏配会让 setText 整个从工具表里消失。
          ...(env.PSD_FONTS
            ? [createDoFontProvider({
              namespace: env.PSD_FONTS,
              objectName: fontsObjectName({ stackId: env.CAS_STACK_ID, tenantId: identity.tenantId }),
            })]
            : []),
        ],
      }),
      fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS),
    },
```

顶部 import 相应调整；`parseFontFallbacks` 的 re-export 从 `fonts-source.ts` 移到 `agent-deps.ts`（`scripts/` 与测试里若有引用要跟着改）。

- [ ] **Step 5: 更新 parity 测试**

编辑 `tests/unit/psd-agent-parity.test.mjs`：原来它断言"同等注入下两个栈工具名集合相等"，现在还要加一条**更强的**：

```js
test("两个栈在最小 env 下工具表就相等 —— setText 不再靠绑定/连接池是否配上", () => {
  // 以前这条不成立：CF 少配 PSD_FONTS 就没有 setText，而那正是平台能力差异
  // 表现为"一次礼貌的拒绝"的根源 —— 没有任何一步失败，日志、测试、告警全看不见。
  const cf = toolNames(cfDeps({ CAS_STACK_ID: "s" }, identity));
  const az = toolNames(azDeps({ CAS_STACK_ID: "s" }, identity, fakePool));
  assert.deepEqual(cf, az);
  assert.ok(cf.includes("apply_set_text"));
});
```

- [ ] **Step 6: 跑测试**

```bash
pnpm --filter @unidocs/azure-psd exec vitest run tests/agent-deps.test.ts
pnpm --filter @unidocs/cloudflare-psd exec vitest run tests/agent-deps-fonts.test.ts
node --test tests/unit/psd-agent-parity.test.mjs
```

Expected: 三个都 PASS

- [ ] **Step 7: 提交**

```bash
git add -A packages/azure-psd packages/cloudflare-psd tests/unit/psd-agent-parity.test.mjs
git commit -m "feat(fonts): fontIndex 无条件注入, setText 不再因漏配而消失

以前 CF 侧的判据是 PSD_FONTS 这条可能漏配的 DO 绑定, 漏配的表现是 setText 整个
从工具表里消失 —— 平台能力差异表现为一次礼貌的拒绝, 没有任何一步失败, 日志、
测试、告警全都看不见。内置字体随包走之后'有没有字体可用'永远为真, 绑定漏配只是
少了租户那一档。

parity 测试相应加强: 断言两个栈在最小 env 下工具表就相等。"
```

---

### Task 9: 配置与预置脚本的收尾

**Files:**
- Modify: `packages/cloudflare-psd/wrangler.toml`（`PSD_FONT_FALLBACKS` 的注释与取值）
- Modify: `stacks/unidocs-azure/deploy/service.bicep:62,184-190`（同上）
- Modify: `stacks/unidocs-azure/deploy/deploy.mjs:236,1097`（同上）
- Modify: `scripts/dev.mjs:246,275`（本地自动预置的条件）
- Modify: `scripts/psd-font-bootstrap.mjs`（幂等判据与文案）
- Modify: `packages/cloudflare-psd/.dev.vars.example`
- Test: `tests/unit/scripts/psd-font-bootstrap.test.mjs`

- [ ] **Step 1: 改 `PSD_FONT_FALLBACKS` 的默认语义**

`packages/cloudflare-psd/wrangler.toml`：把 `PSD_FONT_FALLBACKS = ""` **整行删掉**（不是改成别的值）。留着空串等于显式选了逃生口——空链，中文层整层画不出来。删掉才是"未设"，取内置默认值。在原处留一条注释：

```toml
# PSD_FONT_FALLBACKS 刻意不设:未设 = 取内置字体那两套的名字
# (@unidocs/fonts-builtin 的 BUILTIN_FALLBACKS)。显式设成空串是**逃生口**,
# 意思是"一个候选都不试" —— 那会让中文层整层画不出来, 别拿它当"默认值"。
```

`stacks/unidocs-azure/deploy/service.bicep` 与 `deploy.mjs`：`--psd-font-fallbacks` 保持"不传就不注入这个环境变量"的既有行为（service.bicep:184 那段本来就是这么写的），只把参数说明里"灌完 seed-psd-fonts.mjs 之后必须配"改成：

```
不配 = 用内置字体那两套(拉丁 + 中文 8105 字)。只有装了额外字体、想改优先级时才配。
```

- [ ] **Step 2: 改本地自动预置的定位**

`scripts/dev.mjs:246,275`：`psdFontFallbacks()` 不再作为默认值传进去（默认值现在住在 `BUILTIN_FALLBACKS`）。`psdFontsEnabled` 保留——本地仍然自动灌那三套**全量**字体，因为其中 `JosefinSans-Bold` 是本地素材 PSD 点名的字体，而全量 `NotoSansSC` 比内置子集多两万多个码位。把这条的定位写清楚：

在 `scripts/psd-font-bootstrap.mjs` 的模块头补一段：

```
 * ## 它现在是"锦上添花"，不再是"功能的前提"
 *
 * 内置字体（@unidocs/fonts-builtin）随包走，`setText` 不跑这一步也能工作。这个
 * 脚本现在解决的是另外两件事：
 *   1. 本地素材 PSD 点名的 JosefinSans-Bold —— 灌上它那些层才是按原字形重排；
 *   2. 全量 NotoSansSC 比内置子集多两万多个码位（港台字形、扩展区、生僻字）。
 * 所以它失败仍然不阻断启动，而且现在连"功能默认是关着的"这个后果都没有了。
```

- [ ] **Step 3: 改 seed 脚本的文案**

`scripts/seed-psd-fonts.mjs` 模块头里那句「这个脚本就是往那张索引里写东西的唯一入口」改成：

```
 * 它是往**租户那一档**索引里写东西的唯一入口。内置那一档（@unidocs/fonts-builtin）
 * 随包走，不经这里 —— 租户登记的同名字体会**覆盖**内置的，那正是"装全量字体把内置
 * 子集换掉"的做法。
```

`scripts/psd-fonts.example.json` 的 `$comment` 里，「兜底要同时覆盖中英：只放一套拉丁字体的话，中文一个字都画不出来」改成：

```
"内置字体已经同时覆盖中英（拉丁全量 + 中文 8105 字），所以这里装什么都不会让中文",
"画不出来。这份配置现在是用来装**额外**字体的：素材点名的字体、或者覆盖内置子集的",
"全量中文字体（同名即覆盖）。",
```

- [ ] **Step 4: 跑受影响的脚本测试**

```bash
pnpm exec vitest run tests/unit/scripts/psd-font-bootstrap.test.mjs tests/unit/scripts/dev-vars.test.mjs
```

Expected: PASS。`psd-font-bootstrap.test.mjs:130` 那条找 `PSD_FONT_FALLBACKS=` 行的断言可能要跟着调整——按新语义改，别把它删掉。

- [ ] **Step 5: 提交**

```bash
git add -A packages/cloudflare-psd/wrangler.toml packages/cloudflare-psd/.dev.vars.example \
        stacks/unidocs-azure/deploy scripts tests/unit/scripts
git commit -m "chore(fonts): 配置与预置脚本改口径 —— seed 从'前提'降格为'锦上添花'

wrangler.toml 里的 PSD_FONT_FALLBACKS = \"\" 整行删掉而不是改值: 留着空串等于
显式选了逃生口(一个候选都不试), 中文层整层画不出来。删掉才是'未设', 取内置默认值。

seed-psd-fonts.mjs 现在是往**租户那一档**写东西的唯一入口, 装的是额外字体:
素材点名的字体, 或者覆盖内置子集的全量中文字体(同名即覆盖)。"
```

---

### Task 10: 文档、端到端与镜像断言

**Files:**
- Modify: `docs/psd-text-layers.md` §3、§5.4（R19 改写、内置层）
- Modify: `stacks/unidocs-azure/README.md:80` 附近（「新环境的字体预置」不再是必做项）
- Modify: `tests/integration/cloudflare/psd-fonts-e2e.test.mjs`
- Create: `packages/fonts-builtin/tests/packaged-files.test.ts`
- Modify: `stacks/unidocs-azure/deploy/smoke.mjs`（加一条 psd setText 断言）

- [ ] **Step 1: 写镜像/打包断言**

创建 `packages/fonts-builtin/tests/packaged-files.test.ts`：

```ts
/**
 * 守住"字节真的进了发行产物"。
 *
 * Dockerfile 用 `pnpm deploy --prod`，它**严格按 package.json 的 `files` 裁剪**。
 * 漏了 `fonts` 的症状与"这个环境从没灌过字体"一模一样：setText 还在工具表里，
 * 每次调用都取不到字形，不报错。那正是本次重构要消灭的症状，所以要有东西盯着。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_FONTS } from "../src/index.js";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

describe("发行产物", () => {
  it("package.json 的 files 必须同时包含 dist 与 fonts", async () => {
    const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("fonts");
    expect(pkg.files).toContain("dist");
  });

  it("exports 里有 ./package.json —— Node 侧加载器靠 require.resolve 找目录", async () => {
    const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      publishConfig: { exports: Record<string, unknown> };
    };
    expect(pkg.exports["./package.json"]).toBe("./package.json");
    expect(pkg.publishConfig.exports["./package.json"]).toBe("./package.json");
  });

  it("索引里点名的每个文件都真的在 fonts/ 下", async () => {
    for (const record of BUILTIN_FONTS) {
      await expect(readFile(join(PKG, "fonts", record.file))).resolves.toBeDefined();
    }
  });
});
```

- [ ] **Step 2: 改端到端测试**

`tests/integration/cloudflare/psd-fonts-e2e.test.mjs` 顶部那句「仓库里的字体文件：字体二进制不进仓库（裁定 R19），而 CI 上也没有系统字体」的前提没了。改成用**内置字体**跑一条真实排版，并保留原有的"装额外字体"路径：

```js
/**
 * 现在有两条路要走通：
 *  1. **不灌任何字体**，直接 setText —— 内置字体应当让中英混排都排得出来。
 *     这是本次重构的核心断言：新环境、新租户，零配置可用。
 *  2. 灌一套同名字体覆盖内置的 —— 索引里那条的 source 应当变成 tenant。
 */
```

- [ ] **Step 3: 给线上冒烟加一条 setText 断言**

在 `stacks/unidocs-azure/deploy/smoke.mjs` 的 psd 那一组里，`apply add_layer` 之后加：

```js
  // 内置字体的线上验收：不灌任何字体、直接改一个文字层的字。在这次重构之前，
  // Azure 线上这一条必然失败（索引是空的，一个字形都取不到）。
  await check("apply set_text 中英混排 → 成功", async () => {
    const res = await apply(docId, { kind: "set_text", payload: { layerId, text: "你好 UniDocs 2026" } });
    return res.success === true;
  });
```

- [ ] **Step 4: 改文档**

`docs/psd-text-layers.md` §5.4 第 3 条「字体二进制不进仓库（裁定 R19）」改写为：

```
3. **字体二进制只许提交子集**（裁定 R19，2026-09-08 收窄）：默认字体（拉丁全量 +
   中文《通用规范汉字表》8105 字子集，共约 2.5 MB）随包发行，见
   `packages/fonts-builtin`。全量字体（一套 5–20 MB）仍然不进仓库，走 CAS。
   收窄的理由：R19 原本的顾虑是"永远留在 git 历史里"，2.5 MB 不触发那个顾虑，
   而它换来的是"任何新环境、任何新租户零配置可用"。
```

§3 补一段说明两层来源（内置 / 租户）与覆盖语义。

`stacks/unidocs-azure/README.md` 的「新环境的字体预置」整节改成**可选步骤**，标题改为「装额外字体（可选）」，开头加：

```
> 新环境**不需要**做这一步。默认字体随镜像发行（`packages/fonts-builtin`），
> `setText` 开箱可用。这一节讲的是想装额外字体时怎么做 —— 比如覆盖内置的中文
> 子集，换成含港台字形与扩展区的全量字体。
```

- [ ] **Step 5: 全量验证**

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:local
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -A docs stacks tests packages/fonts-builtin/tests/packaged-files.test.ts
git commit -m "docs(fonts): 改写裁定 R19, 字体预置从必做降为可选; 补发行产物断言

R19 从'字节不进仓库'收窄为'只许提交有公开字表依据的子集': 原本的顾虑是'永远留在
git 历史里', 2.5MB 不触发那个顾虑, 而它换来的是任何新环境、任何新租户零配置可用。

packaged-files.test.ts 盯着 package.json 的 files 同时含 dist 与 fonts ——
pnpm deploy --prod 严格按它裁剪, 漏了 fonts 的症状与'从没灌过字体'一模一样:
setText 还在工具表里, 每次调用都取不到字形, 不报错。"
```

---

## 完成判据

1. **零配置可用**：一个全新的 Azure 部署、一个从没出现过的租户，第一篇 psd 文档的 `setText` 就能把中英混排排出来——不跑任何预置脚本。
2. **CAS 那条路一行未改**：`font_registry` 表、`0005_font_registry.sql`、`PsdFonts` DO 与它的 sqlite 表、`POST /tenants/{t}/fonts` 的鉴权与行为，全部与本计划开始前逐字节相同。
3. **覆盖可覆盖**：装一套同名的全量 `NotoSansSC-Regular`，索引里那条的 `source` 从 `builtin` 变成 `tenant`。
4. **`setText` 不再消失**：CF 不配 `PSD_FONTS`、Azure 不配 `PSD_FONT_FALLBACKS`，两个栈的工具表仍然相等且都含 `apply_set_text`。
5. **生成物守得住**：手改 `src/fonts.generated.ts` 或换掉 `fonts/` 里的字节而不重跑脚本，`tests/generated-index.test.ts` 当场变红。
6. **`install` 是可选成员**：`createFontRegistry({providers: []}).install === undefined`，仓库里没有一行只会抛异常的空壳。
