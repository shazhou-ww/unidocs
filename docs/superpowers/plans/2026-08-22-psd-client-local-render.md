# PSD 前端渲染 · 计划 4：浏览器本地渲染（psd-client）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `@unidocs/psd-client`，让浏览器**本地渲染** PSD：Worker 里常驻一个 `IncrementalCompositor` + `PixelCache`（跨编辑复用），冷启动从服务端取 IR、按需从 CAS 拉图层 blob，本地 `applyOp` 后只重合成脏 tile 并贴到 `<canvas>`；接进 `web-psd`，替掉"每次编辑等一张整图 PNG"的路径。做完后切图层是本地毫秒级，而非 10s。

**Architecture:** 主线程 `RenderClient` 持有 Worker；Worker 持有 `IncrementalCompositor`（`ctx.store = CasBlobStore`，一个常驻 `PixelCache`）。编辑 → 主线程本地 `applyOne` 推进 doc（乐观）→ 发 op 给 Worker → Worker `applyOp` 只重算脏 tile → 回传 tile 像素（transferable）→ `Viewport` 贴到 canvas。op 同时**尽力提交**服务端 `/apply`（本计划不做 409 rebase——留给 Plan 5）。冷启动 `GET …/snapshot`→`GET …/cas/nodes/{hash}/content`→`deserialize`。

**Tech Stack:** TypeScript、Vite（web-psd）、Web Worker、`@unidocs/doctype-psd/engine`（`IncrementalCompositor`/`deserialize`/`PixelCache`/`applyOne`/types）、fast-png（引擎内部）。测试 vitest（纯逻辑 + mock fetch）；集成靠跑真应用验证。

**Spec:** `docs/superpowers/specs/2026-08-21-psd-frontend-render-model-design.md` §1（包划分 psd-client）、§2（冷启动、乐观本地编辑；409 rebase 留 Plan 5）、§4（Worker 池 + Viewport；本计划先单 Worker，池化/LOD 留后续）。

## Global Constraints

- **本地渲染像素正确**：本地合成必须用引擎的 `IncrementalCompositor`（已在 Plan 1-3 证明与 `render(doc)` 逐位一致），不得另写合成。
- **常驻缓存是性能关键**：Worker 内**只创建一次** `IncrementalCompositor` 和 `PixelCache`，跨编辑复用；**绝不**每次编辑新建缓存（这正是服务端 `queries.ts:69` 慢的根因）。
- **浏览器安全**：只从 `@unidocs/doctype-psd/engine` 子入口引入（零 ag-psd）；psd-client 无 node-only 依赖。
- **不改服务端渲染/引擎逻辑**：本计划只加客户端包 + web-psd 接线；op 提交复用现有 `/apply`。
- **工作区约定**：新包 `@unidocs/psd-client` 按 README「Workspace package resolution」——`exports`/`main`/`types` 指 `src/*.ts` + `publishConfig` 重写 `dist/*`；`typecheck` 用 `tsc -b`。
- 坐标 `[top,left,bottom,right]`；tile 用引擎的 `tileRegion`/`allTiles`/`tilesForRect`。
- 测试命令：`pnpm --filter @unidocs/psd-client test <fragment>`。

## 引擎已导出、本计划消费的接口

- `IncrementalCompositor(doc, { tileSize?, ctx? })`：`applyOp(op):Promise<Rect>`、`composite():Promise<Pixels>`、`readTile(tx,ty):Promise<Pixels>`、`get doc`、`get tileSize`。
- `deserialize(bytes: Uint8Array, store: BlobStore): PsdDoc`（懒 doc）。
- `type BlobStore { get(hash):Promise<Uint8Array|null>; put(bytes):Promise<string> }`、`PixelCache(maxBytes)`、`DEFAULT_CACHE_BYTES`。
- `applyOne(doc, op)`、`type PsdOp`、`type PsdDoc`、`type Pixels`、`allTiles`/`tilesForRect`/`tileRegion`/`tileKey`/`type Tile`、`type RenderCtx`。

---

## File Structure

- **Create** `packages/psd-client/package.json` / `tsconfig.json`（工作区约定；deps: `@unidocs/doctype-psd`, devDeps: typescript/vitest）。
- **Create** `packages/psd-client/src/cas-blob-store.ts` — `CasBlobStore implements BlobStore`（HTTP）。
- **Create** `packages/psd-client/src/doc-source.ts` — `loadDoc(gw,user,type,docId)` 冷启动 → `{ doc, version }`。
- **Create** `packages/psd-client/src/render-core.ts` — `RenderCore`（纯：持有 IncrementalCompositor+CasBlobStore+常驻 PixelCache；`applyOp`/`tile`/`composite`）。Worker 无关，node 可测。
- **Create** `packages/psd-client/src/render-worker.ts` — Worker 入口：把 postMessage 协议绑到一个 `RenderCore`。
- **Create** `packages/psd-client/src/render-client.ts` — 主线程 `RenderClient`：起 Worker、发 op/viewport、收 tile。
- **Create** `packages/psd-client/src/viewport.ts` — `Viewport`：canvas + pan/zoom 坐标 + 贴 tile。
- **Create** `packages/psd-client/src/index.ts` — barrel。
- **Modify** `packages/web-psd/index.html` — `#view` img → `<canvas id="view">`。
- **Modify** `packages/web-psd/src/main.ts` — 用 psd-client 本地渲染替代 getPreview 轮询；保留 create/export/chat。
- **Create** tests：`cas-blob-store.test.ts`、`doc-source.test.ts`、`render-core.test.ts`、`viewport.test.ts`。

---

## Task 1: 包脚手架 + `CasBlobStore`

**Files:** Create `packages/psd-client/{package.json,tsconfig.json,src/cas-blob-store.ts,src/index.ts}`, `tests/cas-blob-store.test.ts`.

**Interfaces:**
- Produces: `class CasBlobStore implements BlobStore`，`constructor(opts: { gw: string; user: string; fetchImpl?: typeof fetch })`；`get(hash): Promise<Uint8Array|null>` = `GET {gw}/users/{user}/cas/nodes/{hash}/content`（404→null，200→bytes）；`put(bytes): Promise<string>` = 计算 sha-256 hash → `POST {gw}/users/{user}/cas/nodes/{hash}`（body=bytes），返回 hash。（put 供 Plan 5+ 画笔/导入用；本计划实现但不接线。）

- [ ] **Step 1: 建包脚手架**

`package.json`（镜像现有库包，如 `packages/cas/package.json` 的形状）：`name:"@unidocs/psd-client"`, `type:"module"`, `exports`/`main`/`types` → `./src/index.ts` + `publishConfig` → `dist`；`dependencies: { "@unidocs/doctype-psd": "workspace:*" }`；`devDependencies: typescript ^5.9, vitest ^3.2`；scripts `test:"vitest run"`, `typecheck:"tsc -b"`, `build:"tsc"`。`tsconfig.json` 镜像 `packages/doctype-psd/tsconfig.json`（references 到 doctype-psd）。`src/index.ts` 先空导出占位。

- [ ] **Step 2: 写失败测试（mock fetch）**

`tests/cas-blob-store.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { CasBlobStore } from "../src/cas-blob-store.js";

function mockFetch(routes: Record<string, { status: number; body?: Uint8Array }>): typeof fetch {
  return (async (url: string) => {
    const r = routes[String(url)] ?? { status: 404 };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, arrayBuffer: async () => (r.body ?? new Uint8Array()).buffer } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("CasBlobStore.get", () => {
  it("GETs cas content and returns bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const s = new CasBlobStore({ gw: "/gw", user: "u1", fetchImpl: mockFetch({ "/gw/users/u1/cas/nodes/abc/content": { status: 200, body: bytes } }) });
    expect([...(await s.get("abc"))!]).toEqual([1, 2, 3]);
  });
  it("returns null on 404", async () => {
    const s = new CasBlobStore({ gw: "/gw", user: "u1", fetchImpl: mockFetch({}) });
    expect(await s.get("missing")).toBeNull();
  });
});
```

- [ ] **Step 3: 实现 `CasBlobStore`** — `get` 拼 URL、fetch、404→null、否则 `new Uint8Array(await r.arrayBuffer())`。`put` 用 WebCrypto `crypto.subtle.digest("SHA-256", bytes)` → hex → POST。默认 `fetchImpl = globalThis.fetch`。从 `index.ts` 导出。

- [ ] **Step 4: 跑测试通过 + typecheck**

Run: `pnpm --filter @unidocs/psd-client test cas-blob-store` → PASS；`pnpm --filter @unidocs/psd-client typecheck`。

> 若新包 typecheck 因 project references 失败，确认 root `tsconfig.json` 与 doctype-psd 的 references 配好（README「Workspace package resolution」）。

- [ ] **Step 5: 提交**

```bash
git add packages/psd-client
git commit -m "feat(psd-client): package scaffold + CasBlobStore (HTTP BlobStore)"
```

---

## Task 2: `loadDoc` 冷启动（snapshot → IR → deserialize）

**Files:** Create `packages/psd-client/src/doc-source.ts`, `tests/doc-source.test.ts`. Modify `src/index.ts`.

**Interfaces:**
- Produces: `loadDoc(opts: { gw: string; user: string; type: string; docId: string; store: BlobStore; fetchImpl?: typeof fetch }): Promise<{ doc: PsdDoc; version: number }>` —— `GET {gw}/users/{user}/docs/{type}/{docId}/snapshot` → `{version, hash}`；`store.get(hash)` 取 IR JSON bytes；`deserialize(irBytes, store)` → 懒 doc。（IR 走 CasBlobStore 同一 CAS 内容端点，所以复用 `store.get`。）

- [ ] **Step 1: 写失败测试** — mock fetch 返回 snapshot `{success:true,version:3,hash:"ir1"}`；mock store 返回 `ir1` → 一段最小 IR JSON（`{"canvas":{...},"layers":[]}` 的 bytes）；断言 `loadDoc` 返回 `{doc:{canvas,layers:[]}, version:3}`。用一个内存 `BlobStore` mock（`get(h)` 从 Map 取）。

```typescript
import { describe, it, expect } from "vitest";
import { loadDoc } from "../src/doc-source.js";
import type { BlobStore } from "@unidocs/doctype-psd/engine";

const irJson = JSON.stringify({ canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [] });
const memStore = (m: Record<string, Uint8Array>): BlobStore => ({ async get(h) { return m[h] ?? null; }, async put() { return ""; } });
const snapFetch = (): typeof fetch => (async () => ({ ok: true, json: async () => ({ success: true, version: 3, hash: "ir1" }) } as unknown as Response)) as unknown as typeof fetch;

describe("loadDoc", () => {
  it("fetches snapshot hash → IR bytes → deserialized doc + version", async () => {
    const store = memStore({ ir1: new TextEncoder().encode(irJson) });
    const { doc, version } = await loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: snapFetch() });
    expect(version).toBe(3);
    expect(doc.canvas.width).toBe(2);
    expect(doc.layers).toEqual([]);
  });
});
```

- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** 实现 `loadDoc`：fetch snapshot（解 `{version,hash}`）；`const ir = await store.get(hash)`（null→抛 "IR blob missing"）；`return { doc: deserialize(ir, store), version }`。导出。`pnpm --filter @unidocs/psd-client test doc-source` PASS + typecheck。

- [ ] **Step 5: 提交** `git commit -m "feat(psd-client): loadDoc cold-start (snapshot → IR → deserialize)"`

---

## Task 3: `RenderCore`（常驻合成器，node 可测）

Worker 无关的纯核——所有本地渲染状态在此，Worker 只是它的消息外壳。

**Files:** Create `packages/psd-client/src/render-core.ts`, `tests/render-core.test.ts`. Modify `src/index.ts`.

**Interfaces:**
- Produces: `class RenderCore`：
  - `constructor(doc: PsdDoc, store: BlobStore, opts?: { tileSize?: number; cacheBytes?: number })` —— 内部 `new IncrementalCompositor(doc, { tileSize, ctx: { store, cache: new PixelCache(cacheBytes ?? DEFAULT_CACHE_BYTES) } })`。**缓存和合成器只建一次**。
  - `applyOp(op: PsdOp): Promise<[number,number,number,number]>` —— 委托 `compositor.applyOp`（返回脏矩形）。
  - `tile(tx, ty): Promise<Pixels>` —— 委托 `compositor.readTile`。
  - `composite(): Promise<Pixels>`、`get doc`、`get tileSize`。

- [ ] **Step 1: 写测试（用 mock BlobStore 喂 PNG blob）** —— 构造一个含 1-2 raster 图层的懒 doc（图层 pixels 为 `PixelRef{hash}`），mock store 用 `fast-png` 编码好的 PNG bytes 应答对应 hash；`RenderCore.composite()` 逐位等于引擎 `render(residentEquivalentDoc)`。再断言：连续两次 `applyOp`(set_props opacity on 同一层) 后 `composite()` 与 `render(doc)` 一致（复用常驻缓存，不重复 fetch——可用 mock store 的调用计数断言 blob 只 fetch 一次）。

> 说明：这把"常驻缓存跨编辑复用、只 fetch 一次"这条**性能关键不变量**变成可测断言（mock store 的 `get` 调用计数：初次合成 fetch 每层一次，之后 set_props opacity 不再 fetch）。

- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** 实现 `RenderCore`（薄封装）。`pnpm --filter @unidocs/psd-client test render-core` PASS + typecheck。

- [ ] **Step 5: 提交** `git commit -m "feat(psd-client): RenderCore — persistent IncrementalCompositor over a CAS BlobStore"`

---

## Task 4: `Viewport` + `RenderClient`/Worker 接线

**Files:** Create `packages/psd-client/src/viewport.ts`, `src/render-worker.ts`, `src/render-client.ts`, `tests/viewport.test.ts`. Modify `src/index.ts`.

**Interfaces:**
- `Viewport`：`constructor(canvas: HTMLCanvasElement)`；`setDoc(size:{width,height})`；`draw(tx,ty, px: Pixels, tileSize)`（`putImageData` 到 canvas 对应位置，考虑 pan/zoom 变换）；pan/zoom 状态 + `screenToCanvas`/`canvasToScreen`（**坐标数学单测**，与 canvas 无关的部分抽成纯函数 `viewTransform`）。
- `render-worker.ts`：Worker 入口，`onmessage`：`{type:"init", ir, ...}`→建 RenderCore；`{type:"applyOp", op}`→`applyOp` 后回 `{type:"dirty", rect}`；`{type:"tiles", tiles:[[tx,ty]...]}`→逐个 `core.tile` 回 `{type:"tile", tx, ty, width, height, data(transferable)}`。
- `RenderClient`（主线程）：`constructor(worker: Worker)`；`init(...)`、`applyOp(op)`、`requestTiles(list)`、`onTile(cb)`。**只测 Viewport 的纯坐标数学**；Worker/RenderClient 是薄消息胶水，靠 Task 5 跑应用验证。

- [ ] **Step 1: 写 `viewport` 坐标数学失败测试** —— `viewTransform({pan:{x,y}, zoom}, ...)`：screen↔canvas 往返一致；给定 viewport 矩形算出可见 tile 列表（复用 `tilesForRect`）。

- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** 实现 `viewport.ts`（纯 `viewTransform` + 可见 tile 计算 + 一个薄 `Viewport` 类做实际 canvas 绘制）、`render-worker.ts`、`render-client.ts`。`pnpm --filter @unidocs/psd-client test viewport` PASS + typecheck（Worker/DOM 类型用 `lib: ["ES2022","DOM","WebWorker"]`）。

- [ ] **Step 5: 提交** `git commit -m "feat(psd-client): Viewport coords + Worker render client"`

---

## Task 5: 接进 `web-psd`（替掉 getPreview 轮询）+ 跑通验证

**Files:** Modify `packages/web-psd/index.html`（`#view` img→`<canvas id="view">`）、`packages/web-psd/src/main.ts`、`packages/web-psd/package.json`（加 `@unidocs/psd-client` dep）。

**Interfaces:** Consumes psd-client barrel。无新导出。

- [ ] **Step 1: 壳改 canvas** —— `index.html` 把 `<img id="view">` 换 `<canvas id="view">`；样式保持 `#stage` 容器。

- [ ] **Step 2: main.ts 接本地渲染**
  - create/open 后：不再 `refreshView()` 拉 getPreview；改为 `const { doc, version } = await loadDoc({gw:GW,user:USER,type:TYPE,docId, store: new CasBlobStore({gw:GW,user:USER})})`；`renderClient.init(doc)`；`viewport.setDoc(doc.canvas)`；请求可见 tile 并绘制。
  - `dispatch(op)`（可见性/opacity 滑块）：先本地 `renderClient.applyOp(op)` → 拿脏矩形 → 请求脏区可见 tile 重绘（**即时**）；**同时**后台 `POST /apply {operations:[op], baseVersion:version}` 尽力提交，200 则 `version=res.version`，409 则暂时 `location.reload()` 兜底（真正的 rebase 是 Plan 5）。
  - `refreshLayers()` 保留（仍可从本地 doc 或 getLayers 取）——优先用本地 doc 的图层列表，省一次往返。
  - export（`/export` GET）、chat（`/run`）保留；chat 后因服务端改了 doc，简单起见 `location.reload()` 重取（Plan 5 做增量 reconcile）。

- [ ] **Step 3: 本地起应用、实测切图层延迟**

用 `run` 技能或手动：`pnpm dev psd` 起 gateway+psd+web-psd；浏览器打开、上传一个大 PSD（≥50 层/≥4000px）、切图层可见性。**验证：首帧后切图层是本地即时（<100ms 量级），不再 10s。** 用 Chrome DevTools（web-perf 技能）量交互延迟 + 确认切图层时**没有** getPreview 整图请求。把测量结果写进报告。

> 这一步的"测试"是**运行时验证**（浏览器实测延迟），不是 vitest——因为这是 DOM/Worker/应用集成。若首帧慢（初次 fault-in 所有 blob），可接受（一次性）；关键是**后续编辑本地即时**。

- [ ] **Step 4: 提交**

```bash
git add packages/web-psd
git commit -m "feat(web-psd): local canvas render via psd-client (kills per-edit full-render round trip)"
```

---

## Self-Review

- **Spec coverage**：§1 psd-client 包 → Task 1-4；§2 冷启动 + 乐观本地编辑 → Task 2/5（409 rebase 明确留 Plan 5）；§4 Worker + Viewport（单 Worker，池化/LOD 留后续）→ Task 4。
- **性能关键不变量**：常驻 `IncrementalCompositor`+`PixelCache` 跨编辑复用（Task 3 用 mock store 调用计数断言只 fetch 一次）——直接对治服务端每次新建缓存的根因。
- **Placeholder scan**：无 TBD；纯逻辑任务给了可运行测试；Task 5 集成用运行时验证（明确标注）。
- **Type consistency**：`CasBlobStore(BlobStore)`、`loadDoc(...)→{doc,version}`、`RenderCore(doc,store,opts)`、`Viewport`、`RenderClient`——签名全计划一致；渲染复用引擎 `IncrementalCompositor`。
- **风险**：Task 5 是 DOM/Worker 集成，vitest 测不到 → 靠跑真应用 + DevTools 实测兜底；Worker bundling（Vite `new Worker(new URL(...),{type:"module"})`）需确认打包正确。

## 后续（Plan 5）

`DocSession`（`baseVersion`/pending/**409 rebase**/op-id 幂等）、agent 并发增量 reconcile（替掉 Task 5 的 `location.reload()` 兜底）、Class B(`generative_fill`) 占位→新 blob、画笔/导入(`CasBlobStore.put`)。Worker 池 + 拖拽 LOD 亦可并入或单列。
