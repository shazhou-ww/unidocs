# 内存架构重构实施计划(IR + 按需像素 + 流式合成)

> **给执行者:** 必需子技能:用 superpowers:executing-plans 或 subagent-driven-development 按任务逐步实现。步骤用 `- [ ]` 勾选跟踪。

**目标(一句话):** 把"加载即全解码所有图层像素(~800MB,爆 128MB DO 内存 → 卡死)"改成"结构常驻 + 像素按需从外存流式加载 + framebuffer 常驻",让渲染峰值内存与图层数量无关、稳进 128MB。

**架构(2-3 句):** 文档真相从"PSD 二进制快照"改为"IR(JSON,结构 + 每层像素哈希)+ init op + delta";每层像素以 PNG 存 R2 CAS,按哈希寻址、去重。渲染改为**异步流式合成**:自下而上逐层从外存拉取像素→混入唯一的 framebuffer→立即释放,隐藏层跳过,配一个有容量上限的热缓存。

**技术栈:** TypeScript(ESM)、vitest、ag-psd(读写 PSD)、fast-png(PNG 编解码)、Cloudflare R2(CAS)、Durable Object。

**Spec:** 本计划即 spec(源于 2026-08-20 的架构讨论)。保真度守护见 `packages/doctype-psd/tests/fidelity.test.ts` 与 `tests/support/fidelity.ts`。

## 全局约束(每个任务都隐含遵守)

- **保真度不回退**:每个阶段结束,`pnpm --filter @unidocs/doctype-psd exec vitest run fidelity` 三个数字必须不变(sample mean=0;landing mean≤0.2;fashion mean≤0.3)。渲染改异步后,harness 也改 `await`。这是"输出不变、只改内存"的硬证据。
- **对齐 PSD 语义,不自造概念**。
- **像素绝不内联进 op/JSON 的 base64**(会撞 SQLITE_TOOBIG);像素一律进 R2 CAS,IR 里只放哈希。
- 坐标系 `[top,left,bottom,right]`,y 向下。
- 本计划跨两个子系统:**Phase 0-2 全在 `doctype-psd` 内**(可用内存版 BlobStore 完整单测);**Phase 3 进 `cloudflare-sdk`/`editor-do`**(持久化 + init op 接线)。建议分两阶段执行、各自可独立交付。

---

## Phase 0:超大图层导入时裁到画布(独立速赢)

**背景:** 实测最大单层像素 70MB(3556×2000 画布,但该层像素 17.5M px > 画布 7.1M px),超出画布的部分渲染时也用不到。裁到画布可让该层 70MB→≤28MB,与后续重构解耦。

### Task 0: 加载时把图层像素裁剪到画布范围

**Files:**
- Modify: `packages/doctype-psd/src/psd/load.ts`(`mapLayer` 内 `px` 构造处,约 43-45 行)
- Test: `packages/doctype-psd/tests/load-crop.test.ts`(新建)

**Interfaces:**
- Consumes: `AgLayer`(ag-psd)、`Layer.bounds`、`Canvas`
- Produces: `cropPixelsToCanvas(px, bounds, canvasW, canvasH): { pixels, bounds }` —— 返回裁剪后的像素与更新后的 bounds

- [ ] **Step 1: 写失败测试** —— 一个 bounds 超出画布的图层,加载后 pixels 尺寸与 bounds 被裁到画布内。

```ts
// load-crop.test.ts
import { describe, it, expect } from "vitest";
import { cropPixelsToCanvas } from "../src/psd/load.js";
it("crops a layer that overflows the canvas", () => {
  // 4x4 layer at bounds [-1,-1,3,3] on a 2x2 canvas → clipped to [0,0,2,2], 2x2 px
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(200);
  const out = cropPixelsToCanvas({ width: 4, height: 4, data }, [-1, -1, 3, 3], 2, 2);
  expect(out.bounds).toEqual([0, 0, 2, 2]);
  expect(out.pixels.width).toBe(2);
  expect(out.pixels.height).toBe(2);
});
```

- [ ] **Step 2: 运行,确认失败**(`cropPixelsToCanvas is not a function`)。
Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/load-crop.test.ts`

- [ ] **Step 3: 实现并导出 `cropPixelsToCanvas`**,在 `mapLayer` 里对每个有像素、且 bounds 超出画布的图层调用它。

```ts
// load.ts —— 导出，纯函数
export function cropPixelsToCanvas(
  px: { width: number; height: number; data: Uint8ClampedArray },
  bounds: [number, number, number, number],
  cw: number, ch: number,
): { pixels: { width: number; height: number; data: Uint8ClampedArray }; bounds: [number, number, number, number] } {
  const [top, left, bottom, right] = bounds;
  const nt = Math.max(0, top), nl = Math.max(0, left);
  const nb = Math.min(ch, bottom), nr = Math.min(cw, right);
  if (nt === top && nl === left && nb === bottom && nr === right) return { pixels: px, bounds };
  const nw = Math.max(0, nr - nl), nh = Math.max(0, nb - nt);
  const data = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = nl - left + x, sy = nt - top + y;
      const si = (sy * px.width + sx) * 4, di = (y * nw + x) * 4;
      data[di] = px.data[si]; data[di + 1] = px.data[si + 1];
      data[di + 2] = px.data[si + 2]; data[di + 3] = px.data[si + 3];
    }
  }
  return { pixels: { width: nw, height: nh, data }, bounds: [nt, nl, nb, nr] };
}
```
在 `mapLayer` 中,`bounds` 与 `px` 定好后,用画布尺寸调用一次并用返回值覆盖 `px`/`bounds`。(注:画布尺寸在 `load()` 里已知,`mapLayer` 需接收 `cw,ch` 参数。)

- [ ] **Step 4: 运行,确认通过**;并跑全量 `pnpm --filter @unidocs/doctype-psd test` 确认保真度三数不变。

- [ ] **Step 5: 提交** `feat(psd): crop overflowing layer pixels to canvas on load`。

---

## Phase 1:异步流式合成(核心内存修复,`doctype-psd` 内)

**背景:** 渲染当前是同步的、且假设每层 `pixels.data` 已解码常驻。改为:像素来源抽象成"resident 或 lazy(哈希+加载器)";渲染改异步,自下而上逐层解析→混合→释放;隐藏层跳过;配容量上限的 LRU 热缓存。用内存版存储做单测,保真度守护。

### Task 1: 像素来源抽象 `PixelSource` + 解析器

**Files:**
- Modify: `packages/doctype-psd/src/model/types.ts`
- Create: `packages/doctype-psd/src/render/pixel-source.ts`
- Test: `packages/doctype-psd/tests/pixel-source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Pixels { width: number; height: number; data: Uint8ClampedArray; }
  export interface PixelRef { width: number; height: number; hash: string; } // 外存中的 PNG
  export type PixelSource = Pixels | PixelRef;
  export const isRef = (p: PixelSource): p is PixelRef => "hash" in p && !("data" in (p as any));
  // Layer.pixels?: Pixels  →  Layer.pixels?: PixelSource
  export interface BlobStore { put(bytes: Uint8Array): Promise<string>; get(hash: string): Promise<Uint8Array | null>; }
  // resolvePixels(src, store, cache): Promise<Pixels>  —— ref 则从 store 取 PNG 解码；resident 直接返回
  ```

- [ ] **Step 1: 写失败测试** —— resident 直接返回;ref 从内存 store 取 PNG 解码为 Pixels;第二次命中缓存不再触达 store。

```ts
// pixel-source.test.ts
import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import { resolvePixels, type PixelSource, type BlobStore } from "../src/render/pixel-source.js";
import { PixelCache } from "../src/render/pixel-source.js";

function memStore(): BlobStore & { gets: number; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>(); let gets = 0;
  return { blobs, get gets() { return gets; },
    async put(b) { const h = `h${blobs.size}`; blobs.set(h, b); return h; },
    async get(h) { gets++; return blobs.get(h) ?? null; } } as any;
}
it("resident passes through; ref decodes from store then caches", async () => {
  const store = memStore();
  const data = new Uint8ClampedArray([1,2,3,255]);
  const png = encode({ width: 1, height: 1, data, channels: 4, depth: 8 });
  const hash = await store.put(png);
  const cache = new PixelCache(4);
  const ref: PixelSource = { width: 1, height: 1, hash };
  const a = await resolvePixels(ref, store, cache);
  expect([...a.data]).toEqual([1,2,3,255]);
  await resolvePixels(ref, store, cache);
  expect(store.gets).toBe(1); // second call served from cache
});
```

- [ ] **Step 2: 运行,确认失败。**

- [ ] **Step 3: 实现 `pixel-source.ts`**:`resolvePixels`、`PixelCache`(容量上限的 LRU,按解码字节数或条目数计;超限淘汰最久未用),`isRef`。`model/types.ts` 把 `Layer.pixels` 类型改为 `PixelSource`。

- [ ] **Step 4: 运行,确认通过。**

- [ ] **Step 5: 提交** `feat(psd): PixelSource abstraction (resident|ref) + LRU cache`。

### Task 2: 渲染改异步 + 流式解析 + 跳过隐藏层

**Files:**
- Modify: `packages/doctype-psd/src/render/composite.ts`(`render`/`renderList`/`applyLayer`/`layerAlpha`/`renderCached`/`renderRegion`/`renderLayer`)
- Modify: `packages/doctype-psd/src/render/index.ts`(导出签名改 async)
- Modify: `packages/doctype-psd/src/queries.ts`(`runQuery` 内 `await`)
- Modify: `packages/doctype-psd/tests/support/fidelity.ts` 及各渲染测试(改 `await render(...)`)
- Test: `packages/doctype-psd/tests/render-streaming.test.ts`(新建)

**Interfaces:**
- Consumes: `PixelSource`、`BlobStore`、`PixelCache`、`resolvePixels`
- Produces:
  ```ts
  // 渲染入口带上 store/cache(resident-only 文档可传 no-op store)
  export function render(doc: PsdDoc, ctx?: RenderCtx): Promise<Pixels>;
  export function renderRegion(doc: PsdDoc, rect: Rect, ctx?: RenderCtx): Promise<Pixels>;
  export function renderLayer(doc: PsdDoc, layerId: string, opts?, ctx?: RenderCtx): Promise<Pixels>;
  export interface RenderCtx { store: BlobStore; cache: PixelCache; }
  ```

- [ ] **Step 1: 写失败测试** —— 一个含 `PixelRef` 层的文档能渲染出正确合成(证明流式 fault-in 生效),且渲染过程中同一时刻只解析一层(用带计数的 store 验证峰值并发=1)。

```ts
// render-streaming.test.ts —— 两个 1x1 层(ref)叠加，验证合成结果 + 顺序 fault-in
```

- [ ] **Step 2: 运行,确认失败。**

- [ ] **Step 3: 实现**:`applyLayer`/`layerAlpha` 变 async;需要像素处 `await resolvePixels(layer.pixels, ctx.store, ctx.cache)`;`renderList` 顺序 `await` 每层(自下而上,保证同一时刻只驻留"当前层 + framebuffer + 有界 scratch");`if (!layer.visible) continue` 早于任何 fault-in(隐藏层永不解码)。`renderCached` 的 framebuffer 单槽保持,键仍是 doc 身份;缓存的是 Promise<Pixels> 以防并发重复渲染。

- [ ] **Step 4: 更新所有同步调用点为 `await`**(queries.ts、fidelity.ts、render-*.test.ts、render-drop-shadow/fill-stroke/adjust 等)。

- [ ] **Step 5: 运行全量测试 + 保真度**,确认三数不变、全绿。
Run: `pnpm --filter @unidocs/doctype-psd test`

- [ ] **Step 6: 提交** `refactor(psd): async streaming compositor, skip hidden, fault-in pixels`。

---

## Phase 2:CAS 序列化(IR JSON + 每层 PNG)

**背景:** 把文档序列化为"IR(结构 + 每层像素哈希)JSON",像素单独 PNG 进 BlobStore。反序列化得到 lazy 层(`PixelRef`),不解码像素。用内存 store 做 round-trip 单测。

### Task 3: `serialize`/`deserialize`(注入 BlobStore)

**Files:**
- Create: `packages/doctype-psd/src/psd/ir.ts`
- Test: `packages/doctype-psd/tests/ir-roundtrip.test.ts`

**Interfaces:**
- Consumes: `PsdDoc`、`PixelSource`、`BlobStore`、`encode`/`decode`(fast-png)
- Produces:
  ```ts
  export function serialize(doc: PsdDoc, store: BlobStore): Promise<Uint8Array>; // JSON(TextEncoder)
  export function deserialize(bytes: Uint8Array, store: BlobStore): Promise<PsdDoc>; // 像素为 PixelRef
  ```
  规则:每个 resident `Pixels` → `store.put(PNG)` → IR 里存 `{width,height,hash}`;已是 `PixelRef` 的直接沿用其 hash;mask 像素同样处理。IR JSON 里**绝不含像素字节**。

- [ ] **Step 1: 写失败测试** —— 一个含像素的 doc,`serialize` 后 IR JSON 里不含像素数组(只含 hash),store 里有对应 PNG;`deserialize` 得到 `PixelRef` 层;再 `resolvePixels` 能还原原像素。

- [ ] **Step 2: 运行,确认失败。**

- [ ] **Step 3: 实现 `ir.ts`**(递归遍历图层,像素/蒙版转 PNG 存 store,结构转普通 JSON;反向重建 PixelRef)。

- [ ] **Step 4: 运行,确认通过。**

- [ ] **Step 5: 提交** `feat(psd): IR serialize/deserialize with per-layer PNG blobs`。

### Task 4: doctype 暴露 CAS 感知的存取 + init op

**Files:**
- Modify: `packages/doctype-psd/src/doctype.ts`(挂上 `serialize`/`deserialize`)
- Modify: `packages/doctype-psd/src/ops/index.ts`(新增 `init` op handler:payload=IR,直接置换 doc)
- Modify: `packages/protocol/src/types.ts`(`DocumentType` 增加可选 `serialize?/deserialize?(…, store)`)
- Test: `packages/doctype-psd/tests/init-op.test.ts`

**Interfaces:**
- Produces: `PsdOp` 新增 `{ kind: "init"; payload: <IR-json> }`;`applyOne` 支持 `init`。

- [ ] **Step 1: 写失败测试** —— `apply([{kind:"init", payload: ir}], emptyDoc)` 得到与 ir 等价的 doc;`init` 覆盖而非合并。

- [ ] **Step 2-4:** 实现 + 跑通。

- [ ] **Step 5: 提交** `feat(psd): init op + CAS-aware DocumentType hooks`。

---

## Phase 3:SDK/持久化接线(`cloudflare-sdk`,建议作为独立第二计划执行)

**背景:** 让 `editor-do` 用 BlobStore-backed 的 `serialize`/`deserialize` 存快照(IR JSON,不再是 PSD 二进制);导入时写 init op(载荷 IR);像素进 R2 CAS;原 PSD 二进制归档到独立 key(供重新导出/保真对比),不再是状态路径。

### Task 5: R2 BlobStore 适配器
- Create: `packages/cloudflare-sdk/src/blob-store.ts` —— 用 `env.CAS` 实现 `BlobStore`(`put` 用 SHA-256 十六进制前若干字节做 key,与现有 CAS 寻址一致;`get` 走 `env.CAS.get`)。单测用 miniflare/内存桩。

### Task 6: editor-do 改用 IR 快照 + init op
- Modify: `packages/cloudflare-sdk/src/editor-do.ts`:`#saveSnapshot*` 存 `serialize(doc, blobStore)` 的字节;`#ensureLoaded` 用 `deserialize(bytes, blobStore)`;`create`/`init_from_hash` 导入时:先 `load(psdBytes)` 得 IR、`serialize` 出像素 blobs、v1 delta 记为 `init` op;把原 PSD 二进制 `put` 到归档 key(非状态)。
- **验证:** 冷启动加载不再解码全部像素(measure RSS);删除图层→重合成→getPreview 全程 < 128MB;导出 PSD 仍能还原(round-trip)。

### Task 7: 内存与保真联合验收
- 在 `doctype-psd` 加一个 gated 集成测:用内存 store 加载 landing、跑一次 `renderCached`,采样峰值 RSS,断言"scratch + 当前层"驻留远小于全量;保真度三数不变。
- 手动用真实 DO 复现"删相框"路径,确认不再卡死。

---

## 自查(对照 spec)

1. **覆盖:** 卡死根因=全解码常驻 → Phase 1 流式合成 + Phase 0 裁剪解决驻留;snapshot 语义偏差 → Phase 2-3 改 IR + init op;可见常驻/不可见外存 → Phase 1 跳过隐藏 + LRU 热缓存 + Phase 3 CAS 外存。
2. **无占位符:** 关键函数(cropPixelsToCanvas、resolvePixels、serialize)均给出实现或精确签名。
3. **类型一致:** `Pixels`/`PixelRef`/`PixelSource`/`BlobStore`/`RenderCtx` 跨任务同名一致;`render*` 全部返回 `Promise`。
4. **安全网:** 每阶段以保真度三数不变为验收。

---

## Phase 3 必备输入(来自 Phase 0-2 最终评审,务必先解决)

Phase 0-2 已落地(异步流式合成 + PixelSource + IR 序列化 + init op),对常驻文档保真度逐字节不变、84 测试全绿。但最终整体评审指出:**端到端的内存目标要在 Phase 3 才真正兑现**,且有两处结构性缺口 + 两处正确性隐患,Phase 3 接线前必须处理:

1. **PixelCache 要改成按字节预算淘汰(当前是按条目数,默认 64)。** 现状:`resolvePixels` 把每个解码图层塞进缓存、合成后不释放,直到条目数超限。对一个反序列化后全是 `PixelRef` 的文档(N≤64 层),所有图层会同时常驻 → 计划要消除的 OOM 并没被真正 bound 住。修复:`PixelCache` 用**解码字节数**做容量,而不是条目数(会牵动 Task 1 的 `PixelCache(4)` 测试语义,一并更新)。合成后是否主动 evict 也在此定。
2. **把 `BlobStore` 接进查询/渲染路径。** `getPreview` 在 `runQuery` 内部调用 `renderCached(doc)` 却没有 ctx;一旦文档是 lazy(`PixelRef`),就会命中 `NO_STORE` 抛错。需要给 `DocumentType.query`/`apply`(以及 editor-do 的查询端点)加上 store 通道,并把 `queries.ts` 里那句 "arrives in Task 4" 的过时注释改掉(Task 4 并未接线)。
3. **`geometry-ops.ts` 的 flip 对 `PixelRef` 应"报错或先解析",不要静默 no-op。** 现状 `!isRef(...)` 会让 lazy 层的翻转被悄悄丢弃 → 渲染错误且无报错,与 `save.ts` 的"遇到未解析 ref 就抛错"策略不一致。按 [[unidocs-editor-commits-before-save]] 的教训,应改为 loud。
4. **`init` op 加 payload 校验。** 现在零校验(`doc.canvas = payload.canvas`);`init` 尚未进 `tools` 注册表故 agent 不可达,但 Phase 3 的 apply 端点一旦接受未经 tools 过滤的 op kind,一个 `canvas: undefined` 的 payload 会提交后 brick 掉 save/render——正是 [[unidocs-editor-commits-before-save]] 记录的陷阱。接线前补上结构校验。

可安全推迟的表面项(评审已判定无正确性影响):T0 调用点冗余的溢出预检查;T0 对带 imageData 的调整层"裁剪后丢弃"的无用拷贝;T2 clip-base `layerAlpha` 并发路径缺测试;T3 效果字段与显式 `mask:null` 的往返缺测试;T4 `BlobStore` 重导出上方的过时 JSDoc。
