# web-psd UI 重构第一期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/web-psd` 从 426 行原生 DOM 演示程序重做成设计稿的三栏 "Aperture" 编辑器，并补上三处后端能力（图层效果可写、PSD 图层类型保真、降级记录）。

**Architecture:** 前端引入 React 19（与 `unicas-packages/admin-webui` 同栈），把现有渲染/同步编排原样抽入非 UI 的 `doc-controller.ts`，`<canvas>` 通过 ref 挂载、永不进入 React diff，UI 层通过 `useSyncExternalStore` 订阅外部 store。后端改动集中在 `packages/doctype-psd`：放开 `setProps` 白名单、让 `psd/load.ts` 保留 ag-psd 已解析的 text/vector/smartObject 元数据并记录降级项。

**Tech Stack:** React 19 · react-dom · @vitejs/plugin-react · Vite 7 · vitest + jsdom + @testing-library/react · 纯 CSS 变量（无 Tailwind / 无 CSS-in-JS）· ag-psd 31

设计文档：`docs/superpowers/specs/2026-08-28-web-psd-ui-redesign-phase1-design.md`

## Global Constraints

- Node >= 24，pnpm 11（corepack `packageManager` 已固定）。
- 版本必须与 `unicas-packages/admin-webui` 一致：`react@^19.0.0`、`react-dom@^19.0.0`、`@types/react@^19.0.0`、`@types/react-dom@^19.0.0`、`@vitejs/plugin-react@^4.3.0`、`@testing-library/react@^16.1.0`、`@testing-library/jest-dom@^6.6.0`、`jsdom@^25.0.0`、`vite@^7.3.0`、`typescript@^5.9.0`。这些均已在 `pnpm-lock.yaml` 中，安装不应访问公网。
- `packages/core`、`packages/doctype-*` 保持 cloud-neutral：不得引入 Cloudflare 类型或 I/O。React 只进 `packages/web-psd`。
- **不引入** `lucide-react`、状态管理库、CSS 框架。设计稿的 `● ○ ▾ ▸ − +` 是文字字形，照抄即可。
- 样式一律写在 `packages/web-psd/src/ui/styles.css`，颜色一律走 `:root` 上的 CSS 变量，`color-scheme: light`（第一期锁浅色）。
- 不改动 `packages/psd-client` 的任何文件。
- 不改动 `render/composite.ts`、`render/region.ts`、`render/dirty-rect.ts`、`render/incremental.ts`（第一期不涉及旋转/缩放）。
- 不改动 `tests/fixtures/sample.psd` 与 `tests/fixtures/generate.mjs`：现有 `psd-load.test.ts` / `fidelity.test.ts` / `psd-roundtrip.test.ts` 对它的图层名与合成结果有精确断言。新 fixture 单独生成。
- 提交信息用 Conventional Commits，作用域为 `psd` 或 `web-psd`。

## File Structure

**后端（`packages/doctype-psd/`）**

| 文件 | 责任 |
| --- | --- |
| `src/model/types.ts` | 修改：`Layer` 增加 `text` / `vector` / `smartObject` / `degraded` 四个可选字段及其接口 |
| `src/ops/layer-ops.ts` | 修改：`SETTABLE_PROPS` 增加四项 + 三个效果校验函数 |
| `src/tools.ts` | 修改：`apply_set_props` 的 JSON Schema 同步 |
| `src/psd/load.ts` | 修改：导出 `mapLayer`；type 判定顺序；映射 ag-psd 的 text/vectorMask/placedLayer；记录 `degraded` |
| `src/psd/save.ts` | 修改：`mapLayer` 回写 text/vector/placedLayer |
| `tests/set-props-effects.test.ts` | 新建：效果字段可写性与校验 |
| `tests/load-fidelity.test.ts` | 新建：图层类型识别与降级记录 |
| `tests/save-roundtrip-ir.test.ts` | 新建：新字段 import→export→import 往返 |
| `tests/fixtures/generate-text-shape.mjs` | 新建：生成含文字层与形状层的 fixture |
| `tests/fixtures/text-shape.psd` | 新建：由上一行生成 |

**前端（`packages/web-psd/`）**

| 文件 | 责任 |
| --- | --- |
| `src/doc-model.ts` | 新建：纯函数（`countLayers` / `decodedBytes` / `rectsOverlap` / `cacheBytesFor` / `collectDegradations` / `layerKind`） |
| `src/doc-controller.ts` | 新建：渲染与同步编排（从现 `main.ts` 原样搬入），非 UI |
| `src/ui/main.tsx` | 新建：`createRoot` 挂载 + 冷启动 |
| `src/ui/app.tsx` | 新建：三栏布局骨架 |
| `src/ui/store.ts` | 新建：外部 store + `useUiState` + 纯 reducer |
| `src/ui/api.ts` | 新建：`/history` `/rollback` `/run` `/reset` `/export` 客户端 |
| `src/ui/components.tsx` | 新建：`Badge` / `Chip` / `Tabs` / `CodeBlock` |
| `src/ui/styles.css` | 新建：design tokens + 全部样式 |
| `src/ui/panels/*.tsx` | 新建：11 个面板组件 |
| `src/main.ts` | 删除（内容拆入 `doc-model.ts` / `doc-controller.ts` / `ui/`） |
| `index.html` | 修改：只留 `<div id="app">` + 字体 preload |
| `public/fonts/*.woff2` | 新建：Barlow ×12 + Roboto Mono ×6 |
| `vite.config.ts` | 修改：加 `@vitejs/plugin-react` 与 vitest jsdom 配置 |
| `tsconfig.json` | 修改：`"jsx": "react-jsx"` |
| `package.json` | 修改：依赖与 `test` 脚本 |
| `tests/setup.ts` | 新建：testing-library 清理钩子 |

**执行顺序**：Task 1–4 是后端，与前端完全独立，可先做完并单独验证；Task 5–9 是前端地基；Task 10–18 是 UI 组装；Task 19 收尾。

---
### Task 1: 放开 `setProps` 白名单到图层效果（地基 2）

**Files:**
- Modify: `packages/doctype-psd/src/ops/layer-ops.ts`
- Test: `packages/doctype-psd/tests/set-props-effects.test.ts`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces: `SETTABLE_PROPS` 增加 `"fillOpacity" | "stroke" | "colorOverlay" | "dropShadow"`；`setProps(doc, {layerId, props})` 接受这四个键，且对 `stroke` / `colorOverlay` / `dropShadow` 传 `null` 表示删除该效果。

**背景（已核实，不要重新调研）：** `render/region.ts` 的 `layerInfluenceBounds` 已经处理 stroke 外扩与 dropShadow 的偏移+模糊；`render/dirty-rect.ts` 的 `opDirtyRect(op, before, after)` 已对 before/after 两个文档取并集。因此本任务**不需要**改动任何渲染代码，脏矩形自动正确——最后一个测试就是为了钉住这一点。

- [ ] **Step 1: 写失败的测试**

创建 `packages/doctype-psd/tests/set-props-effects.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { PsdDoc } from "../src/model/types.js";
import { setProps } from "../src/ops/layer-ops.js";
import { applyOne } from "../src/ops/index.js";
import { opDirtyRect } from "../src/render/dirty-rect.js";
import { findLayer } from "../src/model/tree.js";

const base = {
  bounds: [8, 8, 24, 24] as [number, number, number, number],
  opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};
const doc = (): PsdDoc => ({
  canvas: { width: 64, height: 64, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [{ id: "a", type: "raster", name: "a", ...base }],
});

const STROKE = {
  color: { r: 255, g: 0, b: 0 }, opacity: 1, size: 3,
  position: "outside" as const, blendMode: "normal" as const,
};
const SHADOW = {
  color: { r: 0, g: 0, b: 0 }, opacity: 0.5, blendMode: "normal" as const,
  angle: 0, distance: 10, size: 4, choke: 0,
};

describe("setProps — layer effects", () => {
  it("writes stroke", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { stroke: STROKE } });
    expect(findLayer(d.layers, "a")!.stroke).toEqual(STROKE);
  });

  it("writes colorOverlay", () => {
    const d = doc();
    const co = { r: 245, g: 239, b: 227, opacity: 0.8 };
    setProps(d, { layerId: "a", props: { colorOverlay: co } });
    expect(findLayer(d.layers, "a")!.colorOverlay).toEqual(co);
  });

  it("writes dropShadow", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { dropShadow: SHADOW } });
    expect(findLayer(d.layers, "a")!.dropShadow).toEqual(SHADOW);
  });

  it("writes fillOpacity", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { fillOpacity: 0.25 } });
    expect(findLayer(d.layers, "a")!.fillOpacity).toBe(0.25);
  });

  it("null removes an effect", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { stroke: STROKE } });
    setProps(d, { layerId: "a", props: { stroke: null } });
    expect(findLayer(d.layers, "a")!.stroke).toBeUndefined();
  });

  it("rejects an invalid stroke.position", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { stroke: { ...STROKE, position: "middle" } } }))
      .toThrow(/stroke\.position/);
  });

  it("rejects stroke.opacity out of 0..1", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { stroke: { ...STROKE, opacity: 255 } } }))
      .toThrow(/stroke\.opacity/);
  });

  it("rejects a colour component out of 0..255", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { colorOverlay: { r: 300, g: 0, b: 0, opacity: 1 } } }))
      .toThrow(/colorOverlay/);
  });

  it("rejects fillOpacity out of 0..1", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { fillOpacity: 2 } })).toThrow(/fillOpacity/);
  });

  // Pins the reason this task needs no render changes: influence bounds already
  // account for the shadow's offset + blur, and opDirtyRect unions before/after.
  it("dropShadow write produces a dirty rect covering the shadow bleed", () => {
    const before = doc();
    const op = { kind: "set_props", payload: { layerId: "a", props: { dropShadow: SHADOW } } };
    const after = applyOne(before, op);
    // bounds [8,8,24,24]; angle 0 / distance 10 → dx=-10, dy=0; grown by size+choke=4.
    expect(opDirtyRect(op, before, after)).toEqual([4, 0, 28, 24]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/set-props-effects.test.ts`
Expected: FAIL，报 `immutable or unknown prop: stroke`

- [ ] **Step 3: 实现**

在 `packages/doctype-psd/src/ops/layer-ops.ts` 中，把第 10 行的 `SETTABLE_PROPS` 改成：

```ts
export const SETTABLE_PROPS = [
  "name", "opacity", "blendMode", "visible", "locked", "clipping",
  "fillOpacity", "stroke", "colorOverlay", "dropShadow",
] as const;

/** Effects that accept `null` to mean "remove this effect". */
const EFFECT_PROPS = new Set(["stroke", "colorOverlay", "dropShadow"]);
const STROKE_POSITIONS = ["inside", "outside", "center"];
```

在同文件已有的 `const isFiniteNum = ...` 之后加入这些校验器（`isFiniteNum` 已存在，勿重复定义）：

```ts
const isUnit = (n: unknown): n is number => isFiniteNum(n) && n >= 0 && n <= 1;
const isByte = (n: unknown): n is number => isFiniteNum(n) && n >= 0 && n <= 255;
const isRgb = (v: unknown): boolean => {
  const c = v as { r?: unknown; g?: unknown; b?: unknown } | null;
  return !!c && typeof c === "object" && isByte(c.r) && isByte(c.g) && isByte(c.b);
};

function validateStroke(v: unknown): void {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object") throw new Error("stroke must be an object or null");
  if (!isRgb(s.color)) throw new Error("stroke.color must be {r,g,b} in 0..255");
  if (!isUnit(s.opacity)) throw new Error(`stroke.opacity out of range 0..1: ${String(s.opacity)}`);
  if (!isFiniteNum(s.size) || s.size < 0) throw new Error(`stroke.size must be >= 0: ${String(s.size)}`);
  if (!STROKE_POSITIONS.includes(s.position as string)) {
    throw new Error(`invalid stroke.position: ${String(s.position)} (inside|outside|center)`);
  }
  if (!BLEND_MODES.includes(s.blendMode as BlendMode)) {
    throw new Error(`invalid stroke.blendMode: ${String(s.blendMode)}`);
  }
}

function validateColorOverlay(v: unknown): void {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== "object") throw new Error("colorOverlay must be an object or null");
  if (!isRgb(c)) throw new Error("colorOverlay must carry {r,g,b} in 0..255");
  // 0..1 blend factor — see render/composite.ts, which computes
  // `sr * (1 - oa) + (color.r / 255) * oa`.
  if (!isUnit(c.opacity)) throw new Error(`colorOverlay.opacity out of range 0..1: ${String(c.opacity)}`);
}

function validateDropShadow(v: unknown): void {
  const d = v as Record<string, unknown> | null;
  if (!d || typeof d !== "object") throw new Error("dropShadow must be an object or null");
  if (!isRgb(d.color)) throw new Error("dropShadow.color must be {r,g,b} in 0..255");
  if (!isUnit(d.opacity)) throw new Error(`dropShadow.opacity out of range 0..1: ${String(d.opacity)}`);
  if (!BLEND_MODES.includes(d.blendMode as BlendMode)) {
    throw new Error(`invalid dropShadow.blendMode: ${String(d.blendMode)}`);
  }
  for (const k of ["angle", "distance", "size", "choke"] as const) {
    if (!isFiniteNum(d[k])) throw new Error(`dropShadow.${k} must be a finite number`);
  }
  if ((d.size as number) < 0 || (d.choke as number) < 0) {
    throw new Error("dropShadow.size and dropShadow.choke must be >= 0");
  }
}
```

把 `setProps` 的循环体替换为：

```ts
export function setProps(
  doc: PsdDoc,
  p: { layerId: string; props: Record<string, unknown> },
): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  for (const [k, v] of Object.entries(p.props)) {
    if (!SETTABLE_PROPS.includes(k as any)) throw new Error(`immutable or unknown prop: ${k}`);
    // Effects are removable: null/undefined deletes the key entirely, so a
    // layer with no stroke is `stroke === undefined` (what the renderer and
    // layerInfluenceBounds both test for), never `stroke === null`.
    if (EFFECT_PROPS.has(k) && (v === null || v === undefined)) {
      delete (layer as any)[k];
      continue;
    }
    if (k === "opacity" && !isUnit(v)) throw new Error(`opacity out of range: ${String(v)}`);
    if (k === "fillOpacity" && !isUnit(v)) throw new Error(`fillOpacity out of range: ${String(v)}`);
    if (k === "blendMode" && !BLEND_MODES.includes(v as BlendMode)) throw new Error(`invalid blendMode: ${String(v)}`);
    if (k === "stroke") validateStroke(v);
    if (k === "colorOverlay") validateColorOverlay(v);
    if (k === "dropShadow") validateDropShadow(v);
    (layer as any)[k] = v;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/set-props-effects.test.ts`
Expected: PASS，10 个测试全绿

- [ ] **Step 5: 跑全包测试确认没有回归**

Run: `pnpm --filter @unidocs/doctype-psd test`
Expected: PASS（`layer-ops.test.ts` 中原有的「拒绝未知属性」类断言若用了 `stroke` 作为反例，需改成一个仍不可写的键，例如 `type` 或 `bounds`）

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/ops/layer-ops.ts packages/doctype-psd/tests/set-props-effects.test.ts
git commit -m "feat(psd): allow stroke/colorOverlay/dropShadow/fillOpacity in set_props"
```

---

### Task 2: 同步 `apply_set_props` 的工具 Schema

**Files:**
- Modify: `packages/doctype-psd/src/tools.ts`
- Test: `packages/doctype-psd/tests/tools.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SETTABLE_PROPS`
- Produces: `TOOLS.set_props.inputSchema.properties.props.properties` 包含 `fillOpacity` / `stroke` / `colorOverlay` / `dropShadow`

- [ ] **Step 1: 写失败的测试**

在 `packages/doctype-psd/tests/tools.test.ts` 末尾追加：

```ts
import { SETTABLE_PROPS } from "../src/ops/layer-ops.js";

describe("apply_set_props schema", () => {
  it("exposes every settable prop", () => {
    const props = (TOOLS.set_props.inputSchema as any).properties.props.properties;
    for (const k of SETTABLE_PROPS) expect(Object.keys(props)).toContain(k);
  });

  it("declares stroke.position as an enum of the three PSD positions", () => {
    const props = (TOOLS.set_props.inputSchema as any).properties.props.properties;
    expect(props.stroke.properties.position.enum).toEqual(["inside", "outside", "center"]);
  });
});
```

注意：`tools.test.ts` 现有的 import 语句可能已经引入了 `TOOLS`；若没有，补 `import { TOOLS } from "../src/tools.js";`（以文件中现有的导出名为准，先读该文件确认）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/tools.test.ts`
Expected: FAIL，`Object.keys(props)` 不含 `stroke`

- [ ] **Step 3: 实现**

在 `packages/doctype-psd/src/tools.ts` 的 `set_props` 定义处，先在文件顶部（`BLEND_MODES` 之后）加入共享子 schema：

```ts
const RGB = {
  type: "object",
  properties: {
    r: { type: "number", minimum: 0, maximum: 255 },
    g: { type: "number", minimum: 0, maximum: 255 },
    b: { type: "number", minimum: 0, maximum: 255 },
  },
  required: ["r", "g", "b"],
} as const;
```

然后把 `set_props` 改为：

```ts
  set_props: {
    name: "apply_set_props",
    description:
      "WRITE. Change name/opacity/fillOpacity/blendMode/visible/locked/clipping of a layer, "
      + "or set its stroke / colorOverlay / dropShadow effect. Pass null for an effect to remove it.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string" },
        props: {
          type: "object",
          properties: {
            name: { type: "string" },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            fillOpacity: { type: "number", minimum: 0, maximum: 1 },
            blendMode: { enum: BLEND_MODES },
            visible: { type: "boolean" },
            locked: { type: "boolean" },
            clipping: { type: "boolean" },
            stroke: {
              type: ["object", "null"],
              properties: {
                color: RGB,
                opacity: { type: "number", minimum: 0, maximum: 1 },
                size: { type: "number", minimum: 0 },
                position: { enum: ["inside", "outside", "center"] },
                blendMode: { enum: BLEND_MODES },
              },
              required: ["color", "opacity", "size", "position", "blendMode"],
            },
            colorOverlay: {
              type: ["object", "null"],
              properties: {
                r: { type: "number", minimum: 0, maximum: 255 },
                g: { type: "number", minimum: 0, maximum: 255 },
                b: { type: "number", minimum: 0, maximum: 255 },
                opacity: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["r", "g", "b", "opacity"],
            },
            dropShadow: {
              type: ["object", "null"],
              properties: {
                color: RGB,
                opacity: { type: "number", minimum: 0, maximum: 1 },
                blendMode: { enum: BLEND_MODES },
                angle: { type: "number" },
                distance: { type: "number" },
                size: { type: "number", minimum: 0 },
                choke: { type: "number", minimum: 0 },
              },
              required: ["color", "opacity", "blendMode", "angle", "distance", "size", "choke"],
            },
          },
        },
      },
      required: ["layerId", "props"],
    },
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/tools.ts packages/doctype-psd/tests/tools.test.ts
git commit -m "feat(psd): expose layer effects in the apply_set_props tool schema"
```

---
### Task 3: PSD 图层类型保真与降级记录（地基 5a · 读取）

**Files:**
- Modify: `packages/doctype-psd/src/model/types.ts`
- Modify: `packages/doctype-psd/src/psd/load.ts`
- Create: `packages/doctype-psd/tests/load-fidelity.test.ts`
- Create: `packages/doctype-psd/tests/fixtures/generate-text-shape.mjs`
- Create: `packages/doctype-psd/tests/fixtures/text-shape.psd`（由上一行生成）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Layer.text?: LayerText`、`Layer.vector?: LayerVector`、`Layer.smartObject?: LayerSmartObject`、`Layer.degraded?: Degradation[]`
  - `export interface LayerText { content: string; style?: LayerTextStyle; transform?: number[]; shapeType?: "point" | "box" }`
  - `export interface LayerTextStyle { font?: string; size?: number; color?: { r: number; g: number; b: number }; tracking?: number; leading?: number }`
  - `export interface LayerVector { fill?: unknown; stroke?: unknown; pathSummary?: { subpaths: number; knots: number } }`
  - `export interface LayerSmartObject { placedId: string; transform?: number[]; sourceName?: string }`
  - `export interface Degradation { reason: string; detail?: string }`
  - `psd/load.ts` 新增具名导出 `mapLayer(a: AgLayer, i: number, cw: number, ch: number): Layer`

**背景（已核实，不要重新调研）：** `ag-psd@31` 已经把 `Layer.text`（`LayerTextData`：`text` 字符串、`style: TextStyle`、`transform: number[]`、`shapeType`）、`vectorFill` / `vectorStroke` / `vectorMask.paths[].knots`、`placedLayer`（`id` / `placed` / `transform`）全解析出来了。现有 `load.ts` 的 `const type = isGroup ? "group" : adj ? "adjustment" : "raster"` 把它们全丢掉。这些图层在 PSD 里本就带烘焙好的 `imageData`，**渲染管线一行都不改**。

**对设计文档的一处修正：** 设计文档写的类型判定顺序是 `group → text → vector → smartObject → adjustment → raster`。实现时改用 **`group → adjustment → text → smartObject → vector → raster`**：带矢量蒙版的调整图层（Photoshop 里很常见）在原顺序下会被误判成 `fill`；智能对象也常自带矢量蒙版，必须排在 vector 之前。元数据（`vector` / `text` / `smartObject`）**无论类型如何都照常记录**，只有 `type` 这一个字段受顺序影响。

- [ ] **Step 1: 写失败的测试**

创建 `packages/doctype-psd/tests/load-fidelity.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { Layer as AgLayer } from "ag-psd";
import { mapLayer } from "../src/psd/load.js";

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const box = { top: 10, left: 20, bottom: 50, right: 120 };

describe("mapLayer — IR 保真", () => {
  it("识别文字层并保留内容与样式", () => {
    const ag = {
      name: "headline", ...box, imageData: px(100, 40),
      text: {
        text: "仲夏特惠",
        transform: [1, 0, 0, 1, 20, 46],
        shapeType: "point",
        style: {
          font: { name: "Barlow-Bold" }, fontSize: 32, tracking: 20, leading: 38,
          fillColor: { r: 28, g: 29, b: 26 },
        },
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 0, 256, 256);
    expect(l.type).toBe("text");
    expect(l.text).toEqual({
      content: "仲夏特惠",
      style: { font: "Barlow-Bold", size: 32, color: { r: 28, g: 29, b: 26 }, tracking: 20, leading: 38 },
      transform: [1, 0, 0, 1, 20, 46],
      shapeType: "point",
    });
    expect(l.pixels?.width).toBe(100); // 仍以烘焙像素渲染
    expect(l.degraded?.map((d) => d.reason)).toContain("文字层已栅格化");
  });

  it("识别形状层并汇总路径", () => {
    const ag = {
      name: "badge", ...box, imageData: px(100, 40),
      vectorFill: { type: "color", color: { r: 245, g: 239, b: 227 } },
      vectorMask: {
        paths: [{
          open: false, fillRule: "even-odd",
          knots: [
            { linked: false, points: [20, 10, 20, 10, 20, 10] },
            { linked: false, points: [120, 10, 120, 10, 120, 10] },
            { linked: false, points: [120, 50, 120, 50, 120, 50] },
            { linked: false, points: [20, 50, 20, 50, 20, 50] },
          ],
        }],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 1, 256, 256);
    expect(l.type).toBe("fill");
    expect(l.vector?.pathSummary).toEqual({ subpaths: 1, knots: 4 });
    expect(l.vector?.fill).toEqual({ type: "color", color: { r: 245, g: 239, b: 227 } });
    expect(l.degraded?.map((d) => d.reason)).toContain("矢量形状已栅格化");
  });

  it("识别智能对象并保留放置信息", () => {
    const ag = {
      name: "hero", ...box, imageData: px(100, 40),
      placedLayer: {
        id: "uuid-1", placed: "hero-01.psb", type: "raster",
        transform: [20, 10, 120, 10, 120, 50, 20, 50],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 2, 256, 256);
    expect(l.type).toBe("smartObject");
    expect(l.smartObject).toEqual({
      placedId: "uuid-1", sourceName: "hero-01.psb",
      transform: [20, 10, 120, 10, 120, 50, 20, 50],
    });
    expect(l.degraded).toEqual([{ reason: "智能对象已展平", detail: "源：hero-01.psb" }]);
  });

  // 顺序回归：带矢量蒙版的调整图层必须仍是 adjustment，不能变成 fill。
  it("带矢量蒙版的调整图层仍判为 adjustment，但路径元数据照常记录", () => {
    const ag = {
      name: "curve", ...box,
      adjustment: { type: "brightness/contrast", brightness: 10 },
      vectorMask: {
        paths: [{ open: false, fillRule: "non-zero", knots: [{ linked: false, points: [0, 0, 0, 0, 0, 0] }] }],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 3, 256, 256);
    expect(l.type).toBe("adjustment");
    expect(l.vector?.pathSummary).toEqual({ subpaths: 1, knots: 1 });
  });

  it("普通栅格层不变、且不产生降级项", () => {
    const ag = { name: "bg", ...box, imageData: px(100, 40) } as unknown as AgLayer;
    const l = mapLayer(ag, 4, 256, 256);
    expect(l.type).toBe("raster");
    expect(l.text).toBeUndefined();
    expect(l.vector).toBeUndefined();
    expect(l.smartObject).toBeUndefined();
    expect(l.degraded).toBeUndefined();
  });

  it("分组仍是分组", () => {
    const ag = {
      name: "grp", ...box,
      children: [{ name: "child", ...box, imageData: px(4, 4) }],
    } as unknown as AgLayer;
    const l = mapLayer(ag, 5, 256, 256);
    expect(l.type).toBe("group");
    expect(l.children).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/load-fidelity.test.ts`
Expected: FAIL，`mapLayer` 未从 `../src/psd/load.js` 导出

- [ ] **Step 3: 加类型定义**

在 `packages/doctype-psd/src/model/types.ts` 的 `export interface Layer` **之前**插入：

```ts
/** A capability the loader could not represent, recorded so the UI can show
 *  what fidelity was lost instead of silently pretending the import was exact. */
export interface Degradation { reason: string; detail?: string }

export interface LayerTextStyle {
  font?: string;
  size?: number;
  color?: { r: number; g: number; b: number }; // 0..255
  tracking?: number;
  leading?: number;
}

/** Text-layer metadata preserved from the PSD. The layer still RENDERS from
 *  its baked `pixels`; this is structure for the UI and the agent to read. */
export interface LayerText {
  content: string;
  style?: LayerTextStyle;
  transform?: number[];          // ag-psd's affine matrix, kept verbatim
  shapeType?: "point" | "box";
}

/** Vector/shape metadata preserved from the PSD. `fill`/`stroke` are ag-psd's
 *  own `VectorContent` shapes, kept verbatim rather than re-modelled. */
export interface LayerVector {
  fill?: unknown;
  stroke?: unknown;
  pathSummary?: { subpaths: number; knots: number };
}

export interface LayerSmartObject {
  placedId: string;
  transform?: number[];
  sourceName?: string;
}
```

在 `export interface Layer { ... }` 内部，`provenance` 那一行之后加入：

```ts
  text?: LayerText;                      // type === "text"
  vector?: LayerVector;                  // shape layers (and vector-masked others)
  smartObject?: LayerSmartObject;        // type === "smartObject"
  degraded?: Degradation[];              // fidelity lost on import — see psd/load.ts
```

- [ ] **Step 4: 改 `load.ts`**

在 `packages/doctype-psd/src/psd/load.ts` 顶部，把 import 改为：

```ts
import { readPsd, type Layer as AgLayer } from "ag-psd";
import type {
  PsdDoc, Layer, BlendMode, Mask,
  Degradation, LayerText, LayerTextStyle, LayerVector, LayerSmartObject,
} from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";
```

在 `mapAdjustType` 之后插入三个映射函数：

```ts
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** ag-psd's `Color` is a union (RGB/HSB/CMYK/…); we only carry the RGB shape. */
function rgbOf(c: unknown): { r: number; g: number; b: number } | undefined {
  const v = c as { r?: unknown; g?: unknown; b?: unknown } | undefined;
  return v && isNum(v.r) && isNum(v.g) && isNum(v.b) ? { r: v.r, g: v.g, b: v.b } : undefined;
}

function mapText(t: AgLayer["text"]): { text: LayerText; degraded: Degradation } | undefined {
  if (!t || typeof t.text !== "string") return undefined;
  const s = t.style;
  const color = rgbOf(s?.fillColor);
  const style: LayerTextStyle = {
    ...(s?.font?.name ? { font: s.font.name } : {}),
    ...(isNum(s?.fontSize) ? { size: s!.fontSize } : {}),
    ...(color ? { color } : {}),
    ...(isNum(s?.tracking) ? { tracking: s!.tracking } : {}),
    ...(isNum(s?.leading) ? { leading: s!.leading } : {}),
  };
  return {
    text: {
      content: t.text,
      ...(Object.keys(style).length ? { style } : {}),
      ...(Array.isArray(t.transform) ? { transform: [...t.transform] } : {}),
      ...(t.shapeType ? { shapeType: t.shapeType } : {}),
    },
    degraded: {
      reason: "文字层已栅格化",
      detail: "渲染与导出使用 PSD 烘焙像素；本期不支持编辑文字内容与排版",
    },
  };
}

function mapVector(a: AgLayer): { vector: LayerVector; degraded: Degradation } | undefined {
  const paths = a.vectorMask?.paths ?? [];
  if (!paths.length && !a.vectorFill && !a.vectorStroke) return undefined;
  return {
    vector: {
      ...(a.vectorFill ? { fill: a.vectorFill } : {}),
      ...(a.vectorStroke ? { stroke: a.vectorStroke } : {}),
      ...(paths.length
        ? {
            pathSummary: {
              subpaths: paths.length,
              knots: paths.reduce((n, p) => n + (p.knots?.length ?? 0), 0),
            },
          }
        : {}),
    },
    degraded: {
      reason: "矢量形状已栅格化",
      detail: "路径与填充已保留为元数据，渲染与导出使用烘焙像素",
    },
  };
}

function mapSmartObject(a: AgLayer): { smartObject: LayerSmartObject; degraded: Degradation } | undefined {
  const p = a.placedLayer;
  if (!p?.id) return undefined;
  return {
    smartObject: {
      placedId: p.id,
      ...(Array.isArray(p.transform) ? { transform: [...p.transform] } : {}),
      ...(p.placed ? { sourceName: p.placed } : {}),
    },
    degraded: {
      reason: "智能对象已展平",
      detail: p.placed ? `源：${p.placed}` : "源文档未内嵌",
    },
  };
}
```

把 `function mapLayer(` 改成 `export function mapLayer(`，并把它开头的 type 判定替换为：

```ts
export function mapLayer(a: AgLayer, i: number, cw: number, ch: number): Layer {
  const isGroup = Array.isArray(a.children);
  const adj = (a as { adjustment?: { type?: string } & Record<string, unknown> }).adjustment;
  // Metadata is captured regardless of the type verdict — a vector-masked
  // adjustment keeps its path summary AND stays an adjustment.
  const textInfo = isGroup ? undefined : mapText(a.text);
  const smartInfo = isGroup ? undefined : mapSmartObject(a);
  const vectorInfo = isGroup ? undefined : mapVector(a);
  // Order matters: adjustments and smart objects commonly carry a vector mask,
  // so they must be decided BEFORE the vector check or they'd read as "fill".
  const type: Layer["type"] =
    isGroup ? "group"
    : adj ? "adjustment"
    : textInfo ? "text"
    : smartInfo ? "smartObject"
    : vectorInfo ? "fill"
    : "raster";
  const degraded = [textInfo?.degraded, smartInfo?.degraded, vectorInfo?.degraded]
    .filter((d): d is Degradation => !!d);
```

（其余从 `let bounds:` 开始的函数体保持原样不动。）

最后在 `mapLayer` 的 `return {` 对象里，`...(isGroup ? { children: ... } : {})` **之前**插入：

```ts
    ...(textInfo ? { text: textInfo.text } : {}),
    ...(smartInfo ? { smartObject: smartInfo.smartObject } : {}),
    ...(vectorInfo ? { vector: vectorInfo.vector } : {}),
    ...(degraded.length ? { degraded } : {}),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/load-fidelity.test.ts`
Expected: PASS，6 个测试全绿

- [ ] **Step 6: 生成含文字层的 fixture**

创建 `packages/doctype-psd/tests/fixtures/generate-text-shape.mjs`：

```js
// Separate from generate.mjs on purpose: sample.psd's layer names and its
// hand-computed composite oracle are asserted verbatim by psd-load.test.ts,
// fidelity.test.ts and psd-roundtrip.test.ts. Adding a layer there would
// break all three, so text/shape fidelity gets its own fixture.
import { writePsd, readPsd, initializeCanvas } from "ag-psd";
import { writeFileSync, readFileSync } from "node:fs";

initializeCanvas(
  (w = 1, h = 1) => { throw new Error(`createCanvas(${w},${h}) invoked — NOT expected for useImageData read`); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

const W = 256, H = 256;
const psd = {
  width: W, height: H,
  children: [
    { name: "bg", opacity: 1, blendMode: "normal", imageData: solid(W, H, [238, 236, 231]) },
    {
      name: "headline", opacity: 1, blendMode: "normal",
      top: 20, left: 20, bottom: 60, right: 220,
      imageData: solid(200, 40, [28, 29, 26]),
      text: {
        text: "Midsummer Sale",
        transform: [1, 0, 0, 1, 20, 52],
        style: { font: { name: "Barlow-Bold" }, fontSize: 32, fillColor: { r: 28, g: 29, b: 26 } },
      },
    },
  ],
  imageData: solid(W, H, [238, 236, 231]),
};

const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
writeFileSync(new URL("./text-shape.psd", import.meta.url), Buffer.from(buffer));
console.log(`✓ wrote text-shape.psd (${buffer.byteLength} bytes)`);

const back = readPsd(readFileSync(new URL("./text-shape.psd", import.meta.url)), { useImageData: true, skipThumbnail: true });
console.log("✓ read back layers:", back.children?.map((c) => `${c.name}(text=${JSON.stringify(c.text?.text)})`).join(", "));
```

Run: `node packages/doctype-psd/tests/fixtures/generate-text-shape.mjs`
Expected: 打印 `✓ wrote text-shape.psd (…)` 且 read back 行显示 `headline(text="Midsummer Sale")`

- [ ] **Step 7: 加一条走真实 `load()` 的集成断言**

在 `tests/load-fidelity.test.ts` 末尾追加：

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";

const textFixture = fileURLToPath(new URL("./fixtures/text-shape.psd", import.meta.url));

describe("load() — 真实 PSD 往返", () => {
  it("从真实 PSD 字节中识别出文字层", async () => {
    const doc = await load(new Uint8Array(readFileSync(textFixture)));
    const headline = doc.layers.find((l) => l.name === "headline")!;
    expect(headline.type).toBe("text");
    expect(headline.text?.content).toBe("Midsummer Sale");
    expect(headline.degraded?.map((d) => d.reason)).toContain("文字层已栅格化");
    // 普通层不受影响
    expect(doc.layers.find((l) => l.name === "bg")!.type).toBe("raster");
  });
});
```

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/load-fidelity.test.ts`
Expected: PASS，7 个测试全绿

- [ ] **Step 8: 跑全包测试确认无回归**

Run: `pnpm --filter @unidocs/doctype-psd test`
Expected: PASS。特别关注 `psd-load.test.ts`、`fidelity.test.ts`、`ir-roundtrip.test.ts`、`psd-roundtrip.test.ts` —— `sample.psd` 里没有文字/矢量/智能对象层，它们的类型判定结果应当完全不变。

- [ ] **Step 9: 提交**

```bash
git add packages/doctype-psd/src/model/types.ts packages/doctype-psd/src/psd/load.ts \
        packages/doctype-psd/tests/load-fidelity.test.ts \
        packages/doctype-psd/tests/fixtures/generate-text-shape.mjs \
        packages/doctype-psd/tests/fixtures/text-shape.psd
git commit -m "feat(psd): preserve text/vector/smart-object metadata and record import degradations"
```

---

### Task 4: 导出时回写新元数据（地基 5a · 往返）

**Files:**
- Modify: `packages/doctype-psd/src/psd/save.ts`
- Create: `packages/doctype-psd/tests/save-roundtrip-ir.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Layer.text` / `Layer.vector` / `Layer.smartObject`
- Produces: `save(doc)` 产出的 PSD 中，文字层带 `text`、形状层带 `vectorFill`/`vectorMask`、智能对象带 `placedLayer`

**注意：** `degraded` 是**导入期的诊断信息，不回写 PSD**——它描述的是「我们丢了什么」，不是文档内容。

- [ ] **Step 1: 写失败的测试**

创建 `packages/doctype-psd/tests/save-roundtrip-ir.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { PsdDoc } from "../src/model/types.js";
import { save } from "../src/psd/save.js";
import { load } from "../src/psd/load.js";

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const base = {
  opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};

const doc = (): PsdDoc => ({
  canvas: { width: 256, height: 256, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [
    {
      id: "t", type: "text", name: "headline", bounds: [20, 20, 60, 220], ...base,
      pixels: px(200, 40),
      text: {
        content: "Midsummer Sale",
        style: { font: "Barlow-Bold", size: 32, color: { r: 28, g: 29, b: 26 } },
        transform: [1, 0, 0, 1, 20, 52],
        shapeType: "point",
      },
      degraded: [{ reason: "文字层已栅格化" }],
    },
  ],
});

describe("save → load 往返保留 IR 元数据", () => {
  it("文字层的内容与样式往返后不丢", async () => {
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    expect(headline.type).toBe("text");
    expect(headline.text?.content).toBe("Midsummer Sale");
    expect(headline.text?.style?.size).toBe(32);
    expect(headline.text?.style?.font).toBe("Barlow-Bold");
  });

  it("degraded 是导入期诊断，不写回 PSD，但重新导入会重新产生", async () => {
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    // 不是从上一份 doc 搬过来的那条，而是 load 重新判定出来的
    expect(headline.degraded).toEqual([
      { reason: "文字层已栅格化", detail: "渲染与导出使用 PSD 烘焙像素；本期不支持编辑文字内容与排版" },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/save-roundtrip-ir.test.ts`
Expected: FAIL，`headline.type` 是 `"raster"`（`save` 没写 `text`，所以 `load` 认不出来）

- [ ] **Step 3: 实现**

在 `packages/doctype-psd/src/psd/save.ts` 的 `mapLayer` 中，`if (l.fillOpacity !== undefined ...)` 那一行之后插入：

```ts
  // Write back the metadata load.ts preserved, so import → export → import is
  // lossless for layer STRUCTURE. `degraded` is deliberately NOT written: it
  // describes what the importer lost, not what the document contains, and
  // load() re-derives it on the next import.
  if (l.text) {
    out.text = {
      text: l.text.content,
      ...(l.text.transform ? { transform: l.text.transform } : {}),
      ...(l.text.shapeType ? { shapeType: l.text.shapeType } : {}),
      ...(l.text.style
        ? {
            style: {
              ...(l.text.style.font ? { font: { name: l.text.style.font } } : {}),
              ...(l.text.style.size !== undefined ? { fontSize: l.text.style.size } : {}),
              ...(l.text.style.color ? { fillColor: l.text.style.color } : {}),
              ...(l.text.style.tracking !== undefined ? { tracking: l.text.style.tracking } : {}),
              ...(l.text.style.leading !== undefined ? { leading: l.text.style.leading } : {}),
            },
          }
        : {}),
    } as any;
  }
  if (l.vector?.fill) out.vectorFill = l.vector.fill as any;
  if (l.vector?.stroke) out.vectorStroke = l.vector.stroke as any;
  if (l.smartObject) {
    out.placedLayer = {
      id: l.smartObject.placedId,
      type: "raster",
      ...(l.smartObject.transform ? { transform: l.smartObject.transform } : {}),
      ...(l.smartObject.sourceName ? { placed: l.smartObject.sourceName } : {}),
    } as any;
  }
```

注意 `mapLayer` 里 `else if (l.pixels)` 这条链：文字/形状/智能对象层的 `type` 不是 `"adjustment"`、也没有 `children`，所以会正常走到 `out.imageData = ...` 分支，烘焙像素照常写出。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/save-roundtrip-ir.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全包测试 + 类型检查**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/psd/save.ts packages/doctype-psd/tests/save-roundtrip-ir.test.ts
git commit -m "feat(psd): write text/vector/smart-object metadata back on export"
```

---
### Task 5: web-psd 工具链接入 + 纯函数模块

**Files:**
- Modify: `packages/web-psd/package.json`
- Modify: `packages/web-psd/tsconfig.json`
- Modify: `packages/web-psd/vite.config.ts`
- Create: `packages/web-psd/tests/setup.ts`
- Create: `packages/web-psd/src/doc-model.ts`
- Test: `packages/web-psd/tests/doc-model.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Layer.degraded`（结构上，通过本地 `LocalLayer` 接口镜像，不 import doctype-psd）
- Produces（`src/doc-model.ts` 的具名导出）:
  - `type Rect = [number, number, number, number]`（`[top,left,bottom,right]`）
  - `interface LocalLayer` / `interface SizedLayer`
  - `countLayers(layers: LocalLayer[]): number`
  - `decodedBytes(layers: SizedLayer[]): number`
  - `cacheBytesFor(layers: SizedLayer[]): number`
  - `rectsOverlap(a: Rect, b: Rect): boolean`
  - `collectDegradations(layers: LocalLayer[]): DegradationRow[]`，`interface DegradationRow { layerId: string; layerName: string; reason: string; detail?: string }`
  - `layerKind(type: string): { label: string; token: string }`
  - `flattenTree(layers: LocalLayer[], expanded: ReadonlySet<string>): TreeRow[]`，`interface TreeRow { layer: LocalLayer; depth: number; hasChildren: boolean }`

**说明：** `countLayers` / `decodedBytes` / `rectsOverlap` 以及三个 CACHE 常量是从现 `src/main.ts` **原样搬出**的，逻辑一字不改；`cacheBytesFor` 只是把 `main.ts` 里那段 `Math.min(CACHE_CAP, Math.max(CACHE_FLOOR, decodedBytes(...) + CACHE_HEADROOM))` 包成函数。其余三个是新增。

- [ ] **Step 1: 装依赖并配好工具链**

改 `packages/web-psd/package.json`（版本必须与 admin-webui 一致）：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rimraf --glob dist \"*.tsbuildinfo\""
  },
  "dependencies": {
    "@unidocs/psd-client": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.9.0",
    "vite": "^7.3.0",
    "vitest": "^3.2.0"
  }
}
```

改 `packages/web-psd/tsconfig.json`，在 `compilerOptions` 里加 `"jsx": "react-jsx"`，并把 `include` 改为 `["src", "tests"]`。

改 `packages/web-psd/vite.config.ts` —— 保留现有 proxy 配置不动，只加 plugin 与 test 段，并把 import 源换成 `vitest/config`：

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The gateway URL is injected by the dev runtime (scripts/dev.mjs); falls back
// to the default local gateway when web-psd is started on its own.
const gateway = process.env.GATEWAY_URL || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin `/gw/*` → gateway (avoids CORS). `/gw` prefix is stripped.
      "/gw": {
        target: gateway,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gw/, ""),
      },
    },
  },
  test: {
    // jsdom (not admin-webui's "node") because every test here renders DOM.
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
```

> **偏离 CLAUDE.md 的说明：** CLAUDE.md 写「单元测试由裸 `vitest run` 跑，无 vitest 配置文件」。web-psd 需要 jsdom 环境，所以配置写进 `vite.config.ts` 的 `test` 段——与 `unicas-packages/admin-webui` 的做法一致，不新增独立的 `vitest.config.ts`。

创建 `packages/web-psd/tests/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
```

Run: `pnpm install`
Expected: 安装成功且不访问公网（这些版本都已在 `pnpm-lock.yaml` 中）

- [ ] **Step 2: 写失败的测试**

创建 `packages/web-psd/tests/doc-model.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  countLayers, decodedBytes, cacheBytesFor, rectsOverlap,
  collectDegradations, layerKind, flattenTree,
  type LocalLayer, type SizedLayer,
} from "../src/doc-model.js";

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

describe("countLayers", () => {
  it("counts nested children", () => {
    const layers = [leaf("a"), leaf("g", { type: "group", children: [leaf("b"), leaf("c")] })];
    expect(countLayers(layers)).toBe(4);
  });
});

describe("decodedBytes / cacheBytesFor", () => {
  it("sums layer and mask pixels across groups", () => {
    const layers: SizedLayer[] = [
      { ...leaf("a"), pixels: { width: 10, height: 10 } },
      { ...leaf("g"), type: "group", children: [
        { ...leaf("b"), pixels: { width: 5, height: 4 }, mask: { pixels: { width: 2, height: 2 } } },
      ] },
    ];
    expect(decodedBytes(layers)).toBe((100 + 20 + 4) * 4);
  });

  it("floors small documents at 128 MiB", () => {
    expect(cacheBytesFor([])).toBe(128 * 1024 * 1024);
  });

  it("caps huge documents at 1 GiB", () => {
    const huge: SizedLayer[] = [{ ...leaf("h"), pixels: { width: 20000, height: 20000 } }];
    expect(cacheBytesFor(huge)).toBe(1024 * 1024 * 1024);
  });
});

describe("rectsOverlap", () => {
  it("is true for overlapping rects and false for touching ones", () => {
    expect(rectsOverlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(rectsOverlap([0, 0, 10, 10], [10, 10, 20, 20])).toBe(false);
  });
});

describe("layerKind", () => {
  it("maps every PSD layer type to a badge", () => {
    expect(layerKind("text")).toEqual({ label: "T", token: "text" });
    expect(layerKind("fill")).toEqual({ label: "SHP", token: "shp" });
    expect(layerKind("group")).toEqual({ label: "GRP", token: "grp" });
    expect(layerKind("raster")).toEqual({ label: "IMG", token: "img" });
    expect(layerKind("smartObject")).toEqual({ label: "SO", token: "img" });
    expect(layerKind("adjustment")).toEqual({ label: "ADJ", token: "adj" });
  });
});

describe("collectDegradations", () => {
  it("walks the tree and tags each row with its layer", () => {
    const layers = [
      leaf("t", { name: "headline", degraded: [{ reason: "文字层已栅格化", detail: "d" }] }),
      leaf("g", { type: "group", children: [
        leaf("s", { name: "hero", degraded: [{ reason: "智能对象已展平" }] }),
      ] }),
      leaf("plain"),
    ];
    expect(collectDegradations(layers)).toEqual([
      { layerId: "t", layerName: "headline", reason: "文字层已栅格化", detail: "d" },
      { layerId: "s", layerName: "hero", reason: "智能对象已展平" },
    ]);
  });
});

describe("flattenTree", () => {
  it("emits children only for expanded groups, in top-down order with depth", () => {
    const layers = [
      leaf("g", { type: "group", children: [leaf("b"), leaf("c")] }),
      leaf("a"),
    ];
    expect(flattenTree(layers, new Set()).map((r) => [r.layer.id, r.depth, r.hasChildren]))
      .toEqual([["g", 0, true], ["a", 0, false]]);
    expect(flattenTree(layers, new Set(["g"])).map((r) => [r.layer.id, r.depth]))
      .toEqual([["g", 0], ["b", 1], ["c", 1], ["a", 0]]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: FAIL，`../src/doc-model.js` 不存在

- [ ] **Step 4: 实现 `src/doc-model.ts`**

```ts
/**
 * Pure, DOM-free helpers over the PSD document shape. Split out of main.ts so
 * they can be unit-tested without a Worker, a canvas, or the network — and so
 * the UI layer can reuse them without pulling in the render controller.
 *
 * These mirror the engine's `Layer` structurally instead of importing
 * @unidocs/doctype-psd: web-psd deliberately has no dependency on the doc type.
 */

export type Rect = [number, number, number, number]; // [top,left,bottom,right] — the engine's convention

export interface Degradation { reason: string; detail?: string }

export interface LocalLayer {
  id: string;
  type: string;
  name: string;
  opacity: number;
  blendMode: string;
  visible: boolean;
  locked?: boolean;
  clipping?: boolean;
  fillOpacity?: number;
  bounds?: Rect;
  stroke?: unknown;
  colorOverlay?: unknown;
  dropShadow?: unknown;
  text?: { content: string; style?: Record<string, unknown> };
  vector?: { pathSummary?: { subpaths: number; knots: number } };
  smartObject?: { placedId: string; sourceName?: string };
  degraded?: Degradation[];
  children?: LocalLayer[];
}

/** Superset used only for sizing the render cache — adds the (lazy-ref or
 *  resident) pixel dimensions `decodedBytes` walks. */
export interface SizedLayer extends LocalLayer {
  pixels?: { width: number; height: number };
  mask?: { pixels: { width: number; height: number } };
  children?: SizedLayer[];
}

export interface DegradationRow { layerId: string; layerName: string; reason: string; detail?: string }
export interface TreeRow { layer: LocalLayer; depth: number; hasChildren: boolean }

/** Recursive count of every layer, including group children. */
export function countLayers(layers: LocalLayer[]): number {
  let n = 0;
  for (const l of layers) {
    n += 1;
    if (l.children) n += countLayers(l.children);
  }
  return n;
}

/** Sum of every layer's (and mask's) decoded RGBA byte size, walking groups. */
export function decodedBytes(layers: SizedLayer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.pixels) n += l.pixels.width * l.pixels.height * 4;
    if (l.mask?.pixels) n += l.mask.pixels.width * l.mask.pixels.height * 4;
    if (l.children) n += decodedBytes(l.children);
  }
  return n;
}

const CACHE_FLOOR = 128 * 1024 * 1024;   // 128 MiB — small docs still get real headroom
const CACHE_HEADROOM = 64 * 1024 * 1024; // slack for tile buffers alongside layer pixels
const CACHE_CAP = 1024 * 1024 * 1024;    // 1 GiB ceiling — don't reserve unbounded memory

/** Sizes the Worker's PixelCache to actually hold this doc's decoded layers,
 *  instead of the engine's small resident-doc default (which evicts constantly
 *  on a large PSD, making every composite re-fault from CAS). */
export function cacheBytesFor(layers: SizedLayer[]): number {
  return Math.min(CACHE_CAP, Math.max(CACHE_FLOOR, decodedBytes(layers) + CACHE_HEADROOM));
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  const [at, al, ab, ar] = a;
  const [bt, bl, bb, br] = b;
  return at < bb && ab > bt && al < br && ar > bl;
}

const KINDS: Record<string, { label: string; token: string }> = {
  text: { label: "T", token: "text" },
  fill: { label: "SHP", token: "shp" },
  group: { label: "GRP", token: "grp" },
  raster: { label: "IMG", token: "img" },
  smartObject: { label: "SO", token: "img" },
  adjustment: { label: "ADJ", token: "adj" },
};

/** Badge label + colour token for a layer type. `token` indexes the
 *  `--kind-*` CSS variables in styles.css. */
export function layerKind(type: string): { label: string; token: string } {
  return KINDS[type] ?? { label: "?", token: "grp" };
}

/** Flattens every `degraded` entry in the tree, tagged with its owning layer,
 *  for the top bar's "N 项降级" badge and its detail popover. */
export function collectDegradations(layers: LocalLayer[]): DegradationRow[] {
  const out: DegradationRow[] = [];
  const walk = (list: LocalLayer[]): void => {
    for (const l of list) {
      for (const d of l.degraded ?? []) {
        out.push({ layerId: l.id, layerName: l.name, reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) });
      }
      if (l.children) walk(l.children);
    }
  };
  walk(layers);
  return out;
}

/** Top-down flattening of the layer tree for rendering: a group's children are
 *  emitted only when the group id is in `expanded`. */
export function flattenTree(layers: LocalLayer[], expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: LocalLayer[], depth: number): void => {
    for (const layer of list) {
      const hasChildren = !!layer.children?.length;
      out.push({ layer, depth, hasChildren });
      if (hasChildren && expanded.has(layer.id)) walk(layer.children!, depth + 1);
    }
  };
  walk(layers, 0);
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS，9 个测试全绿

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/package.json packages/web-psd/tsconfig.json packages/web-psd/vite.config.ts \
        packages/web-psd/tests/setup.ts packages/web-psd/tests/doc-model.test.ts \
        packages/web-psd/src/doc-model.ts pnpm-lock.yaml
git commit -m "chore(web-psd): add React 19 + vitest/jsdom toolchain and extract pure doc helpers"
```

---

### Task 6: 把渲染/同步编排抽入 `doc-controller.ts`（纯重构）

**Files:**
- Create: `packages/web-psd/src/doc-controller.ts`
- Modify: `packages/web-psd/src/main.ts`（缩成薄壳）

**Interfaces:**
- Consumes: Task 5 的 `cacheBytesFor` / `countLayers` / `rectsOverlap` / `Rect` / `LocalLayer` / `SizedLayer`
- Produces:

```ts
export interface Op { kind: string; payload: Record<string, unknown> }
export interface DocControllerEvents {
  onStatus(message: string): void;
  /** Fires whenever the document or version changes: cold start, local op,
   *  rebase (409 / agent run / another tab), rollback. */
  onDoc(doc: DocSession["doc"], version: number): void;
}
export class DocController {
  constructor(view: HTMLCanvasElement, stage: HTMLElement, events: DocControllerEvents);
  get docId(): string | null;
  get version(): number;
  get doc(): DocSession["doc"] | null;
  createFrom(bytes: Uint8Array, label: string): Promise<void>;
  dispatch(op: Op): Promise<void>;
  reconcile(): Promise<void>;
  requestVisibleTiles(): void;
  setZoom(zoom: number): void;
  panBy(dx: number, dy: number): void;
  /** Reads one pixel from the composited canvas; returns "#rrggbb" or null. */
  pickColor(clientX: number, clientY: number): string | null;
  dispose(): void;
}
export const GW: string;
export const USER: string;
export const TYPE: string;
export const API_BASE_URL: string;
```

**这是一次纯重构：`index.html` 一个字都不改，旧 UI 必须继续以完全相同的方式工作。** 目的是留一个可对比的性能基线，并让后续 UI 重写不再和渲染逻辑纠缠。

- [ ] **Step 1: 建 `doc-controller.ts`**

把现 `src/main.ts` 中以下内容**原样**搬入（逻辑与注释都不要改写）：常量 `GW` / `USER` / `API_BASE_URL` / `TYPE`；`initRender`、`repaintAfterDocChange`、`requestVisibleTiles`、`debounce`、`dispatch`、`createFrom` 的函数体；以及 `[psd-perf]` 的三处 `console.log`。

把原来的模块级可变量（`session` / `renderClient` / `viewport` / `currentWorker` / `tileSize` / `docId`）改成 `DocController` 的私有字段；把原来直接调用 `setStatus(...)` 的地方改为 `this.events.onStatus(...)`；在 `initRender` 末尾、`repaintAfterDocChange` 末尾、以及 `DocSession` 的 `onRebase` 回调里，把原先的 `refreshLayers()` 调用替换为 `this.events.onDoc(this.session.doc, this.session.version)`。

`scroll` / `resize` 监听器改为在构造函数里注册、在 `dispose()` 里移除（原先是模块级注册，注释里说明「doc swap 时自动生效」的理由仍然成立，因为读的是实例字段）。

新增两个方法（原 `main.ts` 没有，但本任务顺带补上，因为它们只依赖已搬入的 `viewport`）：

```ts
  setZoom(zoom: number): void {
    this.viewport?.setZoom(zoom);
    this.requestVisibleTiles();
  }

  panBy(dx: number, dy: number): void {
    this.viewport?.panBy(dx, dy);
    this.requestVisibleTiles();
  }

  /** Reads one pixel from the composited canvas. Used by the eyedropper tool.
   *  Returns null when the point is outside the canvas or the 2D context is
   *  unavailable. */
  pickColor(clientX: number, clientY: number): string | null {
    const ctx = this.view.getContext("2d");
    if (!ctx) return null;
    const r = this.view.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * this.view.width);
    const y = Math.floor(((clientY - r.top) / r.height) * this.view.height);
    if (x < 0 || y < 0 || x >= this.view.width || y >= this.view.height) return null;
    const [rr, gg, bb] = ctx.getImageData(x, y, 1, 1).data;
    return "#" + [rr, gg, bb].map((c) => c.toString(16).padStart(2, "0")).join("");
  }
```

`reconcile()` 只是把 `session.reconcile()` 加上其后的 `repaintAfterDocChange`：

```ts
  async reconcile(): Promise<void> {
    if (!this.session) return;
    await this.session.reconcile();
    await this.repaintAfterDocChange(this.session.doc);
  }
```

- [ ] **Step 2: 把 `main.ts` 缩成薄壳**

`main.ts` 保留：DOM 查询、`DocController` 实例化、`refreshLayers`、文件上传、导出按钮、聊天表单，全部改为调用 controller。聊天里原来的 `session.reconcile()` + `repaintAfterDocChange(...)` 两行合并为 `await controller.reconcile()`。

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @unidocs/web-psd typecheck`
Expected: PASS

- [ ] **Step 4: 手动冒烟 + 记录性能基线**

Run: `pnpm dev psd`，浏览器打开 Vite 打印的地址。

Expected:
- 页面自动载入 `sample.psd` 并渲染出图
- 勾选/取消图层可见性、拖动不透明度滑块，画布即时更新
- Chat 发一条指令不报错
- 控制台记录下这三行数字，作为后续 UI 重写的回归基线：
  - `[psd-perf] init: doc … totalTiles=… visibleTiles=…`
  - `[psd-perf] init: workerInit=…ms firstPaint=…ms`
  - `[psd-perf] toggle set_props/…: … totalMs=…ms`

把这三行贴进提交信息里。

- [ ] **Step 5: 提交**

```bash
git add packages/web-psd/src/doc-controller.ts packages/web-psd/src/main.ts
git commit -m "refactor(web-psd): extract render/sync orchestration into DocController

No behaviour change; index.html untouched. Baseline:
<粘贴 Step 4 记录的三行 [psd-perf] 输出>"
```

---
### Task 7: 字体、design tokens 与三栏骨架（地基 0 · 上半）

**Files:**
- Create: `packages/web-psd/scripts/extract-design-fonts.mjs`
- Create: `packages/web-psd/public/fonts/*.woff2`（18 个，由脚本生成）
- Create: `packages/web-psd/src/ui/fonts.css`（由脚本生成）
- Create: `packages/web-psd/src/ui/styles.css`
- Create: `packages/web-psd/src/ui/app.tsx`
- Create: `packages/web-psd/src/ui/main.tsx`
- Modify: `packages/web-psd/index.html`
- Test: `packages/web-psd/tests/app-shell.test.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `export function App(): JSX.Element`（`src/ui/app.tsx`）；CSS 类名 `app` / `app-body` / `col-chat` / `col-canvas` / `col-panel`

**列宽与顺序（已按设计稿的 CSS `order` 核实，勿凭直觉改）：**
左栏 **Chat**（`order:1`，固定 `396px`）｜ 中栏 **画布**（`order:2`，`flex:1; min-width:700px`，底色 `#e6e3dd`）｜ 右栏 **图层/属性**（`order:3`，固定 `296px`）。

- [ ] **Step 1: 写字体提取脚本**

创建 `packages/web-psd/scripts/extract-design-fonts.mjs`：

```js
/**
 * One-shot: pulls the Barlow / Roboto Mono woff2 subsets out of the Claude
 * Design bundle the redesign came from, and emits the matching @font-face CSS.
 *
 *   node scripts/extract-design-fonts.mjs \
 *     "<path to Agent Image Editor (standalone).html>" public/fonts src/ui/fonts.css
 *
 * Using the bundle's own subsets keeps glyphs identical to the design, needs no
 * new npm dependency, and works offline.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [src, outDir, cssPath] = process.argv.slice(2);
const html = readFileSync(src, "utf8");

const manifest = JSON.parse(
  html.match(/<script type="__bundler\/manifest"[^>]*>([\s\S]*?)<\/script>/)[1],
);
const page = JSON.parse(html.match(/"<!DOCTYPE html>[\s\S]*?[^\\]"/)[0]);

mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(cssPath), { recursive: true });

// Roboto Mono 400 and 500 reference the SAME uuids in the design bundle, so
// dedupe by uuid: one file on disk, referenced by both @font-face blocks.
const fileFor = new Map();
const seen = new Map();
const blocks = [];
for (const m of page.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
  const body = m[1];
  const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
  const weight = /font-weight:\s*(\d+)/.exec(body)?.[1];
  const uuid = /url\("([^"]+)"\)/.exec(body)?.[1];
  const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
  if (!family || !weight || !uuid || !manifest[uuid]) continue;
  const slug = family.toLowerCase().replace(/\s+/g, "-");
  let file = fileFor.get(uuid);
  if (!file) {
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    file = `${slug}-${n}.woff2`;
    fileFor.set(uuid, file);
    writeFileSync(join(outDir, file), Buffer.from(manifest[uuid].data, "base64"));
  }
  blocks.push(
    `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n` +
    `  font-display: swap;\n  src: url("/fonts/${file}") format('woff2');\n` +
    `  unicode-range: ${range.trim()};\n}`,
  );
}
writeFileSync(cssPath, `/* Generated by scripts/extract-design-fonts.mjs — do not edit by hand. */\n\n${blocks.join("\n\n")}\n`);
console.log(`✓ ${fileFor.size} woff2 files, ${blocks.length} @font-face blocks → ${cssPath}`);
```

Run:
```bash
cd packages/web-psd
node scripts/extract-design-fonts.mjs \
  "$HOME/Downloads/Agent Image Editor (standalone).html" public/fonts src/ui/fonts.css
```
Expected: `✓ 18 woff2 files, 24 @font-face blocks → src/ui/fonts.css`，`public/fonts/` 约 284KB

- [ ] **Step 2: 写 `styles.css`**

创建 `packages/web-psd/src/ui/styles.css`：

```css
@import "./fonts.css";

/* Design tokens lifted value-for-value from the redesign source
   ("Agent Image Editor" Claude Design canvas). Change --accent alone to
   restyle the whole app; every accent-tinted surface derives from it. */
:root {
  --bg: #eeece7;
  --panel: #fbfaf8;
  --border: #e2e0da;
  --border-strong: #dcd8d0;
  --fg: #1c1d1a;
  --fg-2: #7c7d75;
  --fg-3: #8a8b82;
  --fg-dim: #b6b7ae;
  --accent: #00a38a;
  --accent-ink: #00806d;
  --warn: #d9a441;
  --warn-ink: #99711a;
  --kind-text: #5b4bd9;
  --kind-img: #00806d;
  --kind-grp: #7c7d75;
  --kind-shp: #b4622f;
  --kind-adj: #99711a;   /* not in the design — adjustment layers need a badge too */
  --canvas-bg: #e6e3dd;
  --canvas-dot: #d3cfc7;
  --font: Barlow, Helvetica, sans-serif;
  --mono: "Roboto Mono", monospace;
  --fs: 13px;
  --row-h: 26px;
  --topbar-h: 48px;
  --radius: 5px;
  --col-chat: 396px;
  --col-panel: 296px;
  --canvas-min: 700px;
  /* Phase 1 ships light only — same choice as unicas-packages/admin-webui. */
  color-scheme: light;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
}

body {
  color: var(--fg);
  font-family: var(--font);
  font-size: var(--fs);
}

a { color: var(--accent-ink); text-decoration: none; }
a:hover { color: var(--accent); }

::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: #d5d2ca; border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }

/* Marching-ants selection border; used by selection-overlay.tsx. */
@keyframes ants { to { background-position: 16px 0, -16px 100%, 0 -16px, 100% 16px; } }
@keyframes blip { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow-x: auto;
}

/* Column order is set here, NOT by DOM order: the design puts Chat on the
   left (order 1), the canvas in the middle, and layers/props on the right. */
.col-chat {
  order: 1;
  width: var(--col-chat);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

.col-canvas {
  order: 2;
  flex: 1;
  min-width: var(--canvas-min);
  display: flex;
  flex-direction: column;
  background: var(--canvas-bg);
}

.col-panel {
  order: 3;
  width: var(--col-panel);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid var(--border);
}

/* Section header shared by all three columns (40px tall in the design). */
.col-head {
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
}

.col-head strong { font-weight: 600; }
.mono { font-family: var(--mono); }
.spacer { flex: 1; }
```

- [ ] **Step 3: 写失败的测试**

创建 `packages/web-psd/tests/app-shell.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/app.js";

describe("App shell", () => {
  it("renders the three columns", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".col-chat")).toBeInTheDocument();
    expect(container.querySelector(".col-canvas")).toBeInTheDocument();
    expect(container.querySelector(".col-panel")).toBeInTheDocument();
  });

  it("gives each column its header", () => {
    render(<App />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("图层")).toBeInTheDocument();
    expect(screen.getByText("属性")).toBeInTheDocument();
  });

  // Visual column ORDER lives in styles.css (`order: 1|2|3`) and cannot be
  // asserted here — jsdom does not apply the imported stylesheet. It is
  // verified by the manual smoke step at the end of Task 9 instead.
  it("declares the columns in the DOM", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll(".col-chat, .col-canvas, .col-panel")).toHaveLength(3);
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/app-shell.test.tsx`
Expected: FAIL，`../src/ui/app.js` 不存在

- [ ] **Step 4: 写 `app.tsx` 与 `main.tsx`**

创建 `packages/web-psd/src/ui/app.tsx`：

```tsx
/**
 * Three-column shell. Column ORDER comes from styles.css (`order: 1|2|3`),
 * matching the redesign: Chat left (396px), canvas centre, layers/props right
 * (296px). Later tasks fill each column in; this file only owns the frame.
 */
export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <strong>Aperture</strong>
      </header>
      <div className="app-body">
        <section className="col-chat">
          <div className="col-head"><strong>Chat</strong></div>
        </section>
        <section className="col-canvas" />
        <aside className="col-panel">
          <div className="col-head">
            <span>图层</span>
            <span>属性</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
```

创建 `packages/web-psd/src/ui/main.tsx`：

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const host = document.getElementById("app");
if (!host) throw new Error("#app mount point missing from index.html");
createRoot(host).render(<App />);
```

改 `packages/web-psd/index.html` —— 删掉整个 `<style>` 块和 `<header>`/`<main>` 结构（含 `color-scheme: light dark`），换成：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aperture — PSD editor</title>
    <!-- Latin subsets only; the other unicode-ranges load lazily on demand.
         These three filenames are what Step 1's script emits for the
         U+0000-00FF ranges: Barlow 400, Barlow 600, Roboto Mono 400/500
         (the mono weights share one file). Verify with:
           grep -B6 "U+0000-00FF" src/ui/fonts.css | grep url -->
    <link rel="preload" as="font" type="font/woff2" href="/fonts/barlow-3.woff2" crossorigin />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/barlow-9.woff2" crossorigin />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/roboto-mono-6.woff2" crossorigin />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test tests/app-shell.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/scripts packages/web-psd/public/fonts packages/web-psd/src/ui packages/web-psd/index.html \
        packages/web-psd/tests/app-shell.test.tsx
git commit -m "feat(web-psd): add design tokens, bundled fonts and the three-column shell"
```

---

### Task 8: UI store（地基 0 · 下半）

**Files:**
- Create: `packages/web-psd/src/ui/store.ts`
- Test: `packages/web-psd/tests/store.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `LocalLayer` / `Rect` / `DegradationRow`
- Produces:

```ts
export type ToolId = "move" | "marquee" | "eyedrop";
export type PaneId = "layers" | "props";
export interface ChatMessage { role: "user" | "agent" | "err"; text: string; pending?: boolean; fromVersion?: number; toVersion?: number }
export interface HistoryEntry { version: number; timestamp: string; description: string; operations: unknown[] }
export interface UiState {
  docId: string | null; docName: string | null;
  version: number; doc: { canvas: { width: number; height: number }; layers: LocalLayer[] } | null;
  status: string;
  selection: string[]; expanded: ReadonlySet<string>;
  pane: PaneId; tool: ToolId; marquee: Rect | null; zoom: number;
  history: HistoryEntry[]; historyOpen: boolean; sessionBaseVersion: number;
  chat: ChatMessage[]; chatBusy: boolean; degradeOpen: boolean;
  pickedColor: string | null;
}
export function getState(): UiState;
export function setState(patch: Partial<UiState>): void;
export function subscribe(listener: () => void): () => void;
export function useUiState(): UiState;              // React hook
export function toggleExpanded(state: UiState, id: string): ReadonlySet<string>;   // pure
export function nextSelection(state: UiState, id: string, additive: boolean): string[]; // pure
export function opsSinceSession(state: UiState): HistoryEntry[];                   // pure
export function selectedLayers(state: UiState): LocalLayer[];                      // pure
```

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/store.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getState, setState, subscribe,
  toggleExpanded, nextSelection, opsSinceSession, selectedLayers,
  type UiState,
} from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, children?: LocalLayer[]): LocalLayer => ({
  id, type: children ? "group" : "raster", name: id,
  opacity: 1, blendMode: "normal", visible: true, ...(children ? { children } : {}),
});

const withDoc = (): UiState => {
  setState({ doc: { canvas: { width: 4, height: 4 }, layers: [leaf("g", [leaf("b")]), leaf("a")] } });
  return getState();
};

beforeEach(() => {
  setState({
    docId: null, docName: null, version: 0, doc: null, status: "",
    selection: [], expanded: new Set(), pane: "layers", tool: "move",
    marquee: null, zoom: 1, history: [], historyOpen: false,
    sessionBaseVersion: 0, chat: [], chatBusy: false, degradeOpen: false,
    pickedColor: null,
  });
});

describe("store subscription", () => {
  it("notifies subscribers and swaps the snapshot identity on change", () => {
    let calls = 0;
    const before = getState();
    const off = subscribe(() => { calls += 1; });
    setState({ status: "loading" });
    expect(calls).toBe(1);
    expect(getState()).not.toBe(before);
    expect(getState().status).toBe("loading");
    off();
    setState({ status: "done" });
    expect(calls).toBe(1);
  });
});

describe("toggleExpanded", () => {
  it("adds then removes an id without mutating the previous set", () => {
    const s = getState();
    const opened = toggleExpanded(s, "g");
    expect(opened.has("g")).toBe(true);
    expect(s.expanded.has("g")).toBe(false);
    expect(toggleExpanded({ ...s, expanded: opened }, "g").has("g")).toBe(false);
  });
});

describe("nextSelection", () => {
  it("replaces the selection by default", () => {
    const s = { ...getState(), selection: ["a"] };
    expect(nextSelection(s, "b", false)).toEqual(["b"]);
  });

  it("adds on additive click and removes on additive re-click", () => {
    const s = { ...getState(), selection: ["a"] };
    expect(nextSelection(s, "b", true)).toEqual(["a", "b"]);
    expect(nextSelection({ ...s, selection: ["a", "b"] }, "a", true)).toEqual(["b"]);
  });
});

describe("opsSinceSession", () => {
  it("keeps only entries newer than the version the page opened at", () => {
    const h = [3, 4, 5].map((v) => ({ version: v, timestamp: "", description: "", operations: [] }));
    const s = { ...getState(), history: h, sessionBaseVersion: 3 };
    expect(opsSinceSession(s).map((e) => e.version)).toEqual([4, 5]);
  });
});

describe("selectedLayers", () => {
  it("resolves ids through nested groups, skipping unknown ids", () => {
    const s = { ...withDoc(), selection: ["b", "nope", "a"] };
    expect(selectedLayers(s).map((l) => l.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/web-psd test tests/store.test.ts`
Expected: FAIL，`../src/ui/store.js` 不存在

- [ ] **Step 3: 实现 `src/ui/store.ts`**

```ts
import { useSyncExternalStore } from "react";
import type { LocalLayer, Rect } from "../doc-model.js";

export type ToolId = "move" | "marquee" | "eyedrop";
export type PaneId = "layers" | "props";

export interface ChatMessage {
  role: "user" | "agent" | "err";
  text: string;
  pending?: boolean;
  /** Version range this agent turn produced, so its ops accordion can slice
   *  `history` without the server needing a per-turn concept. */
  fromVersion?: number;
  toVersion?: number;
}

/** Mirrors @unidocs/protocol-doc's HistoryEntry; declared locally because
 *  web-psd has no dependency on the protocol package. */
export interface HistoryEntry {
  version: number;
  timestamp: string;
  description: string;
  operations: unknown[];
}

export interface UiState {
  docId: string | null;
  docName: string | null;
  version: number;
  doc: { canvas: { width: number; height: number }; layers: LocalLayer[] } | null;
  status: string;
  selection: string[];
  expanded: ReadonlySet<string>;
  pane: PaneId;
  tool: ToolId;
  marquee: Rect | null;
  zoom: number;
  history: HistoryEntry[];
  historyOpen: boolean;
  /** The version the page opened at. "This session" is everything above it —
   *  the server has no session concept, so the boundary lives here. */
  sessionBaseVersion: number;
  chat: ChatMessage[];
  chatBusy: boolean;
  degradeOpen: boolean;
  /** Last colour sampled by the eyedropper, shown in the context bar. */
  pickedColor: string | null;
}

let state: UiState = {
  docId: null, docName: null, version: 0, doc: null, status: "loading…",
  selection: [], expanded: new Set(), pane: "layers", tool: "move",
  marquee: null, zoom: 1, history: [], historyOpen: false,
  sessionBaseVersion: 0, chat: [], chatBusy: false, degradeOpen: false,
  pickedColor: null,
};

const listeners = new Set<() => void>();

export function getState(): UiState {
  return state;
}

export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Subscribes to the WHOLE state object rather than a selector slice. That
 * re-renders every subscribed component on any change, which is fine here:
 * the expensive surface — the <canvas> — is mounted by ref and never enters
 * React's tree (see canvas-stage.tsx), and a selector-based API invites the
 * classic `useSyncExternalStore` bug where a selector returning a fresh
 * object each call loops forever.
 */
export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function toggleExpanded(s: UiState, id: string): ReadonlySet<string> {
  const next = new Set(s.expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function nextSelection(s: UiState, id: string, additive: boolean): string[] {
  if (!additive) return [id];
  return s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id];
}

export function opsSinceSession(s: UiState): HistoryEntry[] {
  return s.history.filter((e) => e.version > s.sessionBaseVersion);
}

export function selectedLayers(s: UiState): LocalLayer[] {
  if (!s.doc) return [];
  const byId = new Map<string, LocalLayer>();
  const walk = (list: LocalLayer[]): void => {
    for (const l of list) {
      byId.set(l.id, l);
      if (l.children) walk(l.children);
    }
  };
  walk(s.doc.layers);
  return s.selection.map((id) => byId.get(id)).filter((l): l is LocalLayer => !!l);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test tests/store.test.ts`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add packages/web-psd/src/ui/store.ts packages/web-psd/tests/store.test.ts
git commit -m "feat(web-psd): add the UI store and its pure selectors"
```

---
### Task 9: 画布上屏 —— CanvasStage 与 controller 接线（地基 3 · 上半）

**Files:**
- Create: `packages/web-psd/src/ui/controller.ts`
- Create: `packages/web-psd/src/ui/panels/canvas-stage.tsx`
- Modify: `packages/web-psd/src/ui/app.tsx`
- Modify: `packages/web-psd/src/ui/styles.css`
- Test: `packages/web-psd/tests/canvas-stage.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `DocController` / `Op` / `GW` / `USER` / `TYPE`；Task 8 的 `setState` / `getState`
- Produces（`src/ui/controller.ts`）:
  - `getController(): DocController | null`
  - `initController(view: HTMLCanvasElement, stage: HTMLElement): void`（幂等）
  - `openFile(file: File): Promise<void>`
  - `dispatch(op: Op): Promise<void>`
  - `exportUrl(): string | null`
- Produces（`src/ui/panels/canvas-stage.tsx`）: `export function CanvasStage(): JSX.Element`

**这一步做完，浏览器里应该已经能看到真实渲染的 PSD。** 后续任务都在这个基础上加壳。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/canvas-stage.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// DocController spins up a Web Worker and talks to the gateway; neither exists
// under jsdom. Mock the module so this test covers only the wiring contract:
// the canvas + its scrolling stage are handed to the controller exactly once.
const ctor = vi.fn();
vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    constructor(...args: unknown[]) { ctor(...args); }
    docId = null;
    createFrom = vi.fn(async () => {});
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

beforeEach(() => { ctor.mockClear(); vi.unstubAllGlobals(); });

describe("CanvasStage", () => {
  it("hands the canvas and its scrolling stage to the controller once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })));
    const { CanvasStage } = await import("../src/ui/panels/canvas-stage.js");
    const { container, rerender } = render(<CanvasStage />);
    const view = container.querySelector("canvas.view");
    const stage = container.querySelector("div.stage");
    expect(view).toBeInTheDocument();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toBe(view);
    expect(ctor.mock.calls[0][1]).toBe(stage);
    rerender(<CanvasStage />);
    expect(ctor).toHaveBeenCalledTimes(1); // idempotent
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/canvas-stage.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 写 `src/ui/controller.ts`**

```ts
import { DocController, GW, TYPE, USER, type Op } from "../doc-controller.js";
import { getState, setState } from "./store.js";

let controller: DocController | null = null;

export function getController(): DocController | null {
  return controller;
}

/**
 * Constructs the one DocController for this page, wiring its two callbacks
 * into the store. Idempotent: <CanvasStage> calls it from an effect, and React
 * StrictMode double-invokes effects in development.
 */
export function initController(view: HTMLCanvasElement, stage: HTMLElement): void {
  if (controller) return;
  controller = new DocController(view, stage, {
    onStatus: (status) => setState({ status }),
    onDoc: (doc, version) => {
      // The FIRST doc we ever see fixes "this session"'s baseline: everything
      // above it is what the user did in this tab (see opsSinceSession).
      const fresh = getState().doc === null;
      setState({
        doc: doc as never,
        version,
        ...(fresh ? { sessionBaseVersion: version } : {}),
      });
    },
  });
  void bootstrap();
}

/** Uploads the bundled sample and opens it — same cold start as before the
 *  redesign (creation is server-side; rendering is local from then on). */
async function bootstrap(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}sample.psd`);
    await createFrom(new Uint8Array(await r.arrayBuffer()), "sample.psd");
  } catch (e) {
    setState({ status: `no sample: ${(e as Error).message}` });
  }
}

async function createFrom(bytes: Uint8Array, label: string): Promise<void> {
  if (!controller) return;
  await controller.createFrom(bytes, label);
  setState({ docId: controller.docId, docName: label, history: [], chat: [] });
}

export async function openFile(file: File): Promise<void> {
  await createFrom(new Uint8Array(await file.arrayBuffer()), file.name);
}

export async function dispatch(op: Op): Promise<void> {
  await controller?.dispatch(op);
}

export function exportUrl(): string | null {
  const id = controller?.docId;
  return id ? `${GW}/tenants/${USER}/docs/${TYPE}/${id}/export` : null;
}
```

- [ ] **Step 3: 写 `src/ui/panels/canvas-stage.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { initController } from "../controller.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (stageRef.current && viewRef.current) initController(viewRef.current, stageRef.current);
  }, []);

  return (
    <div className="stage" ref={stageRef}>
      <canvas className="view" ref={viewRef} aria-label="rendered preview" />
    </div>
  );
}
```

- [ ] **Step 4: 加样式**

追加到 `styles.css`：

```css
/* `overflow: auto` + `margin: auto` on the canvas (rather than the design's
   `place-items: center`) is load-bearing, inherited from the pre-redesign
   stage: Viewport.visibleTiles reads this element's scroll offsets, and a
   document larger than the viewport must stay reachable from its top-left
   instead of being clipped by flex centring. */
.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: auto;
  display: flex;
  background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px);
  background-size: 22px 22px;
}

.view {
  margin: auto;
  background: #fff;
  box-shadow: 0 2px 24px #0000001a;
  image-rendering: pixelated;
}
```

- [ ] **Step 5: 挂进 `app.tsx`**

把 `<section className="col-canvas" />` 换成：

```tsx
        <section className="col-canvas">
          <CanvasStage />
        </section>
```

并在文件顶部 `import { CanvasStage } from "./panels/canvas-stage.js";`

- [ ] **Step 6: 修 `app-shell.test.tsx`**

`<App />` 现在会挂载 `<CanvasStage />`，后者构造 `DocController`，而 `DocController` 会 `new Worker(...)` 并 `fetch` —— jsdom 两样都没有，这个测试会立刻崩。在 `tests/app-shell.test.tsx` 顶部加上与 `canvas-stage.test.tsx` 相同的模块 mock：

```tsx
import { vi } from "vitest";

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId = null;
    createFrom = vi.fn(async () => {});
    setZoom = vi.fn();
    toScreen = () => ({ x: 0, y: 0 });
    toCanvas = () => ({ x: 0, y: 0 });
    pickColor = () => null;
    reconcile = vi.fn(async () => {});
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })));
```

这个 mock 之后每个把新面板塞进 `<App />` 的任务都依赖它，别删。

- [ ] **Step 7: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

Run: `pnpm dev psd`，打开浏览器
Expected: 页面呈现三栏，中栏画布渲染出 `sample.psd`；控制台 `[psd-perf] init:` 的数字与 Task 6 记录的基线在同一量级

- [ ] **Step 8: 提交**

```bash
git add packages/web-psd/src/ui/controller.ts packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/canvas-stage.test.tsx packages/web-psd/tests/app-shell.test.tsx
git commit -m "feat(web-psd): mount the canvas through DocController in the new shell"
```

---

### Task 10: 顶栏（A1 A2 A5 A6）

**Files:**
- Create: `packages/web-psd/src/ui/panels/top-bar.tsx`
- Modify: `packages/web-psd/src/ui/app.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/top-bar.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `useUiState` / `setState`；Task 9 的 `openFile` / `exportUrl` / `getController`
- Produces: `export function TopBar(): JSX.Element`

缩放档位（设计稿的 `zoomIn`/`zoomOut` 语义）：步长 25%，下限 25%，上限 400%。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/top-bar.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";

const setZoom = vi.fn();
vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({ setZoom }),
  openFile: vi.fn(),
  exportUrl: () => "/tenants/u1/docs/psd/abc/export",
}));

beforeEach(() => {
  setZoom.mockClear();
  setState({ docName: "summer-sale-kv.psd", zoom: 1, version: 3, docId: "abcdef0123456789" });
});

describe("TopBar", () => {
  it("shows the document name", () => {
    render(<TopBar />);
    expect(screen.getByText("summer-sale-kv.psd")).toBeInTheDocument();
  });

  it("steps zoom by 25% within 25%..400%", () => {
    render(<TopBar />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBeCloseTo(1.25);
    expect(setZoom).toHaveBeenCalledWith(1.25);
    setState({ zoom: 4 });
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBe(4); // clamped
    setState({ zoom: 0.25 });
    fireEvent.click(screen.getByLabelText("缩小"));
    expect(getState().zoom).toBe(0.25); // clamped
  });

  it("links export at the document's export endpoint", () => {
    render(<TopBar />);
    expect(screen.getByText("导出").closest("a")).toHaveAttribute(
      "href", "/tenants/u1/docs/psd/abc/export");
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/top-bar.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 实现 `src/ui/panels/top-bar.tsx`**

```tsx
import { useRef } from "react";
import { setState, useUiState } from "../store.js";
import { exportUrl, getController, openFile } from "../controller.js";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

export function TopBar() {
  const s = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);

  const stepZoom = (delta: number): void => {
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom + delta));
    if (zoom === s.zoom) return;
    setState({ zoom });
    getController()?.setZoom(zoom);
  };

  const href = exportUrl();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark mono">ir</span>
        <span className="brand-name">Aperture</span>
      </div>
      <span className="divider" />
      <span className="mono doc-name">{s.docName ?? "—"}</span>
      <span className="spacer" />
      <span className="mono status">{s.status}</span>
      <div className="zoom">
        <button type="button" aria-label="缩小" onClick={() => stepZoom(-ZOOM_STEP)}>−</button>
        <span className="mono zoom-label">{Math.round(s.zoom * 100)}%</span>
        <button type="button" aria-label="放大" onClick={() => stepZoom(ZOOM_STEP)}>+</button>
      </div>
      <button type="button" className="btn" onClick={() => fileRef.current?.click()}>打开</button>
      <input
        ref={fileRef} type="file" accept=".psd" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); }}
      />
      {href
        ? <a className="btn btn-primary" href={href} download="export.psd">导出</a>
        : <span className="btn btn-primary is-disabled">导出</span>}
    </header>
  );
}
```

- [ ] **Step 3: 加样式**

追加到 `styles.css`：

```css
.topbar {
  height: var(--topbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.brand { display: flex; align-items: center; gap: 8px; }
.brand-mark {
  width: 22px; height: 22px; border-radius: 6px;
  background: var(--accent); color: #fff;
  display: grid; place-items: center; font-size: 11px;
}
.brand-name { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; }
.divider { width: 1px; height: 22px; background: var(--border); }
.doc-name { font-size: 12px; }
.status { font-size: 10.5px; color: var(--fg-3); }

.zoom {
  display: flex; align-items: center; gap: 2px; padding: 2px;
  background: #f0eee9; border: 1px solid var(--border); border-radius: 7px;
}
.zoom button {
  width: 24px; height: 22px; display: grid; place-items: center;
  border: 0; background: transparent; border-radius: var(--radius);
  color: #6e6f68; font-family: var(--mono); font-size: 13px; cursor: pointer;
}
.zoom button:hover { background: #e6e3dd; }
.zoom-label { width: 46px; text-align: center; font-size: 11.5px; color: #4a4b45; }

.btn {
  height: 30px; padding: 0 13px; display: inline-flex; align-items: center;
  border: 1px solid var(--border-strong); border-radius: 7px;
  background: #fff; color: var(--fg); font: inherit; cursor: pointer;
}
.btn:hover { background: #f6f4f0; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-ink); }
.btn.is-disabled { opacity: .5; pointer-events: none; }
```

- [ ] **Step 4: 挂进 `app.tsx`**

把 `<header className="topbar"><strong>Aperture</strong></header>` 换成 `<TopBar />`，并 import。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS（`app-shell.test.tsx` 里若断言了 `Aperture` 文本仍然成立）

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/ui/panels/top-bar.tsx packages/web-psd/src/ui/app.tsx \
        packages/web-psd/src/ui/styles.css packages/web-psd/tests/top-bar.test.tsx
git commit -m "feat(web-psd): add the top bar with document name, zoom and export"
```

---

### Task 11: 右栏图层树（B1 B2 B3 B4 B6 B7）

**Files:**
- Create: `packages/web-psd/src/ui/panels/side-panel.tsx`
- Create: `packages/web-psd/src/ui/panels/layer-tree.tsx`
- Modify: `packages/web-psd/src/ui/app.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/layer-tree.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `flattenTree` / `layerKind`；Task 8 的 `useUiState` / `setState` / `toggleExpanded` / `nextSelection`；Task 9 的 `dispatch`
- Produces: `export function SidePanel(): JSX.Element`、`export function LayerTree(): JSX.Element`

行结构照设计稿：`眼睛 · caret · 类型徽标 · 名称 · 降级标记`，行高 26px，缩进 `8 + depth * 13` px，选中行底色 `color-mix(in srgb, var(--accent) 12%, transparent)` 且左侧 2px accent 内阴影。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/layer-tree.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayerTree } from "../src/ui/panels/layer-tree.js";
import { setState, getState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
vi.mock("../src/ui/controller.js", () => ({ dispatch: (op: unknown) => dispatch(op) }));

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

beforeEach(() => {
  dispatch.mockClear();
  setState({
    selection: [], expanded: new Set(),
    doc: { canvas: { width: 4, height: 4 }, layers: [
      leaf("g", { type: "group", name: "角标组", children: [leaf("badge", { name: "促销角标" })] }),
      leaf("t", { type: "text", name: "headline", degraded: [{ reason: "文字层已栅格化" }] }),
    ] },
  });
});

describe("LayerTree", () => {
  it("renders only top-level rows until a group is expanded", () => {
    render(<LayerTree />);
    expect(screen.queryByText("促销角标")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("展开 角标组"));
    expect(getState().expanded.has("g")).toBe(true);
    expect(screen.getByText("促销角标")).toBeInTheDocument();
  });

  it("shows a kind badge per layer type", () => {
    render(<LayerTree />);
    expect(screen.getByText("GRP")).toBeInTheDocument();
    expect(screen.getByText("T")).toBeInTheDocument();
  });

  it("marks degraded layers", () => {
    render(<LayerTree />);
    expect(screen.getByTitle("文字层已栅格化")).toBeInTheDocument();
  });

  it("selects on click and adds on meta-click", () => {
    render(<LayerTree />);
    fireEvent.click(screen.getByText("角标组"));
    expect(getState().selection).toEqual(["g"]);
    fireEvent.click(screen.getByText("headline"), { metaKey: true });
    expect(getState().selection).toEqual(["g", "t"]);
  });

  it("toggles visibility through a set_props op without changing selection", () => {
    render(<LayerTree />);
    fireEvent.click(screen.getByLabelText("隐藏 headline"));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "t", props: { visible: false } },
    });
    expect(getState().selection).toEqual([]);
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/layer-tree.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 实现 `src/ui/panels/layer-tree.tsx`**

```tsx
import { flattenTree, layerKind, type LocalLayer } from "../../doc-model.js";
import { nextSelection, setState, toggleExpanded, useUiState } from "../store.js";
import { dispatch } from "../controller.js";

export function LayerTree() {
  const s = useUiState();
  if (!s.doc) return <div className="tree-empty">未打开文档</div>;
  const rows = flattenTree(s.doc.layers, s.expanded);
  return (
    <div className="tree">
      {rows.map(({ layer, depth, hasChildren }) => (
        <LayerRow key={layer.id} layer={layer} depth={depth} hasChildren={hasChildren} />
      ))}
    </div>
  );
}

function LayerRow({ layer, depth, hasChildren }: { layer: LocalLayer; depth: number; hasChildren: boolean }) {
  const s = useUiState();
  const selected = s.selection.includes(layer.id);
  const open = s.expanded.has(layer.id);
  const kind = layerKind(layer.type);
  const degraded = layer.degraded?.[0];

  return (
    <div
      className="tree-row"
      data-selected={selected || undefined}
      data-hidden={!layer.visible || undefined}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={(e) => setState({ selection: nextSelection(s, layer.id, e.metaKey || e.ctrlKey) })}
    >
      <button
        type="button"
        className="tree-eye mono"
        aria-label={`${layer.visible ? "隐藏" : "显示"} ${layer.name}`}
        onClick={(e) => {
          e.stopPropagation(); // toggling visibility must not move the selection
          void dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { visible: !layer.visible } } });
        }}
      >
        {layer.visible ? "●" : "○"}
      </button>
      {hasChildren
        ? (
          <button
            type="button"
            className="tree-caret mono"
            aria-label={`${open ? "收起" : "展开"} ${layer.name}`}
            onClick={(e) => { e.stopPropagation(); setState({ expanded: toggleExpanded(s, layer.id) }); }}
          >
            {open ? "▾" : "▸"}
          </button>
        )
        : <span className="tree-caret" />}
      <span className="kind mono" data-kind={kind.token}>{kind.label}</span>
      <span className="tree-name">{layer.name}</span>
      {degraded ? <span className="tag-warn mono" title={degraded.reason}>降级</span> : null}
    </div>
  );
}
```

- [ ] **Step 3: 实现 `src/ui/panels/side-panel.tsx`**

```tsx
import { countLayers } from "../../doc-model.js";
import { setState, useUiState } from "../store.js";
import { LayerTree } from "./layer-tree.js";

export function SidePanel() {
  const s = useUiState();
  const total = s.doc ? countLayers(s.doc.layers) : 0;
  return (
    <aside className="col-panel">
      <div className="col-head pane-tabs">
        <button type="button" data-on={s.pane === "layers" || undefined}
                onClick={() => setState({ pane: "layers" })}>图层</button>
        <button type="button" data-on={s.pane === "props" || undefined}
                onClick={() => setState({ pane: "props" })}>属性</button>
        <span className="spacer" />
        <span className="mono pane-meta">
          {s.pane === "layers" ? `${total} 图层` : `${s.selection.length} 已选`}
        </span>
      </div>
      {s.pane === "layers" ? <LayerTree /> : null}
    </aside>
  );
}
```

（`属性` 分支在 Task 12 补上。）

- [ ] **Step 4: 加样式**

追加到 `styles.css`：

```css
.pane-tabs { padding: 0 8px; gap: 2px; }
.pane-tabs button {
  height: 100%; padding: 0 13px; border: 0; background: transparent;
  font: inherit; color: var(--fg-3); font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.pane-tabs button[data-on] { color: var(--fg); font-weight: 600; border-bottom-color: var(--accent); }
.pane-meta { font-size: 10.5px; color: var(--fg-3); }

.tree { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
.tree-empty { padding: 14px; color: var(--fg-3); }

.tree-row {
  display: flex; align-items: center; gap: 6px;
  height: var(--row-h); padding-right: 10px; cursor: pointer;
}
.tree-row:hover { background: #00000008; }
.tree-row[data-selected] {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}
.tree-row[data-hidden] { color: var(--fg-dim); }

.tree-eye {
  width: 16px; flex: none; border: 0; background: transparent; cursor: pointer;
  display: grid; place-items: center; color: #9a9b93; font-size: 11px;
}
.tree-caret {
  width: 12px; flex: none; border: 0; background: transparent; cursor: pointer;
  text-align: center; color: var(--fg-dim); font-size: 9px;
}
.tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.kind {
  flex: none; font-size: 9px; border-radius: 3px; padding: 1px 4px;
  color: var(--kind-grp); background: #0000000a;
}
.kind[data-kind="text"] { color: var(--kind-text); background: color-mix(in srgb, var(--kind-text) 8%, transparent); }
.kind[data-kind="img"]  { color: var(--kind-img);  background: color-mix(in srgb, var(--kind-img) 8%, transparent); }
.kind[data-kind="shp"]  { color: var(--kind-shp);  background: color-mix(in srgb, var(--kind-shp) 8%, transparent); }
.kind[data-kind="adj"]  { color: var(--kind-adj);  background: color-mix(in srgb, var(--kind-adj) 8%, transparent); }

.tag-warn {
  flex: none; font-size: 9.5px; padding: 1px 5px; border-radius: 3px;
  color: var(--warn-ink);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent);
}
```

- [ ] **Step 5: 挂进 `app.tsx`**

把占位的 `<aside className="col-panel">…</aside>` 整块换成 `<SidePanel />`，并 import。

- [ ] **Step 6: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS。注意 `app-shell.test.tsx` 里对「图层」「属性」文本的断言现在由 `SidePanel` 提供，仍应通过。

Run: `pnpm dev psd`
Expected: 右栏出现图层树；点眼睛画布对应区域即时更新；分组能展开收起

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/panels/layer-tree.tsx packages/web-psd/src/ui/panels/side-panel.tsx \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/layer-tree.test.tsx
git commit -m "feat(web-psd): add the recursive layer tree with kind and degradation badges"
```

---
### Task 12: 属性面板（B8 B10 B12）

**Files:**
- Create: `packages/web-psd/src/ui/panels/props-pane.tsx`
- Modify: `packages/web-psd/src/ui/panels/side-panel.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/props-pane.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `set_props` 新白名单；Task 8 的 `selectedLayers` / `useUiState`；Task 9 的 `dispatch`
- Produces: `export function PropsPane(): JSX.Element`

**本期作用域（明确的边界，勿超出）：** 效果只支持**改已有的**和**移除**（传 `null`），不支持从无到有新建一个描边/投影——新建需要一整套参数表单，价值低、面积大，留到第二期。

四个分组：
1. **变换**（只读）：`x / y` `w / h` 取自 `layer.bounds`（`[top,left,bottom,right]`）
2. **外观**（可编辑）：`opacity` `fillOpacity` 滑块、`blendMode` 下拉、`locked` `clipping` 勾选
3. **效果**（有则显示）：描边可改 `size` 与颜色；颜色叠加可改颜色与 `opacity`；投影只读；三者各有「移除」
4. **IR 片段**（只读）：选中图层的 JSON，剔除像素与子树

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/props-pane.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PropsPane } from "../src/ui/panels/props-pane.js";
import { setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
vi.mock("../src/ui/controller.js", () => ({ dispatch: (op: unknown) => dispatch(op) }));

const STROKE = { color: { r: 255, g: 0, b: 0 }, opacity: 1, size: 3, position: "outside", blendMode: "normal" };

const layer = (over: Partial<LocalLayer> = {}): LocalLayer => ({
  id: "badge", type: "fill", name: "促销角标",
  opacity: 1, blendMode: "normal", visible: true,
  bounds: [214, 462, 336, 642], ...over,
});

beforeEach(() => {
  dispatch.mockClear();
  setState({ selection: ["badge"], doc: { canvas: { width: 800, height: 600 }, layers: [layer({ stroke: STROKE })] } });
});

describe("PropsPane", () => {
  it("prompts when nothing is selected", () => {
    setState({ selection: [] });
    render(<PropsPane />);
    expect(screen.getByText("未选中图层")).toBeInTheDocument();
  });

  it("derives x/y and w/h from bounds", () => {
    render(<PropsPane />);
    expect(screen.getByText("462, 214")).toBeInTheDocument();  // left, top
    expect(screen.getByText("180 × 122")).toBeInTheDocument(); // right-left, bottom-top
  });

  it("writes opacity through set_props", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("不透明度"), { target: { value: "50" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { opacity: 0.5 } },
    });
  });

  it("writes blendMode through set_props", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("混合模式"), { target: { value: "multiply" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { blendMode: "multiply" } },
    });
  });

  it("changes an existing stroke's size", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "8" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { stroke: { ...STROKE, size: 8 } } },
    });
  });

  it("removes an effect by sending null", () => {
    render(<PropsPane />);
    fireEvent.click(screen.getByLabelText("移除描边"));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { stroke: null } },
    });
  });

  it("shows an IR snippet without pixels or children", () => {
    setState({ doc: { canvas: { width: 800, height: 600 },
      layers: [{ ...layer(), children: [layer({ id: "kid" })] } as LocalLayer] } });
    render(<PropsPane />);
    const snippet = screen.getByLabelText("IR 片段").textContent!;
    expect(snippet).toContain('"id": "badge"');
    expect(snippet).not.toContain("children");
    expect(snippet).not.toContain("pixels");
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/props-pane.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 实现 `src/ui/panels/props-pane.tsx`**

```tsx
import { selectedLayers, useUiState } from "../store.js";
import { dispatch } from "../controller.js";
import type { LocalLayer } from "../../doc-model.js";

const BLEND_MODES = [
  "normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn",
  "lighten", "screen", "color-dodge", "linear-dodge", "overlay",
  "soft-light", "hard-light", "vivid-light", "linear-light",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity", "pass-through",
];

interface Stroke { color: { r: number; g: number; b: number }; opacity: number; size: number; position: string; blendMode: string }
interface Overlay { r: number; g: number; b: number; opacity: number }

const hex = (c: { r: number; g: number; b: number }): string =>
  "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
const unhex = (s: string): { r: number; g: number; b: number } => ({
  r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16),
});

/** Everything the IR snippet must not show: raw pixel buffers and the subtree. */
const IR_OMIT = new Set(["pixels", "mask", "children"]);

export function PropsPane() {
  const s = useUiState();
  const sel = selectedLayers(s);
  if (sel.length === 0) return <div className="tree-empty">未选中图层</div>;
  // Multi-select edits every selected layer with the same value; the readouts
  // below describe the first one, matching the design's single-target panel.
  const l = sel[0];
  const ids = sel.map((x) => x.id);

  const write = (props: Record<string, unknown>): void => {
    for (const layerId of ids) void dispatch({ kind: "set_props", payload: { layerId, props } });
  };

  const [top, left, bottom, right] = l.bounds ?? [0, 0, 0, 0];
  const stroke = l.stroke as Stroke | undefined;
  const overlay = l.colorOverlay as Overlay | undefined;
  const shadow = l.dropShadow as { size: number; distance: number; angle: number } | undefined;

  const ir = JSON.stringify(
    Object.fromEntries(Object.entries(l).filter(([k]) => !IR_OMIT.has(k))),
    null, 2,
  );

  return (
    <div className="props">
      <div className="props-ctx mono">{`ir.root.${l.name}`}</div>

      <section className="prop-group">
        <h3>变换</h3>
        <Row k="x / y" v={`${left}, ${top}`} />
        <Row k="w / h" v={`${right - left} × ${bottom - top}`} />
      </section>

      <section className="prop-group">
        <h3>外观</h3>
        <label className="prop-row">
          <span>不透明度</span>
          <input aria-label="不透明度" type="range" min={0} max={100}
                 value={Math.round(l.opacity * 100)}
                 onChange={(e) => write({ opacity: Number(e.target.value) / 100 })} />
        </label>
        <label className="prop-row">
          <span>填充不透明度</span>
          <input aria-label="填充不透明度" type="range" min={0} max={100}
                 value={Math.round((l.fillOpacity ?? 1) * 100)}
                 onChange={(e) => write({ fillOpacity: Number(e.target.value) / 100 })} />
        </label>
        <label className="prop-row">
          <span>混合模式</span>
          <select aria-label="混合模式" value={l.blendMode}
                  onChange={(e) => write({ blendMode: e.target.value })}>
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="prop-row">
          <span>锁定</span>
          <input aria-label="锁定" type="checkbox" checked={!!l.locked}
                 onChange={(e) => write({ locked: e.target.checked })} />
        </label>
        <label className="prop-row">
          <span>剪贴到下层</span>
          <input aria-label="剪贴到下层" type="checkbox" checked={!!l.clipping}
                 onChange={(e) => write({ clipping: e.target.checked })} />
        </label>
      </section>

      {(stroke || overlay || shadow) ? (
        <section className="prop-group">
          <h3>效果</h3>
          {stroke ? (
            <>
              <label className="prop-row">
                <span>描边宽度</span>
                <input aria-label="描边宽度" type="number" min={0} value={stroke.size}
                       onChange={(e) => write({ stroke: { ...stroke, size: Number(e.target.value) } })} />
              </label>
              <label className="prop-row">
                <span>描边颜色</span>
                <input aria-label="描边颜色" type="color" value={hex(stroke.color)}
                       onChange={(e) => write({ stroke: { ...stroke, color: unhex(e.target.value) } })} />
              </label>
              <Row k="描边位置" v={stroke.position} />
              <button type="button" className="btn-link" aria-label="移除描边"
                      onClick={() => write({ stroke: null })}>移除描边</button>
            </>
          ) : null}
          {overlay ? (
            <>
              <label className="prop-row">
                <span>颜色叠加</span>
                <input aria-label="颜色叠加" type="color" value={hex(overlay)}
                       onChange={(e) => write({ colorOverlay: { ...unhex(e.target.value), opacity: overlay.opacity } })} />
              </label>
              <button type="button" className="btn-link" aria-label="移除颜色叠加"
                      onClick={() => write({ colorOverlay: null })}>移除颜色叠加</button>
            </>
          ) : null}
          {shadow ? (
            <>
              <Row k="投影" v={`${shadow.distance}px @ ${shadow.angle}° · 模糊 ${shadow.size}`} />
              <button type="button" className="btn-link" aria-label="移除投影"
                      onClick={() => write({ dropShadow: null })}>移除投影</button>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="prop-group">
        <h3>IR 片段</h3>
        <pre className="ir mono" aria-label="IR 片段">{ir}</pre>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="prop-row"><span>{k}</span><span className="mono">{v}</span></div>;
}
```

- [ ] **Step 3: 加样式**

追加到 `styles.css`：

```css
.props { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 16px; }
.props-ctx { font-size: 10.5px; color: var(--fg-3); margin-bottom: 10px; word-break: break-all; }
.prop-group { margin-bottom: 14px; }
.prop-group h3 {
  margin: 0 0 6px; font-size: 11px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; color: var(--fg-3);
}
.prop-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; min-height: 24px; font-size: 12px;
}
.prop-row > span:first-child { color: var(--fg-2); flex: none; }
.prop-row input[type="range"] { width: 140px; }
.prop-row input[type="number"] { width: 64px; }
.prop-row select { max-width: 150px; font: inherit; }
.btn-link {
  border: 0; background: transparent; padding: 2px 0; cursor: pointer;
  color: var(--accent-ink); font: inherit; font-size: 11.5px;
}
.ir {
  margin: 0; padding: 8px 9px; border: 1px solid var(--border); border-radius: 6px;
  background: #f7f5f1; color: #4a4b45; font-size: 11px; line-height: 1.65;
  white-space: pre; overflow-x: auto;
}
```

- [ ] **Step 4: 挂进 `side-panel.tsx`**

```tsx
      {s.pane === "layers" ? <LayerTree /> : <PropsPane />}
```

- [ ] **Step 5: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

Run: `pnpm dev psd` —— 选中一个图层 → 切到「属性」→ 拖不透明度滑块，画布即时更新；控制台不应出现 `local apply failed`

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/ui/panels/props-pane.tsx packages/web-psd/src/ui/panels/side-panel.tsx \
        packages/web-psd/src/ui/styles.css packages/web-psd/tests/props-pane.test.tsx
git commit -m "feat(web-psd): add the properties pane with editable appearance and effects"
```

---

### Task 13: 工具条、选区与取色（C3 C5 C8）

**Files:**
- Create: `packages/web-psd/src/ui/panels/tool-strip.tsx`
- Create: `packages/web-psd/src/ui/panels/selection-overlay.tsx`
- Create: `packages/web-psd/src/ui/panels/context-bar.tsx`
- Modify: `packages/web-psd/src/doc-controller.ts`（加两个坐标换算方法）
- Modify: `packages/web-psd/src/ui/panels/canvas-stage.tsx`, `src/ui/app.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/selection.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 `getController` / `dispatch`；Task 8 的 `tool` / `marquee` 状态
- Produces:
  - `DocController.toCanvas(clientX: number, clientY: number): { x: number; y: number }`
  - `DocController.toScreen(cx: number, cy: number): { x: number; y: number }`
  - `export function ToolStrip(): JSX.Element`
  - `export function SelectionOverlay(): JSX.Element`
  - `export function ContextBar(): JSX.Element`

**选区的三个真实出口（设计稿的手柄「拖拽缩放图层内容」依赖第二期的 scale op，本期不做，手柄只改选区本身）：**
1. `裁到选区` → `{ kind: "crop", payload: { rect: [top,left,bottom,right] } }`
2. `局部预览` → 打开 `${API_BASE_URL}/docs/psd/{docId}/query`（`getPreview {rect}`）的结果图
3. 选区尺寸作为文本进入 Chat 输入框（Task 16 接）

- [ ] **Step 1: 给 `DocController` 加坐标换算**

`Viewport` 已实现 `screenToCanvas` / `canvasToScreen`，只需转发：

```ts
  /** Client (viewport) coords → document pixels. */
  toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return this.viewport?.screenToCanvas(clientX - r.left, clientY - r.top) ?? { x: 0, y: 0 };
  }

  /** Document pixels → coords relative to the canvas element's top-left. */
  toScreen(cx: number, cy: number): { x: number; y: number } {
    return this.viewport?.canvasToScreen(cx, cy) ?? { x: 0, y: 0 };
  }
```

- [ ] **Step 2: 写失败的测试**

创建 `packages/web-psd/tests/selection.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ContextBar } from "../src/ui/panels/context-bar.js";
import { setState, getState } from "../src/ui/store.js";

const dispatch = vi.fn();
const pickColor = vi.fn(() => "#f5efe3");
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => dispatch(op),
  getController: () => ({ pickColor, toCanvas: (x: number, y: number) => ({ x, y }) }),
}));

beforeEach(() => {
  dispatch.mockClear();
  setState({ tool: "move", marquee: null, selection: [], pickedColor: null });
});

describe("ToolStrip", () => {
  it("switches the active tool", () => {
    render(<ToolStrip />);
    fireEvent.click(screen.getByText("框选"));
    expect(getState().tool).toBe("marquee");
    fireEvent.click(screen.getByText("取色"));
    expect(getState().tool).toBe("eyedrop");
  });
});

describe("ContextBar", () => {
  it("stays quiet with no marquee", () => {
    render(<ContextBar />);
    expect(screen.queryByText("裁到选区")).not.toBeInTheDocument();
  });

  it("reports the marquee size and crops to it", () => {
    setState({ marquee: [10, 20, 132, 200] });
    render(<ContextBar />);
    expect(screen.getByText("选区 180 × 122")).toBeInTheDocument();
    fireEvent.click(screen.getByText("裁到选区"));
    expect(dispatch).toHaveBeenCalledWith({ kind: "crop", payload: { rect: [10, 20, 132, 200] } });
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/selection.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现三个组件**

`src/ui/panels/tool-strip.tsx`：

```tsx
import { setState, useUiState, type ToolId } from "../store.js";

const TOOLS: { id: ToolId; label: string }[] = [
  { id: "move", label: "移动" },
  { id: "marquee", label: "框选" },
  { id: "eyedrop", label: "取色" },
];

export function ToolStrip() {
  const s = useUiState();
  return (
    <div className="tools">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" data-on={s.tool === t.id || undefined}
                onClick={() => setState({ tool: t.id })}>{t.label}</button>
      ))}
    </div>
  );
}
```

`src/ui/panels/selection-overlay.tsx` —— 蚂蚁线用四条 CSS 渐变边 + `ants` 动画（与设计稿一致），四角手柄是绝对定位的小方块，本期**只改选区**：

```tsx
import { getController } from "../controller.js";
import { useUiState } from "../store.js";

/** Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 *  compositor never has to re-render for a selection change. */
export function SelectionOverlay() {
  const s = useUiState();
  const c = getController();
  if (!s.marquee || !c) return null;
  const [top, left, bottom, right] = s.marquee;
  const a = c.toScreen(left, top);
  const b = c.toScreen(right, bottom);
  return (
    <div className="marquee" style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
    </div>
  );
}
```

`src/ui/panels/context-bar.tsx`：

```tsx
import { dispatch } from "../controller.js";
import { selectedLayers, setState, useUiState } from "../store.js";
import { ToolStrip } from "./tool-strip.js";

export function ContextBar() {
  const s = useUiState();
  const sel = selectedLayers(s);
  const m = s.marquee;
  return (
    <div className="context-bar">
      <span className="mono ctx-path">
        {sel.length ? `ir.root.${sel.map((l) => l.name).join(" + ")}` : "未选中图层"}
      </span>
      {m ? <span className="mono ctx-size">{`选区 ${m[3] - m[1]} × ${m[2] - m[0]}`}</span> : null}
      {m ? (
        <>
          <button type="button" className="btn-link"
                  onClick={() => void dispatch({ kind: "crop", payload: { rect: m } })}>裁到选区</button>
          <button type="button" className="btn-link"
                  onClick={() => setState({ marquee: null })}>清除选区</button>
        </>
      ) : null}
      {s.pickedColor ? (
        <span className="mono picked">
          <i style={{ background: s.pickedColor }} />{s.pickedColor}
        </span>
      ) : null}
      <span className="spacer" />
      <ToolStrip />
    </div>
  );
}
```

- [ ] **Step 4: 在 `canvas-stage.tsx` 接上鼠标交互**

整份替换 `src/ui/panels/canvas-stage.tsx`：

```tsx
import { useEffect, useRef } from "react";
import { getController, initController } from "../controller.js";
import { getState, setState } from "../store.js";
import type { Rect } from "../../doc-model.js";
import { SelectionOverlay } from "./selection-overlay.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 *
 * Panning needs no code: `.stage` is `overflow: auto`, and Viewport.visibleTiles
 * reads its scroll offsets, so native scrolling IS the pan gesture (the same
 * arrangement as before the redesign).
 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  // Marquee drag origin, in document pixels. A ref, not state: it changes on
  // every pointermove and must not re-render the tree mid-drag.
  const anchor = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (stageRef.current && viewRef.current) initController(viewRef.current, stageRef.current);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    const s = getState();
    if (s.tool === "eyedrop") {
      setState({ pickedColor: c.pickColor(e.clientX, e.clientY) });
      return;
    }
    if (s.tool === "marquee") {
      anchor.current = c.toCanvas(e.clientX, e.clientY);
      setState({ marquee: null });
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || !anchor.current) return;
    setState({ marquee: normalise(anchor.current, c.toCanvas(e.clientX, e.clientY)) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!anchor.current) return;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="stage"
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas className="view" ref={viewRef} aria-label="rendered preview" />
      <SelectionOverlay />
    </div>
  );
}

/** Two document-space points → an integer [top,left,bottom,right] rect, in the
 *  engine's convention, regardless of which way the drag went. */
function normalise(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return [
    Math.round(Math.min(a.y, b.y)), Math.round(Math.min(a.x, b.x)),
    Math.round(Math.max(a.y, b.y)), Math.round(Math.max(a.x, b.x)),
  ];
}
```

- [ ] **Step 5: 加样式**

```css
.context-bar {
  height: 38px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 12px; background: var(--panel); border-top: 1px solid var(--border);
}
.ctx-path { flex: 0 1 auto; min-width: 0; font-size: 11.5px; color: var(--fg-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-size { font-size: 10.5px; color: var(--warn-ink); }
.picked { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.picked i { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }

.tools { flex: none; display: flex; gap: 5px; }
.tools button {
  height: 24px; padding: 0 10px; white-space: nowrap; border-radius: var(--radius);
  border: 1px solid var(--border); background: #fff; color: var(--fg-2);
  font: inherit; font-size: 12px; cursor: pointer;
}
.tools button[data-on] {
  color: var(--accent-ink);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
}

.marquee {
  position: absolute; pointer-events: none;
  background-image:
    linear-gradient(90deg, var(--accent) 50%, transparent 50%),
    linear-gradient(90deg, var(--accent) 50%, transparent 50%),
    linear-gradient(0deg, var(--accent) 50%, transparent 50%),
    linear-gradient(0deg, var(--accent) 50%, transparent 50%);
  background-size: 16px 1.5px, 16px 1.5px, 1.5px 16px, 1.5px 16px;
  background-position: 0 0, 0 100%, 0 0, 100% 0;
  background-repeat: repeat-x, repeat-x, repeat-y, repeat-y;
  animation: ants .8s linear infinite;
}
.marquee .h { position: absolute; width: 6px; height: 6px; background: #fff; border: 1.5px solid var(--accent); }
.marquee .tl { left: -3px; top: -3px; }
.marquee .tr { right: -3px; top: -3px; }
.marquee .bl { left: -3px; bottom: -3px; }
.marquee .br { right: -3px; bottom: -3px; }
```

- [ ] **Step 6: 挂进 `app.tsx`**

中栏改为 `<CanvasStage />` + `<ContextBar />`。

- [ ] **Step 7: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

Run: `pnpm dev psd` —— 切到「框选」拖一个矩形，看到蚂蚁线与四角手柄；「裁到选区」后画布尺寸变化且图层树仍正常；切到「取色」单击画布，上下文条出现色值

- [ ] **Step 8: 提交**

```bash
git add packages/web-psd/src/ui/panels/tool-strip.tsx packages/web-psd/src/ui/panels/selection-overlay.tsx \
        packages/web-psd/src/ui/panels/context-bar.tsx packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/src/doc-controller.ts packages/web-psd/src/ui/store.ts \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/selection.test.tsx packages/web-psd/tests/store.test.ts
git commit -m "feat(web-psd): add marquee selection, crop-to-selection and the eyedropper"
```

---

### Task 14: 移动工具 —— 画布上拖拽图层（C4）

**Files:**
- Modify: `packages/web-psd/src/ui/panels/canvas-stage.tsx`
- Create: `packages/web-psd/src/ui/drag.ts`
- Test: `packages/web-psd/tests/drag.test.ts`

**Interfaces:**
- Consumes: Task 13 的 `DocController.toCanvas`
- Produces（`src/ui/drag.ts`，纯函数，便于单测）:
  - `interface DragState { layerIds: string[]; from: { x: number; y: number }; last: { x: number; y: number } }`
  - `translateOps(drag: DragState, to: { x: number; y: number }): { kind: "transform"; payload: Record<string, unknown> }[]`

后端只支持 `transform{ layerId, op: { translate: [dx, dy] } }`（无缩放、无旋转——那是第二期的地基 5b）。拖拽期间**按增量**下发，每次用相对上一帧的位移，这样每个 op 都能独立应用、也能独立回退。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/drag.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { translateOps, type DragState } from "../src/ui/drag.js";

const drag = (last: { x: number; y: number }): DragState =>
  ({ layerIds: ["a", "b"], from: { x: 10, y: 10 }, last });

describe("translateOps", () => {
  it("emits one op per layer with the delta since the last frame", () => {
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 22, y: 4 })).toEqual([
      { kind: "transform", payload: { layerId: "a", op: { translate: [12, -6] } } },
      { kind: "transform", payload: { layerId: "b", op: { translate: [12, -6] } } },
    ]);
  });

  it("rounds to whole pixels and drops sub-pixel moves entirely", () => {
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 10.4, y: 10.4 })).toEqual([]);
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 11.6, y: 10 })).toEqual([
      { kind: "transform", payload: { layerId: "a", op: { translate: [2, 0] } } },
      { kind: "transform", payload: { layerId: "b", op: { translate: [2, 0] } } },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/web-psd test tests/drag.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/ui/drag.ts`**

```ts
export interface DragState {
  layerIds: string[];
  from: { x: number; y: number };
  last: { x: number; y: number };
}

export interface TransformOp { kind: "transform"; payload: Record<string, unknown> }

/**
 * Ops for one drag frame: the INCREMENT since `drag.last`, one per selected
 * layer. Increments (rather than an absolute offset from `drag.from`) keep
 * every op independently applicable and independently reversible, which is
 * what the delta log and /rollback expect.
 *
 * Sub-pixel movement produces no ops at all — the engine's transform takes
 * integer pixels, and rounding each frame independently would accumulate drift.
 */
export function translateOps(drag: DragState, to: { x: number; y: number }): TransformOp[] {
  const dx = Math.round(to.x - drag.last.x);
  const dy = Math.round(to.y - drag.last.y);
  if (dx === 0 && dy === 0) return [];
  return drag.layerIds.map((layerId) => ({
    kind: "transform",
    payload: { layerId, op: { translate: [dx, dy] } },
  }));
}
```

- [ ] **Step 4: 在 `canvas-stage.tsx` 接上**

在 Task 13 那份 `canvas-stage.tsx` 上加一个 `drag` ref 与 `move` 分支。改动三处：

顶部加 import 与 ref：

```tsx
import { dispatch, getController, initController } from "../controller.js";
import { translateOps, type DragState } from "../drag.js";

  const drag = useRef<DragState | null>(null);
```

`onPointerDown` 里，`marquee` 分支之前加：

```tsx
    if (s.tool === "move" && s.selection.length > 0) {
      const at = c.toCanvas(e.clientX, e.clientY);
      drag.current = { layerIds: [...s.selection], from: at, last: at };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
```

`onPointerMove` 里，`anchor` 分支之前加：

```tsx
    if (drag.current) {
      const to = c.toCanvas(e.clientX, e.clientY);
      const ops = translateOps(drag.current, to);
      for (const op of ops) void dispatch(op);
      // Advance `last` by the WHOLE PIXELS actually dispatched, not to `to`:
      // otherwise the sub-pixel remainder translateOps discarded would be lost
      // on every frame and the layer would drift behind the cursor.
      const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
      drag.current = { ...drag.current, last: { x: drag.current.last.x + dx, y: drag.current.last.y + dy } };
      return;
    }
```

`onPointerUp` 改为：

```tsx
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag.current && !anchor.current) return;
    drag.current = null;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
```

- [ ] **Step 5: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

Run: `pnpm dev psd` —— 选中一个图层，用「移动」工具在画布上拖动，图层跟随；松手后图层树与属性面板里的 `x / y` 同步更新

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/ui/drag.ts packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/tests/drag.test.ts
git commit -m "feat(web-psd): drag selected layers on the canvas with the move tool"
```

---
### Task 15: 历史与回退（D3 D4 D5 D6）

**Files:**
- Create: `packages/web-psd/src/ui/api.ts`
- Create: `packages/web-psd/src/ui/panels/ops-list.tsx`
- Create: `packages/web-psd/src/ui/panels/history-drawer.tsx`
- Modify: `packages/web-psd/src/ui/styles.css`
- Test: `packages/web-psd/tests/api.test.ts`, `packages/web-psd/tests/history.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `API_BASE_URL` / `TYPE`；Task 8 的 `HistoryEntry` / `opsSinceSession`
- Produces（`src/ui/api.ts`）:
  - `fetchHistory(docId: string): Promise<HistoryEntry[]>`
  - `rollback(docId: string, version: number): Promise<number>`（返回回退后的新 version）
  - `runAgent(docId: string, instruction: string): Promise<string>`
  - `resetAgent(docId: string): Promise<void>`
- Produces（组件）: `export function OpsList(props: { entries: HistoryEntry[]; defaultOpen?: boolean }): JSX.Element`、`export function HistoryDrawer(): JSX.Element`

**路由（已核实 `doctype-server-common/src/doc-type-handler.ts` 的方法表）：**
`GET …/history`、`POST …/rollback`、`POST …/run`、`POST …/reset`，路径前缀是 `${API_BASE_URL}/docs/psd/{docId}`。

**本期的两处降级（设计文档已记录，勿自行"补全"）：**
- **D5 diff**：`/history` 只返回 `operations[]`，**没有 before 值**。只渲染 op 本身（设计稿 diff 中 `+` 的那半边），不做 `−`。
- **D3 会话边界**：服务端无 session 概念，用 `sessionBaseVersion`（页面打开时的 version）在前端切分。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/api.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchHistory, rollback, runAgent, resetAgent } from "../src/ui/api.js";

const json = (body: unknown) => ({ json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("api", () => {
  it("GETs history and returns its data array", async () => {
    const entries = [{ version: 7, timestamp: "t", description: "d", operations: [] }];
    fetchMock.mockResolvedValue(json({ success: true, data: entries, version: 7 }));
    expect(await fetchHistory("abc")).toEqual(entries);
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/history");
  });

  it("POSTs rollback with the target version and returns the new one", async () => {
    fetchMock.mockResolvedValue(json({ success: true, version: 12 }));
    expect(await rollback("abc", 9)).toBe(12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/docs/psd/abc/rollback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ version: 9 });
  });

  it("POSTs run and returns the agent's reply", async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { response: "done", iterations: 2 } }));
    expect(await runAgent("abc", "把角标挪到右下")).toBe("done");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ instruction: "把角标挪到右下" });
  });

  it("POSTs reset", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await resetAgent("abc");
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/reset");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("throws the server's error message", async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: "no such doc" }));
    await expect(fetchHistory("abc")).rejects.toThrow("no such doc");
  });
});
```

创建 `packages/web-psd/tests/history.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OpsList } from "../src/ui/panels/ops-list.js";
import { HistoryDrawer } from "../src/ui/panels/history-drawer.js";
import { setState, getState } from "../src/ui/store.js";

const rollback = vi.fn(async () => 14);
const reconcile = vi.fn(async () => {});
vi.mock("../src/ui/api.js", () => ({ rollback: (...a: unknown[]) => rollback(...(a as [])), fetchHistory: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({ getController: () => ({ reconcile }) }));

const entry = (version: number, ops: unknown[] = [{ kind: "transform" }]) =>
  ({ version, timestamp: "2026-08-28T00:00:00Z", description: `op#${version}`, operations: ops });

beforeEach(() => {
  rollback.mockClear(); reconcile.mockClear();
  setState({ docId: "abc", version: 14, sessionBaseVersion: 11, historyOpen: true,
             history: [entry(12), entry(13), entry(14)] });
});

describe("OpsList", () => {
  it("summarises the operation count and expands to show the op JSON", () => {
    render(<OpsList entries={[entry(12), entry(13)]} />);
    expect(screen.getByText("2 operations")).toBeInTheDocument();
    expect(screen.queryByText(/"kind": "transform"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看 diff"));
    expect(screen.getAllByText(/"kind": "transform"/).length).toBe(2);
  });

  it("rolls back to the version BEFORE the first listed entry", async () => {
    render(<OpsList entries={[entry(12), entry(13)]} />);
    fireEvent.click(screen.getByText("回退这 2 步"));
    expect(rollback).toHaveBeenCalledWith("abc", 11);
  });
});

describe("HistoryDrawer", () => {
  it("lists only this session's ops and labels the current head", () => {
    render(<HistoryDrawer />);
    expect(screen.getByText("op#12")).toBeInTheDocument();
    expect(screen.getByText("op#14")).toBeInTheDocument();
    expect(screen.getByLabelText("当前版本")).toHaveTextContent("op#14");
  });

  it("closes on the close button", () => {
    render(<HistoryDrawer />);
    fireEvent.click(screen.getByLabelText("关闭历史"));
    expect(getState().historyOpen).toBe(false);
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/api.test.ts tests/history.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 实现 `src/ui/api.ts`**

```ts
import { API_BASE_URL, TYPE } from "../doc-controller.js";
import type { HistoryEntry } from "./store.js";

const docUrl = (docId: string, method: string): string =>
  `${API_BASE_URL}/docs/${TYPE}/${docId}/${method}`;

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json() as { success?: boolean; error?: string } & T;
  if (body.success === false) throw new Error(body.error ?? "request failed");
  return body;
}

export async function fetchHistory(docId: string): Promise<HistoryEntry[]> {
  const body = await readJson<{ data?: HistoryEntry[] }>(await fetch(docUrl(docId, "history")));
  return body.data ?? [];
}

/** Rolls the document back to `version`. Rollback moves the version FORWARD
 *  (it appends a synthetic delta), so the returned number is the new head. */
export async function rollback(docId: string, version: number): Promise<number> {
  const body = await readJson<{ version: number }>(await fetch(docUrl(docId, "rollback"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  }));
  return body.version;
}

export async function runAgent(docId: string, instruction: string): Promise<string> {
  const body = await readJson<{ data?: { response?: string } }>(await fetch(docUrl(docId, "run"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction }),
  }));
  const reply = body.data?.response;
  return typeof reply === "string" && reply.trim() ? reply : "(done)";
}

/** Clears the Operator's in-memory conversation for this document. */
export async function resetAgent(docId: string): Promise<void> {
  await readJson(await fetch(docUrl(docId, "reset"), { method: "POST" }));
}
```

- [ ] **Step 3: 实现 `src/ui/panels/ops-list.tsx`**

```tsx
import { useState } from "react";
import { rollback } from "../api.js";
import { getController } from "../controller.js";
import { getState, setState, type HistoryEntry } from "../store.js";

/**
 * The design nests this inside an agent message. It also backs the history
 * drawer, because locally-made edits belong to no message.
 *
 * The "diff" is the op payload ITSELF — the `+` half of the design's diff.
 * /history carries no before-values, so the `−` half is deliberately absent
 * (see the phase-1 design doc, §5.3).
 */
export function OpsList({ entries, defaultOpen = false }: { entries: HistoryEntry[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  if (entries.length === 0) return null;

  const ops = entries.flatMap((e) => e.operations);
  // Rolling back "these N steps" means returning to the state just before the
  // FIRST of them — i.e. one version below it.
  const target = entries[0].version - 1;

  const undo = async (): Promise<void> => {
    const docId = getState().docId;
    if (!docId || busy) return;
    setBusy(true);
    try {
      await rollback(docId, target);
      await getController()?.reconcile();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops">
      <button type="button" className="ops-head" onClick={() => setOpen(!open)}>
        <span className="mono caret">{open ? "▾" : "▸"}</span>
        <span className="mono">{ops.length} operations</span>
        <span className="tag-ok mono">已应用</span>
        <span className="spacer" />
        <span className="ops-toggle">查看 diff</span>
      </button>
      {open ? <pre className="ir mono">{JSON.stringify(ops, null, 2)}</pre> : null}
      <div className="ops-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void undo()}>
          回退这 {entries.length} 步
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 `src/ui/panels/history-drawer.tsx`**

```tsx
import { opsSinceSession, setState, useUiState } from "../store.js";
import { OpsList } from "./ops-list.js";

/**
 * Covers the chat column with the full delta log. The design nests ops inside
 * agent messages, but locally-made edits (dragging a layer, moving a slider)
 * belong to no message — this is where they show up.
 *
 * `store.history` is filled by the chat header when the drawer opens, and
 * again after every agent turn (see chat-panel.tsx).
 */
export function HistoryDrawer() {
  const s = useUiState();
  const entries = opsSinceSession(s);
  return (
    <div className="drawer">
      <div className="col-head">
        <strong>历史</strong>
        <span className="mono pane-meta">{`${entries.length} ops · 本次会话`}</span>
        <span className="spacer" />
        <button type="button" className="chip" aria-label="关闭历史"
                onClick={() => setState({ historyOpen: false })}>关闭</button>
      </div>
      <div className="drawer-body">
        {entries.length === 0
          ? <div className="tree-empty">本次会话还没有改动</div>
          : [...entries].reverse().map((e) => (
              <div key={e.version} className="drawer-row"
                   data-head={e.version === s.version || undefined}
                   aria-label={e.version === s.version ? "当前版本" : undefined}>
                <div className="drawer-row-head">
                  <span className="mono">{e.description}</span>
                  <span className="spacer" />
                  <span className="mono pane-meta">{e.timestamp.slice(11, 19)}</span>
                </div>
                <OpsList entries={[e]} />
              </div>
            ))}
      </div>
    </div>
  );
}
```

样式补一条：

```css
.drawer-row-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
```

- [ ] **Step 5: 加样式**

```css
.ops { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: #fff; }
.ops-head {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 11px;
  border: 0; background: transparent; font: inherit; cursor: pointer; text-align: left;
}
.ops-head .caret { font-size: 10px; color: #6e6f68; }
.ops-toggle { font-size: 11px; color: var(--fg-3); }
.ops-actions { display: flex; gap: 6px; padding: 0 11px 10px; }
.ops-actions .btn { height: 26px; padding: 0 11px; border-radius: 6px; background: #f0eee9; }
.tag-ok {
  font-size: 10px; padding: 1px 5px; border-radius: 3px; color: var(--accent-ink);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
}
.drawer {
  position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
  background: var(--panel);
}
.drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.drawer-row { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: #fff; }
.drawer-row[data-head] { border-color: var(--accent); }
.col-chat { position: relative; }  /* the drawer anchors to this column */
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/api.ts packages/web-psd/src/ui/panels/ops-list.tsx \
        packages/web-psd/src/ui/panels/history-drawer.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/api.test.ts packages/web-psd/tests/history.test.tsx
git commit -m "feat(web-psd): add the history drawer, op list and rollback"
```

---

### Task 16: 左栏 Chat（D1 D11 + ops 内嵌）

**Files:**
- Create: `packages/web-psd/src/ui/panels/chat-panel.tsx`
- Create: `packages/web-psd/src/ui/panels/composer.tsx`
- Modify: `packages/web-psd/src/ui/app.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/chat.test.tsx`

**Interfaces:**
- Consumes: Task 15 的 `runAgent` / `resetAgent` / `fetchHistory`；Task 15 的 `OpsList` / `HistoryDrawer`
- Produces: `export function ChatPanel(): JSX.Element`、`export function Composer(): JSX.Element`

发送流程（与重构前一致，只是换了外壳）：追加用户消息 → 追加 pending 的 agent 消息 → `runAgent` → 成功后 `controller.reconcile()`（内部会 rebase + 重绘 + 触发 `onDoc`）→ 用 `fetchHistory` 刷新 `store.history` → 把 pending 消息替换为真实回复，并记下 `fromVersion`（发送前的 version）与 `toVersion`（reconcile 后的 version），供消息内嵌的 `OpsList` 切片。

`@图层` 按钮把当前选中图层名以 `@名称 ` 形式插入输入框——**本期只是文本**，不是结构化上下文（那是第二期的地基 6）。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/chat.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatPanel } from "../src/ui/panels/chat-panel.js";
import { setState, getState } from "../src/ui/store.js";

const runAgent = vi.fn(async () => "角标已移到右下");
const resetAgent = vi.fn(async () => {});
const fetchHistory = vi.fn(async () => [
  { version: 12, timestamp: "t", description: "op#12", operations: [{ kind: "transform" }] },
]);
const reconcile = vi.fn(async () => { setState({ version: 12 }); });

vi.mock("../src/ui/api.js", () => ({
  runAgent: (...a: unknown[]) => runAgent(...(a as [])),
  resetAgent: (...a: unknown[]) => resetAgent(...(a as [])),
  fetchHistory: (...a: unknown[]) => fetchHistory(...(a as [])),
  rollback: vi.fn(),
}));
vi.mock("../src/ui/controller.js", () => ({ getController: () => ({ reconcile }) }));

beforeEach(() => {
  runAgent.mockClear(); resetAgent.mockClear(); fetchHistory.mockClear(); reconcile.mockClear();
  setState({ docId: "abc", version: 11, sessionBaseVersion: 11, chat: [], chatBusy: false,
             history: [], historyOpen: false, selection: [], doc: null });
});

describe("ChatPanel", () => {
  it("sends an instruction, reconciles, then shows the reply", async () => {
    render(<ChatPanel />);
    fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: "把角标挪到右下" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("角标已移到右下")).toBeInTheDocument());
    expect(runAgent).toHaveBeenCalledWith("abc", "把角标挪到右下");
    expect(reconcile).toHaveBeenCalled();
    expect(fetchHistory).toHaveBeenCalledWith("abc");
    const reply = getState().chat.at(-1)!;
    expect(reply.fromVersion).toBe(11);
    expect(reply.toVersion).toBe(12);
  });

  it("surfaces an agent failure as an error message", async () => {
    runAgent.mockRejectedValueOnce(new Error("llm unavailable"));
    render(<ChatPanel />);
    fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: "x" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("llm unavailable")).toBeInTheDocument());
    expect(getState().chatBusy).toBe(false);
  });

  it("clears the transcript and the server session on 新会话", async () => {
    setState({ chat: [{ role: "user", text: "hi" }] });
    render(<ChatPanel />);
    fireEvent.click(screen.getByText("新会话"));
    await waitFor(() => expect(getState().chat).toEqual([]));
    expect(resetAgent).toHaveBeenCalledWith("abc");
  });

  it("opens the history drawer from the ops counter", async () => {
    setState({ history: [{ version: 12, timestamp: "t", description: "op#12", operations: [] }] });
    render(<ChatPanel />);
    fireEvent.click(screen.getByText(/1 ops · 本次会话/));
    await waitFor(() => expect(getState().historyOpen).toBe(true));
    expect(fetchHistory).toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter @unidocs/web-psd test tests/chat.test.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 2: 实现 `src/ui/panels/chat-panel.tsx`**

```tsx
import { fetchHistory, resetAgent, runAgent } from "../api.js";
import { getController } from "../controller.js";
import { getState, opsSinceSession, setState, useUiState, type ChatMessage } from "../store.js";
import { Composer } from "./composer.js";
import { HistoryDrawer } from "./history-drawer.js";
import { OpsList } from "./ops-list.js";

export function ChatPanel() {
  const s = useUiState();
  const sessionOps = opsSinceSession(s);

  const openHistory = async (): Promise<void> => {
    const docId = getState().docId;
    if (!docId) return;
    setState({ historyOpen: true });
    setState({ history: await fetchHistory(docId) });
  };

  const newSession = async (): Promise<void> => {
    const docId = getState().docId;
    setState({ chat: [] });
    if (docId) await resetAgent(docId);
  };

  const send = async (text: string): Promise<void> => {
    const { docId, chatBusy, version } = getState();
    if (!docId || chatBusy) return;
    const pending: ChatMessage = { role: "agent", text: "thinking…", pending: true };
    setState({ chatBusy: true, chat: [...getState().chat, { role: "user", text }, pending] });
    try {
      const reply = await runAgent(docId, text);
      // The agent mutated the document server-side, out from under this tab:
      // reconcile rebases the local copy and warm-resets the render.
      await getController()?.reconcile();
      const history = await fetchHistory(docId);
      const done: ChatMessage = {
        role: "agent", text: reply, fromVersion: version, toVersion: getState().version,
      };
      setState({ history, chat: [...getState().chat.slice(0, -1), done] });
    } catch (e) {
      setState({ chat: [...getState().chat.slice(0, -1), { role: "err", text: (e as Error).message }] });
    } finally {
      setState({ chatBusy: false });
    }
  };

  return (
    <section className="col-chat">
      <div className="col-head">
        <strong>Chat</strong>
        <button type="button" className="ops-counter" onClick={() => void openHistory()}>
          {`${sessionOps.length} ops · 本次会话`}
        </button>
        <span className="spacer" />
        <button type="button" className="chip" onClick={() => void newSession()}>新会话</button>
      </div>

      <div className="chat-log">
        {s.chat.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}${m.pending ? " msg-pending" : ""}`}>
            {m.role === "agent" && !m.pending ? (
              <div className="agent-head">
                <span className="agent-mark mono">ir</span>
                <span>Agent</span>
              </div>
            ) : null}
            <div>{m.text}</div>
            {m.fromVersion !== undefined && m.toVersion !== undefined ? (
              <OpsList
                defaultOpen
                entries={s.history.filter((e) => e.version > m.fromVersion! && e.version <= m.toVersion!)}
              />
            ) : null}
          </div>
        ))}
      </div>

      <Composer busy={s.chatBusy} onSend={(t) => void send(t)} />
      {s.historyOpen ? <HistoryDrawer /> : null}
    </section>
  );
}
```

- [ ] **Step 2b: 实现 `src/ui/panels/composer.tsx`**

```tsx
import { useState } from "react";
import { selectedLayers, useUiState } from "../store.js";

export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const s = useUiState();
  const [text, setText] = useState("");

  const submit = (): void => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };

  // Phase 1: "@layer" only injects TEXT into the instruction. Real structured
  // context (the selected IR subtree travelling with the request) needs the
  // /run contract widened — that is phase 2, foundation 6.
  const mention = (): void => {
    const names = selectedLayers(s).map((l) => `@${l.name}`).join(" ");
    if (names) setText((t) => (t ? `${t} ${names} ` : `${names} `));
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="说明要改什么，或先在画布上框出问题区域…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="composer-actions">
          <button type="button" className="chip" onClick={mention}>@ 图层</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 加样式**

```css
.chat-log { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 14px 4px;
  display: flex; flex-direction: column; gap: 14px; }
.msg { max-width: 90%; padding: 9px 11px; line-height: 1.55; border-radius: 10px; }
.msg-user { align-self: flex-end; background: #eef0ec; border: 1px solid #e2e4de; border-radius: 10px 10px 3px 10px; }
.msg-agent { align-self: flex-start; background: #fff; border: 1px solid var(--border); border-radius: 10px 10px 10px 3px; }
.msg-err { align-self: flex-start; background: #fdf1f0; border: 1px solid #e9c6c2; color: #96322a; }
.msg-pending { opacity: .6; font-style: italic; }
.agent-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.agent-mark {
  width: 18px; height: 18px; border-radius: var(--radius); background: var(--accent);
  color: #fff; display: grid; place-items: center; font-size: 9px;
}
.composer { flex: none; border-top: 1px solid var(--border); padding: 10px 12px 12px; }
.composer-box { border: 1px solid var(--border-strong); border-radius: 9px; background: #fff; padding: 8px 9px; }
.composer textarea {
  width: 100%; min-height: 40px; border: 0; outline: none; resize: none;
  font: inherit; color: inherit; background: transparent;
}
.composer-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.chip {
  font-family: var(--mono); font-size: 11px; color: var(--fg-3);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 2px 8px; background: transparent; cursor: pointer;
}
.ops-counter { border: 0; background: transparent; font: inherit; font-family: var(--mono);
  font-size: 10.5px; color: var(--fg-3); cursor: pointer; }
```

- [ ] **Step 4: 挂进 `app.tsx`**

左栏整块换成 `<ChatPanel />`。

- [ ] **Step 5: 跑测试 + 手动冒烟**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

Run: `pnpm dev psd` —— 发一条指令；点 `N ops · 本次会话` 打开历史抽屉；点「回退这 N 步」后画布与图层树同步回退；点「新会话」清空对话

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/ui/panels/chat-panel.tsx packages/web-psd/src/ui/panels/composer.tsx \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/chat.test.tsx
git commit -m "feat(web-psd): rebuild the chat column with inline op lists and session reset"
```

---

### Task 17: IR 徽标与降级面板（A3 A4 B6 收口）

**Files:**
- Modify: `packages/web-psd/src/ui/panels/top-bar.tsx`, `src/ui/styles.css`
- Test: `packages/web-psd/tests/degradations.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `layer.degraded`；Task 5 的 `collectDegradations` / `countLayers`
- Produces: 顶栏两个徽标

- **A3 IR 徽标**：`v{version} · {countLayers} 图层`。设计稿写的是 `IR v3`，那是 IR schema 版本号——**这个概念在后端不存在**，用真实的文档 `version` 代替，不要编一个。
- **A4 降级徽标**：`{n} 项降级 ›`，`n === 0` 时整个徽标不渲染；点击展开一个浮层，逐条列出 `collectDegradations` 的 `layerName · reason · detail`，点某条把该图层选中并切到「属性」页。

- [ ] **Step 1: 写失败的测试**

创建 `packages/web-psd/tests/degradations.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({ setZoom: vi.fn() }), openFile: vi.fn(), exportUrl: () => null,
}));

const layer = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

beforeEach(() => {
  setState({ docName: "a.psd", zoom: 1, version: 7, pane: "layers", selection: [],
    doc: { canvas: { width: 4, height: 4 }, layers: [
      layer("g", { type: "group", children: [layer("b")] }),
      layer("t", { type: "text", name: "headline",
                   degraded: [{ reason: "文字层已栅格化", detail: "本期不支持编辑文字" }] }),
    ] } });
});

describe("top bar badges", () => {
  it("shows the real document version and a recursive layer count", () => {
    render(<TopBar />);
    expect(screen.getByText("v7 · 3 图层")).toBeInTheDocument();
  });

  it("counts degradations and reveals them on click", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByText("1 项降级 ›"));
    expect(screen.getByText("文字层已栅格化")).toBeInTheDocument();
    expect(screen.getByText("本期不支持编辑文字")).toBeInTheDocument();
  });

  it("jumps to the offending layer's properties", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByText("1 项降级 ›"));
    fireEvent.click(screen.getByText("headline"));
    expect(getState().selection).toEqual(["t"]);
    expect(getState().pane).toBe("props");
  });

  it("hides the badge when nothing was degraded", () => {
    setState({ doc: { canvas: { width: 4, height: 4 }, layers: [layer("a")] } });
    render(<TopBar />);
    expect(screen.queryByText(/项降级/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/web-psd test tests/degradations.test.tsx`
Expected: FAIL，找不到 `v7 · 3 图层`

- [ ] **Step 3: 在 `top-bar.tsx` 里加两个徽标**

在文件名之后插入：

```tsx
      {s.doc ? <span className="tag-ok mono">{`v${s.version} · ${countLayers(s.doc.layers)} 图层`}</span> : null}
      {degradations.length > 0 ? (
        <div className="degrade">
          <button type="button" className="tag-warn mono"
                  onClick={() => setState({ degradeOpen: !s.degradeOpen })}>
            {`${degradations.length} 项降级 ›`}
          </button>
          {s.degradeOpen ? (
            <div className="degrade-pop">
              {degradations.map((d, i) => (
                <button key={`${d.layerId}-${i}`} type="button" className="degrade-row"
                        onClick={() => setState({ selection: [d.layerId], pane: "props", degradeOpen: false })}>
                  <strong>{d.layerName}</strong>
                  <span>{d.reason}</span>
                  {d.detail ? <em>{d.detail}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
```

组件顶部加：

```tsx
  const degradations = s.doc ? collectDegradations(s.doc.layers) : [];
```

并 import `collectDegradations` / `countLayers`。

- [ ] **Step 4: 加样式**

```css
.degrade { position: relative; }
.degrade > button { cursor: pointer; }
.degrade-pop {
  position: absolute; top: 26px; left: 0; z-index: 5; width: 320px;
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid var(--border); border-left: 3px solid var(--warn);
  border-radius: 8px; box-shadow: 0 4px 14px #00000014; padding: 4px;
}
.degrade-row {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  padding: 7px 8px; border: 0; border-radius: 6px; background: transparent;
  font: inherit; text-align: left; cursor: pointer;
}
.degrade-row:hover { background: #f6f4f0; }
.degrade-row span { color: var(--warn-ink); font-size: 11.5px; }
.degrade-row em { color: var(--fg-3); font-size: 11px; font-style: normal; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/ui/panels/top-bar.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/degradations.test.tsx
git commit -m "feat(web-psd): surface document version and import degradations in the top bar"
```

---

### Task 18: `/history` + `/rollback` 的跨 worker 集成断言

**Files:**
- Modify: `tests/integration/cloudflare/local-runtime.test.mjs`

**Interfaces:**
- Consumes: 无（直接打网关 HTTP）
- Produces: 无

Task 15 的 `api.test.ts` 只用 mock 过的 `fetch` 钉住了请求形状；这一条把整条链路真的跑一遍——网关路由、doc-type worker、Editor DO 的 delta 日志与回滚。用 `markdown` 而不是 `psd`：这个 runtime 只启了 markdown 与 docx，而被验证的历史/回滚语义在 `cloudflare-sdk` 里是所有文档类型共用的。

**已核实的线上形状：** `POST …/apply` 的 body 是 `{ operations, description, baseVersion }`；`GET …/history` 返回 `{ success, data: HistoryEntry[], version }`；`POST …/rollback` 的 body 是 `{ version }`，且**回滚会让版本号前进**（追加一条合成 delta），不是倒退。

- [ ] **Step 1: 追加测试**

在 `tests/integration/cloudflare/local-runtime.test.mjs` 末尾加：

```js
test("history records each delta and rollback moves the version forward", async () => {
  const base = `${runtime.urls.gateway}/tenants/alice/docs/markdown`;
  const create = await fetch(`${base}/`, { method: "POST" });
  const { docId } = await create.json();

  const apply = async (heading, baseVersion) => {
    const res = await fetch(`${base}/${docId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [{ kind: "appendSection", payload: { heading, content: "x" } }],
        description: `add ${heading}`,
        baseVersion,
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
    return body.version;
  };

  const v1 = await apply("one", 0);
  const v2 = await apply("two", v1);

  const history = await fetch(`${base}/${docId}/history`);
  expect(history.ok).toBe(true);
  const listed = await history.json();
  expect(listed.success).toBe(true);
  expect(listed.data.map((e) => e.description)).toEqual(
    expect.arrayContaining(["add one", "add two"]),
  );

  const back = await fetch(`${base}/${docId}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: v1 }),
  });
  expect(back.ok).toBe(true);
  const rolled = await back.json();
  expect(rolled.success).toBe(true);
  // Rollback appends a synthetic delta rather than rewinding the counter.
  expect(rolled.version).toBeGreaterThan(v2);

  const after = await fetch(`${base}/${docId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  const content = await after.json();
  expect(JSON.stringify(content)).toContain("one");
  expect(JSON.stringify(content)).not.toContain("two");
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm exec vitest run tests/integration/cloudflare/local-runtime.test.mjs`
Expected: PASS。首次运行会启动整套 Miniflare 拓扑，约 30–60 秒。

> 若 `getContent` 的返回结构与断言不符，先跑一次把 `content` 打印出来，按实际的 `QueryValue` 形状调整最后两条断言——**不要**改 `apply` / `history` / `rollback` 那几条，它们才是本任务要钉的契约。

- [ ] **Step 3: 提交**

```bash
git add tests/integration/cloudflare/local-runtime.test.mjs
git commit -m "test(integration): pin the history and rollback round trip through the gateway"
```

---

### Task 19: 收尾与全量验证

**Files:**
- Delete: `packages/web-psd/src/main.ts`
- Modify: `README.md`（若其中描述了 web-psd 的旧两栏结构）

- [ ] **Step 1: 删掉旧入口并确认无引用**

```bash
git rm packages/web-psd/src/main.ts
grep -rn "src/main.ts" --include="*.html" --include="*.ts" --include="*.tsx" --include="*.mjs" \
  packages stacks scripts | grep -v node_modules
```
Expected: 只剩 `packages/web-psd/index.html` 指向 `/src/ui/main.tsx`，没有任何一处仍指向 `src/main.ts`

- [ ] **Step 2: 全仓类型检查与测试**

```bash
pnpm typecheck
pnpm test
pnpm --filter @unidocs/web-psd build
```
Expected: 全部通过；`build` 产出 `packages/web-psd/dist`，且 `dist/assets` 中包含 18 个 woff2

- [ ] **Step 3: 性能回归对比**

Run: `pnpm dev psd`，打开浏览器，对照 Task 6 提交信息里记录的基线：

Expected:
- `[psd-perf] init: workerInit=…ms firstPaint=…ms` 与基线在同一量级（±30% 以内）
- 拖动不透明度滑块时 `[psd-perf] toggle set_props/…` 的 `totalMs` 与基线相当
- 若 `firstPaint` 明显劣化，第一嫌疑是 `<canvas>` 被卷入了 React 的重渲染 —— 检查 `canvas-stage.tsx` 里 canvas 是否仍只由 ref 挂载、且没有依赖 `useUiState`

- [ ] **Step 4: 逐项走查第一期的 30 个功能**

按设计文档 §2 的表格逐个点一遍，确认都在：A1 A2 A3 A4 A5 A6 · B1 B2 B3 B4 B6 B7 B8 B10 B12 · C1 C2 C3 C4 C5 C8 · D1 D3 D4 D5 D6 D11 · E1 E2 E3

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(web-psd): drop the legacy entry point and finish the phase-1 redesign"
```

---

## 第一期明确不做（第二期）

`B5` 可变字段标记 · `B9` 旋转 · `B11` Agent 标记 · `C6` 圈选批注 · `C7` 文字工具 ·
`C9` Agent 结构化上下文 · `C10` 批注气泡 · `D2` ReAct 轨迹 · `D7` recipe ·
`D8` 变体批量生成 · `D9` 上下文 chips · `D10` 圈选/附图按钮 · 真 diff（`−` 旧值）· 深色模式
