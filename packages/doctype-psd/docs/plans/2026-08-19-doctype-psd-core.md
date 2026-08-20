# doctype-psd Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cloud-neutral editing core of the PSD document type — model, the 9 operations (pure `apply`), PSD `load`/`save` via ag-psd, and the assembled `DocumentType` — all testable in Node with no Workers/canvas/wasm.

**Architecture:** A `DocumentType<PsdDoc, PsdQuery, PsdOp>` for UniDocs. Runtime state is the in-memory `PsdDoc` (PSD-aligned). Operations are `{kind, payload}`; `apply(ops, doc)` is a pure deterministic reducer (clone-then-mutate). PSD bytes bridge via ag-psd using a pure-JS canvas shim (no node-canvas). Rendering (canvaskit) is a SEPARATE later plan — this plan implements everything that does not need it.

**Tech Stack:** TypeScript (ESM), ag-psd ^31, vitest, Node ≥24.

**Spec:** `packages/doctype-psd/docs/design.md` (v0.3)

## Global Constraints

- Runtime: Node ≥ 24, pnpm ≥ 11. Package is ESM (`"type": "module"`); **relative imports use the `.js` extension** (e.g. `import { findLayer } from "./tree.js"`).
- Dependency: **ag-psd `^31`** (installed 31.0.2). Fix `package.json` (currently `^28`) as part of Task 7.
- **8-bit RGB only.** `load` must reject any other colorMode/bit-depth with a clear error (design §6, import strategy B).
- **Import strategy B:** `readPsd(bytes, { useImageData: true, skipThumbnail: true, logMissingFeatures: true, throwForMissingFeatures: false })`. Unknown blocks are dropped (design §6.1).
- **No real canvas:** call `initializeCanvas` once with a pure-JS `createImageData` returning `{ width, height, data: new Uint8ClampedArray(width*height*4) }` (validated — see `tests/fixtures/generate.mjs`).
- **Op invariants (design §5.2):** ids are caller-assigned (never generate ids/UUIDs in `apply`); pixels are pre-resolved in the payload; `apply` is pure & deterministic — no RNG, no clock, no network, no model calls.
- **`apply` purity mechanism:** clone the doc once at the top of `applyOp`, then mutate the clone. Use `structuredClone` (preserves `Uint8ClampedArray`).
- **blendMode** values are the readable names in design §4 (`normal`, `multiply`, `screen`, …).
- Coordinates: `bounds` is always `[top, left, bottom, right]` in canvas space.
- Test runner: `vitest run`. Run from the package dir `packages/doctype-psd`.

---

## File Structure

```
packages/doctype-psd/src/
├── model/
│   ├── types.ts        PsdDoc, Canvas, Layer, Mask, Pixels, BlendMode
│   └── tree.ts         findLayer / findParentList / removeById / insertAt / isDescendant
├── ops/
│   ├── layer-ops.ts    add_layer, remove_layer, reorder, set_props
│   ├── geometry-ops.ts crop, transform
│   ├── adjust-ops.ts   adjust
│   ├── mask-ops.ts     mask_edit
│   ├── generative-ops.ts generative_fill
│   └── index.ts        applyOp dispatcher + apply()
├── psd/
│   ├── canvas-shim.ts  initializeCanvas pure-JS shim
│   ├── load.ts         load(bytes) -> PsdDoc   (ag-psd readPsd + map)
│   └── save.ts         save(doc) -> Uint8Array  (map + ag-psd writePsd)
├── queries.ts          runQuery: getLayers  (getPreview deferred to render plan)
├── tools.ts            tool definitions + instructions
└── doctype.ts          createPsdDocumentType (replaces current stub)

packages/doctype-psd/tests/
├── fixtures/sample.psd (exists)  + generate.mjs (exists)
├── ops.test.ts
├── psd-roundtrip.test.ts
└── doctype.test.ts
```

Each `ops/*.ts` file exports pure functions `(doc: PsdDoc, payload) => void` that mutate the already-cloned doc. `ops/index.ts` owns cloning.

---

### Task 1: Model types + layer-tree helpers

**Files:**
- Create: `packages/doctype-psd/src/model/types.ts`
- Create: `packages/doctype-psd/src/model/tree.ts`
- Test: `packages/doctype-psd/tests/tree.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `PsdDoc`, `Canvas`, `Layer`, `Mask`, `Pixels`, `BlendMode`, `LayerType`.
  - `tree.ts`:
    - `findLayer(layers: Layer[], id: string): Layer | undefined`
    - `findParentList(layers: Layer[], id: string): { list: Layer[]; index: number } | undefined` — the array containing the layer + its index.
    - `removeById(layers: Layer[], id: string): Layer | undefined` — removes in place, returns removed.
    - `insertAt(list: Layer[], layer: Layer, index?: number): void` — index omitted ⇒ push (top).
    - `isDescendant(root: Layer, id: string): boolean` — is `id` inside root's subtree.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tree.test.ts
import { describe, it, expect } from "vitest";
import type { Layer } from "../src/model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../src/model/tree.js";

function leaf(id: string): Layer {
  return { id, type: "raster", name: id, bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false };
}

describe("tree helpers", () => {
  it("finds nested layer and its parent list", () => {
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("a"), leaf("b")] };
    const layers = [leaf("root0"), g];
    expect(findLayer(layers, "b")?.id).toBe("b");
    const p = findParentList(layers, "b")!;
    expect(p.list).toBe(g.children);
    expect(p.index).toBe(1);
  });

  it("removes by id and reports descendants", () => {
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("a")] };
    const layers = [g];
    expect(isDescendant(g, "a")).toBe(true);
    expect(isDescendant(g, "zzz")).toBe(false);
    expect(removeById(layers, "a")?.id).toBe("a");
    expect(g.children).toHaveLength(0);
  });

  it("insertAt pushes when index omitted", () => {
    const list = [leaf("a")];
    insertAt(list, leaf("b"));
    expect(list.map((l) => l.id)).toEqual(["a", "b"]);
    insertAt(list, leaf("c"), 0);
    expect(list.map((l) => l.id)).toEqual(["c", "a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/tree.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `model/types.ts`**

```ts
export type BlendMode =
  | "normal" | "dissolve" | "darken" | "multiply" | "color-burn" | "linear-burn"
  | "lighten" | "screen" | "color-dodge" | "linear-dodge" | "overlay"
  | "soft-light" | "hard-light" | "vivid-light" | "linear-light"
  | "difference" | "exclusion" | "subtract" | "divide"
  | "hue" | "saturation" | "color" | "luminosity" | "pass-through";

export type LayerType = "raster" | "adjustment" | "fill" | "text" | "smartObject" | "group";

/** RGBA pixel buffer, 8-bit, length = width*height*4. */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray; }

export interface Mask {
  pixels: Pixels;
  bounds: [number, number, number, number]; // [top,left,bottom,right]
  defaultColor: 0 | 255;
  inverted: boolean;
}

export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  bounds: [number, number, number, number]; // [top,left,bottom,right]
  opacity: number; // 0..1
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
  clipping: boolean;
  pixels?: Pixels;                       // raster
  mask?: Mask | null;
  adjustType?: string;                   // adjustment (PSD key: brit/levl/curv/hue2/…)
  params?: Record<string, unknown>;      // adjustment params
  provenance?: { model: string; seed: number; prompt: string };
  children?: Layer[];                    // group
}

export interface Canvas {
  width: number;
  height: number;
  colorMode: "RGB";
  depth: 8;
  resolution: number;
  profile: string;
}

export interface PsdDoc { canvas: Canvas; layers: Layer[]; }
```

- [ ] **Step 4: Write `model/tree.ts`**

```ts
import type { Layer } from "./types.js";

export function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function findParentList(layers: Layer[], id: string): { list: Layer[]; index: number } | undefined {
  const i = layers.findIndex((l) => l.id === id);
  if (i !== -1) return { list: layers, index: i };
  for (const l of layers) {
    if (l.children) {
      const found = findParentList(l.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function removeById(layers: Layer[], id: string): Layer | undefined {
  const p = findParentList(layers, id);
  if (!p) return undefined;
  return p.list.splice(p.index, 1)[0];
}

export function insertAt(list: Layer[], layer: Layer, index?: number): void {
  if (index === undefined || index >= list.length) list.push(layer);
  else list.splice(Math.max(0, index), 0, layer);
}

export function isDescendant(root: Layer, id: string): boolean {
  if (!root.children) return false;
  return root.children.some((c) => c.id === id || isDescendant(c, id));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/tree.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/doctype-psd/src/model packages/doctype-psd/tests/tree.test.ts
git commit -m "feat(doctype-psd): model types + layer-tree helpers"
```

---

### Task 2: Layer ops — add_layer, remove_layer, reorder, set_props

**Files:**
- Create: `packages/doctype-psd/src/ops/layer-ops.ts`
- Test: `packages/doctype-psd/tests/layer-ops.test.ts`

**Interfaces:**
- Consumes: `tree.ts` helpers, `types.ts`.
- Produces (each mutates the passed doc, throws on invalid input):
  - `addLayer(doc, p: { layer: Layer; parentId: string | null; index?: number }): void`
  - `removeLayer(doc, p: { layerId: string }): void`
  - `reorder(doc, p: { layerId: string; parentId: string | null; index?: number }): void`
  - `setProps(doc, p: { layerId: string; props: Partial<Pick<Layer,"name"|"opacity"|"blendMode"|"visible"|"locked"|"clipping">> }): void`
  - `SETTABLE_PROPS: readonly string[]` = `["name","opacity","blendMode","visible","locked","clipping"]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/layer-ops.test.ts
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { addLayer, removeLayer, reorder, setProps } from "../src/ops/layer-ops.js";
import { findLayer, findParentList } from "../src/model/tree.js";

const leaf = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false });
const doc = (): PsdDoc => ({ canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [leaf("a")] });

describe("layer ops", () => {
  it("add_layer inserts at root end and at index", () => {
    const d = doc();
    addLayer(d, { layer: leaf("b"), parentId: null });
    expect(d.layers.map(l => l.id)).toEqual(["a", "b"]);
    addLayer(d, { layer: leaf("c"), parentId: null, index: 0 });
    expect(d.layers.map(l => l.id)).toEqual(["c", "a", "b"]);
  });

  it("add_layer rejects duplicate id", () => {
    const d = doc();
    expect(() => addLayer(d, { layer: leaf("a"), parentId: null })).toThrow(/exists/);
  });

  it("add_layer into a group", () => {
    const d = doc();
    const g: Layer = { ...leaf("g"), type: "group", children: [] };
    addLayer(d, { layer: g, parentId: null });
    addLayer(d, { layer: leaf("x"), parentId: "g" });
    expect(findParentList(d.layers, "x")!.list).toBe((findLayer(d.layers, "g") as Layer).children);
  });

  it("remove_layer removes; missing throws", () => {
    const d = doc();
    removeLayer(d, { layerId: "a" });
    expect(d.layers).toHaveLength(0);
    expect(() => removeLayer(d, { layerId: "nope" })).toThrow(/not found/);
  });

  it("reorder moves across parents; rejects cycle", () => {
    const d = doc();
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("child")] };
    addLayer(d, { layer: g, parentId: null });
    reorder(d, { layerId: "a", parentId: "g", index: 0 });
    expect((findLayer(d.layers, "g") as Layer).children!.map(l => l.id)).toEqual(["a", "child"]);
    expect(() => reorder(d, { layerId: "g", parentId: "child", index: 0 })).toThrow(/cycle/);
  });

  it("set_props merges allowed; rejects immutable + bad values", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { opacity: 0.5, blendMode: "multiply", visible: false } });
    const a = findLayer(d.layers, "a")!;
    expect(a.opacity).toBe(0.5);
    expect(a.blendMode).toBe("multiply");
    expect(() => setProps(d, { layerId: "a", props: { id: "z" } as any })).toThrow(/immutable|unknown/);
    expect(() => setProps(d, { layerId: "a", props: { opacity: 5 } })).toThrow(/opacity/);
    expect(() => setProps(d, { layerId: "a", props: { blendMode: "bogus" as any } })).toThrow(/blendMode/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/layer-ops.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `ops/layer-ops.ts`**

```ts
import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../model/tree.js";

const BLEND_MODES: BlendMode[] = [
  "normal","dissolve","darken","multiply","color-burn","linear-burn","lighten","screen",
  "color-dodge","linear-dodge","overlay","soft-light","hard-light","vivid-light","linear-light",
  "difference","exclusion","subtract","divide","hue","saturation","color","luminosity","pass-through",
];

export const SETTABLE_PROPS = ["name","opacity","blendMode","visible","locked","clipping"] as const;

function targetList(doc: PsdDoc, parentId: string | null): Layer[] {
  if (parentId === null) return doc.layers;
  const parent = findLayer(doc.layers, parentId);
  if (!parent) throw new Error(`parent not found: ${parentId}`);
  if (parent.type !== "group") throw new Error(`parent is not a group: ${parentId}`);
  parent.children ??= [];
  return parent.children;
}

export function addLayer(doc: PsdDoc, p: { layer: Layer; parentId: string | null; index?: number }): void {
  if (findLayer(doc.layers, p.layer.id)) throw new Error(`layer id already exists: ${p.layer.id}`);
  insertAt(targetList(doc, p.parentId), p.layer, p.index);
}

export function removeLayer(doc: PsdDoc, p: { layerId: string }): void {
  if (!removeById(doc.layers, p.layerId)) throw new Error(`layer not found: ${p.layerId}`);
}

export function reorder(doc: PsdDoc, p: { layerId: string; parentId: string | null; index?: number }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if (p.parentId !== null) {
    if (p.parentId === p.layerId || isDescendant(layer, p.parentId)) {
      throw new Error(`reorder would create a cycle: ${p.layerId} into ${p.parentId}`);
    }
  }
  removeById(doc.layers, p.layerId);
  insertAt(targetList(doc, p.parentId), layer, p.index);
}

export function setProps(
  doc: PsdDoc,
  p: { layerId: string; props: Record<string, unknown> },
): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  for (const [k, v] of Object.entries(p.props)) {
    if (!SETTABLE_PROPS.includes(k as any)) throw new Error(`immutable or unknown prop: ${k}`);
    if (k === "opacity" && (typeof v !== "number" || v < 0 || v > 1)) throw new Error(`opacity out of range: ${String(v)}`);
    if (k === "blendMode" && !BLEND_MODES.includes(v as BlendMode)) throw new Error(`invalid blendMode: ${String(v)}`);
    (layer as any)[k] = v;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/layer-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/ops/layer-ops.ts packages/doctype-psd/tests/layer-ops.test.ts
git commit -m "feat(doctype-psd): layer ops (add/remove/reorder/set_props)"
```

---

### Task 3: Geometry ops — crop, transform

**Files:**
- Create: `packages/doctype-psd/src/ops/geometry-ops.ts`
- Test: `packages/doctype-psd/tests/geometry-ops.test.ts`

**Interfaces:**
- Consumes: `types.ts`, `tree.ts`.
- Produces:
  - `crop(doc, p: { rect: [number,number,number,number] }): void` — sets canvas w/h, shifts every layer/mask `bounds` by `-left,-top`. No pixel resample.
  - `transform(doc, p: { layerId: string; op: { translate?: [number,number]; flip?: "h" | "v" } }): void` — MVP lossless only; `scale`/`rotate` in payload ⇒ throw `not supported in MVP`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/geometry-ops.test.ts
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { crop, transform } from "../src/ops/geometry-ops.js";
import { findLayer } from "../src/model/tree.js";

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w*h*4) });
const layer = (id: string, bounds: [number,number,number,number]): Layer => ({ id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: px(bounds[3]-bounds[1], bounds[2]-bounds[0]) });
const doc = (): PsdDoc => ({ canvas: { width: 100, height: 100, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [layer("a", [10,10,30,30])] });

describe("geometry ops", () => {
  it("crop resizes canvas and shifts bounds", () => {
    const d = doc();
    crop(d, { rect: [5, 5, 55, 55] }); // top,left,bottom,right
    expect([d.canvas.width, d.canvas.height]).toEqual([50, 50]);
    expect(findLayer(d.layers, "a")!.bounds).toEqual([5, 5, 25, 25]);
  });

  it("transform translate shifts bounds only", () => {
    const d = doc();
    transform(d, { layerId: "a", op: { translate: [4, 3] } });
    expect(findLayer(d.layers, "a")!.bounds).toEqual([13, 14, 33, 34]); // top+3,left+4,bottom+3,right+4
  });

  it("transform rejects scale/rotate in MVP", () => {
    const d = doc();
    expect(() => transform(d, { layerId: "a", op: { scale: [2, 2] } as any })).toThrow(/not supported/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/geometry-ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `ops/geometry-ops.ts`**

```ts
import type { PsdDoc, Layer } from "../model/types.js";
import { findLayer } from "../model/tree.js";

function shiftBounds(b: [number, number, number, number], dx: number, dy: number): [number, number, number, number] {
  return [b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx];
}

function shiftLayer(l: Layer, dx: number, dy: number): void {
  l.bounds = shiftBounds(l.bounds, dx, dy);
  if (l.mask) l.mask.bounds = shiftBounds(l.mask.bounds, dx, dy);
  if (l.children) for (const c of l.children) shiftLayer(c, dx, dy);
}

export function crop(doc: PsdDoc, p: { rect: [number, number, number, number] }): void {
  const [top, left, bottom, right] = p.rect;
  doc.canvas.width = right - left;
  doc.canvas.height = bottom - top;
  for (const l of doc.layers) shiftLayer(l, -left, -top);
}

export function transform(doc: PsdDoc, p: { layerId: string; op: Record<string, unknown> }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if ("scale" in p.op || "rotate" in p.op) {
    throw new Error("transform scale/rotate not supported in MVP (needs deterministic resampler)");
  }
  const t = p.op.translate as [number, number] | undefined;
  if (t) shiftLayer(layer, t[0], t[1]);
  const flip = p.op.flip as "h" | "v" | undefined;
  if (flip && layer.pixels) flipPixels(layer.pixels, flip);
}

function flipPixels(px: { width: number; height: number; data: Uint8ClampedArray }, dir: "h" | "v"): void {
  const { width: w, height: h, data } = px;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = dir === "h" ? w - 1 - x : x;
      const sy = dir === "v" ? h - 1 - y : y;
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = data[s]; out[d+1] = data[s+1]; out[d+2] = data[s+2]; out[d+3] = data[s+3];
    }
  }
  data.set(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/geometry-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/ops/geometry-ops.ts packages/doctype-psd/tests/geometry-ops.test.ts
git commit -m "feat(doctype-psd): geometry ops (crop, transform translate/flip)"
```

---

### Task 4: Adjust + mask ops

**Files:**
- Create: `packages/doctype-psd/src/ops/adjust-ops.ts`
- Create: `packages/doctype-psd/src/ops/mask-ops.ts`
- Test: `packages/doctype-psd/tests/adjust-mask-ops.test.ts`

**Interfaces:**
- Produces:
  - `adjust(doc, p: { layerId: string; params: Record<string, unknown> }): void` — merges params into an existing `type === "adjustment"` layer; throws otherwise.
  - `maskEdit(doc, p: { layerId: string; mask: Mask | null }): void` — sets/replaces/removes the layer's mask.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adjust-mask-ops.test.ts
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer, Mask } from "../src/model/types.js";
import { adjust } from "../src/ops/adjust-ops.js";
import { maskEdit } from "../src/ops/mask-ops.js";
import { findLayer } from "../src/model/tree.js";

const base = { bounds: [0,0,1,1] as [number,number,number,number], opacity: 1, blendMode: "normal" as const, visible: true, locked: false, clipping: false };
const doc = (): PsdDoc => ({
  canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [
    { id: "r", type: "raster", name: "r", ...base },
    { id: "adj", type: "adjustment", name: "adj", adjustType: "brit", params: { brightness: 0 }, ...base },
  ],
});
const mask = (): Mask => ({ pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, bounds: [0,0,1,1], defaultColor: 0, inverted: false });

describe("adjust + mask ops", () => {
  it("adjust merges params on adjustment layer", () => {
    const d = doc();
    adjust(d, { layerId: "adj", params: { brightness: 0.2, contrast: 0.1 } });
    expect(findLayer(d.layers, "adj")!.params).toEqual({ brightness: 0.2, contrast: 0.1 });
  });

  it("adjust rejects non-adjustment layer", () => {
    const d = doc();
    expect(() => adjust(d, { layerId: "r", params: {} })).toThrow(/adjustment/);
  });

  it("mask_edit sets then removes a mask", () => {
    const d = doc();
    maskEdit(d, { layerId: "r", mask: mask() });
    expect(findLayer(d.layers, "r")!.mask).not.toBeNull();
    maskEdit(d, { layerId: "r", mask: null });
    expect(findLayer(d.layers, "r")!.mask).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/adjust-mask-ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `ops/adjust-ops.ts` and `ops/mask-ops.ts`**

```ts
// ops/adjust-ops.ts
import type { PsdDoc } from "../model/types.js";
import { findLayer } from "../model/tree.js";

export function adjust(doc: PsdDoc, p: { layerId: string; params: Record<string, unknown> }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if (layer.type !== "adjustment") throw new Error(`not an adjustment layer: ${p.layerId}`);
  layer.params = { ...(layer.params ?? {}), ...p.params };
}
```

```ts
// ops/mask-ops.ts
import type { PsdDoc, Mask } from "../model/types.js";
import { findLayer } from "../model/tree.js";

export function maskEdit(doc: PsdDoc, p: { layerId: string; mask: Mask | null }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  layer.mask = p.mask;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/adjust-mask-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/ops/adjust-ops.ts packages/doctype-psd/src/ops/mask-ops.ts packages/doctype-psd/tests/adjust-mask-ops.test.ts
git commit -m "feat(doctype-psd): adjust + mask_edit ops"
```

---

### Task 5: Generative fill op

**Files:**
- Create: `packages/doctype-psd/src/ops/generative-ops.ts`
- Test: `packages/doctype-psd/tests/generative-ops.test.ts`

**Interfaces:**
- Consumes: `addLayer` from `layer-ops.ts`.
- Produces:
  - `generativeFill(doc, p: { layer: Layer; parentId: string | null; index?: number; provenance: { model: string; seed: number; prompt: string } }): void` — inserts the pre-generated raster layer (via addLayer) and attaches `provenance` to it. Throws if `layer.pixels` is missing (result must be pre-resolved).

- [ ] **Step 1: Write the failing test**

```ts
// tests/generative-ops.test.ts
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { generativeFill } from "../src/ops/generative-ops.js";
import { findLayer } from "../src/model/tree.js";

const doc = (): PsdDoc => ({ canvas: { width: 8, height: 8, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [] });
const result = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,8,8], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 8, height: 8, data: new Uint8ClampedArray(8*8*4) } });

describe("generative_fill", () => {
  it("inserts pre-generated layer + provenance", () => {
    const d = doc();
    generativeFill(d, { layer: result("g1"), parentId: null, provenance: { model: "sdxl@1", seed: 42, prompt: "remove car" } });
    const g = findLayer(d.layers, "g1")!;
    expect(g.provenance).toEqual({ model: "sdxl@1", seed: 42, prompt: "remove car" });
  });

  it("rejects a layer with no pixels (must be pre-resolved)", () => {
    const d = doc();
    const noPix = { ...result("g2"), pixels: undefined } as Layer;
    expect(() => generativeFill(d, { layer: noPix, parentId: null, provenance: { model: "m", seed: 1, prompt: "p" } })).toThrow(/pixels/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/generative-ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `ops/generative-ops.ts`**

```ts
import type { PsdDoc, Layer } from "../model/types.js";
import { addLayer } from "./layer-ops.js";

export function generativeFill(
  doc: PsdDoc,
  p: { layer: Layer; parentId: string | null; index?: number; provenance: { model: string; seed: number; prompt: string } },
): void {
  if (!p.layer.pixels) throw new Error("generative_fill: layer.pixels missing — result must be pre-resolved");
  const layer: Layer = { ...p.layer, provenance: p.provenance };
  addLayer(doc, { layer, parentId: p.parentId, index: p.index });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/generative-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/ops/generative-ops.ts packages/doctype-psd/tests/generative-ops.test.ts
git commit -m "feat(doctype-psd): generative_fill op"
```

---

### Task 6: applyOp dispatcher + pure apply()

**Files:**
- Create: `packages/doctype-psd/src/ops/index.ts`
- Test: `packages/doctype-psd/tests/apply.test.ts`

**Interfaces:**
- Consumes: every `ops/*` function.
- Produces:
  - `type PsdOp = { kind: string; payload: Record<string, unknown> }`
  - `applyOne(doc: PsdDoc, op: PsdOp): PsdDoc` — clones doc, dispatches by kind, returns new doc. Unknown kind throws.
  - `apply(operations: readonly PsdOp[], doc: PsdDoc): Promise<PsdDoc>` — folds `applyOne`; any throw propagates (platform rolls back the delta).

- [ ] **Step 1: Write the failing test**

```ts
// tests/apply.test.ts
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { apply, applyOne } from "../src/ops/index.js";

const leaf = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false });
const doc = (): PsdDoc => ({ canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [leaf("a")] });

describe("apply", () => {
  it("applyOne does not mutate the input doc (pure)", () => {
    const d = doc();
    const d2 = applyOne(d, { kind: "add_layer", payload: { layer: leaf("b"), parentId: null } });
    expect(d.layers.map(l => l.id)).toEqual(["a"]);       // input unchanged
    expect(d2.layers.map(l => l.id)).toEqual(["a", "b"]); // output has new layer
  });

  it("apply folds a batch and is deterministic on replay", async () => {
    const ops = [
      { kind: "add_layer", payload: { layer: leaf("b"), parentId: null } },
      { kind: "set_props", payload: { layerId: "b", props: { opacity: 0.3 } } },
    ];
    const r1 = await apply(ops, doc());
    const r2 = await apply(ops, doc());
    expect(JSON.stringify(r1.layers)).toBe(JSON.stringify(r2.layers));
    expect(r1.layers.find(l => l.id === "b")!.opacity).toBe(0.3);
  });

  it("unknown kind throws", () => {
    expect(() => applyOne(doc(), { kind: "nope", payload: {} })).toThrow(/unknown op/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/apply.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `ops/index.ts`**

```ts
import type { PsdDoc } from "../model/types.js";
import { addLayer, removeLayer, reorder, setProps } from "./layer-ops.js";
import { crop, transform } from "./geometry-ops.js";
import { adjust } from "./adjust-ops.js";
import { maskEdit } from "./mask-ops.js";
import { generativeFill } from "./generative-ops.js";

export type PsdOp = { kind: string; payload: Record<string, unknown> };

const HANDLERS: Record<string, (doc: PsdDoc, payload: any) => void> = {
  add_layer: addLayer,
  remove_layer: removeLayer,
  reorder,
  set_props: setProps,
  crop,
  transform,
  adjust,
  mask_edit: maskEdit,
  generative_fill: generativeFill,
};

export function applyOne(doc: PsdDoc, op: PsdOp): PsdDoc {
  const handler = HANDLERS[op.kind];
  if (!handler) throw new Error(`unknown op: ${op.kind}`);
  const next = structuredClone(doc);
  handler(next, op.payload);
  return next;
}

export async function apply(operations: readonly PsdOp[], doc: PsdDoc): Promise<PsdDoc> {
  let cur = doc;
  for (const op of operations) cur = applyOne(cur, op);
  return cur;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/ops/index.ts packages/doctype-psd/tests/apply.test.ts
git commit -m "feat(doctype-psd): applyOp dispatcher + pure apply()"
```

---

### Task 7: Canvas shim + load (ag-psd → PsdDoc)

**Files:**
- Create: `packages/doctype-psd/src/psd/canvas-shim.ts`
- Create: `packages/doctype-psd/src/psd/load.ts`
- Modify: `packages/doctype-psd/package.json` (ag-psd `^28` → `^31`)
- Test: `packages/doctype-psd/tests/psd-load.test.ts`

**Interfaces:**
- Produces:
  - `installCanvasShim(): void` — idempotent; calls ag-psd `initializeCanvas` with pure-JS `createImageData`.
  - `load(data: Uint8Array): Promise<PsdDoc>` — reads with strategy B, maps ag-psd layers → `Layer[]`, rejects non-8-bit / non-RGB.

- [ ] **Step 1: Verify ag-psd field names (no code yet)**

Run: `cd packages/doctype-psd && node -e "const p=require('ag-psd'); console.log(Object.keys(p))"`
Then open `node_modules/ag-psd/dist/psd.d.ts` and confirm the `Psd` and `Layer` field names used below: `width`, `height`, `bitsPerChannel`, `colorMode`, `children`, and on a layer: `name`, `opacity`, `blendMode`, `hidden`, `clipping`, `left`, `top`, `right`, `bottom`, `imageData`. Adjust the mapping in Step 4 if any differ.

- [ ] **Step 2: Write the failing test**

```ts
// tests/psd-load.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("load", () => {
  it("reads sample.psd into PsdDoc", async () => {
    const doc = await load(new Uint8Array(readFileSync(fixture)));
    expect(doc.canvas).toMatchObject({ width: 256, height: 256, colorMode: "RGB", depth: 8 });
    expect(doc.layers.map(l => l.name)).toEqual(["background", "red-box"]);
    const red = doc.layers.find(l => l.name === "red-box")!;
    expect(red.blendMode).toBe("multiply");
    expect(red.type).toBe("raster");
    expect(red.pixels?.width).toBe(128);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/psd-load.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `psd/canvas-shim.ts` and `psd/load.ts`; bump ag-psd**

```ts
// psd/canvas-shim.ts
import { initializeCanvas } from "ag-psd";

let installed = false;
export function installCanvasShim(): void {
  if (installed) return;
  initializeCanvas(
    () => { throw new Error("ag-psd createCanvas invoked — unexpected with useImageData reads"); },
    (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as any,
  );
  installed = true;
}
```

```ts
// psd/load.ts
import { readPsd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";

function mapLayer(a: AgLayer, i: number): Layer {
  const isGroup = Array.isArray(a.children);
  const px = a.imageData
    ? { width: a.imageData.width, height: a.imageData.height, data: a.imageData.data as Uint8ClampedArray }
    : undefined;
  return {
    id: `l${i}_${a.name ?? "layer"}`.replace(/\s+/g, "_"),
    type: isGroup ? "group" : "raster",
    name: a.name ?? "",
    bounds: [a.top ?? 0, a.left ?? 0, a.bottom ?? 0, a.right ?? 0],
    opacity: a.opacity ?? 1,
    blendMode: (a.blendMode ?? "normal") as BlendMode,
    visible: !a.hidden,
    locked: false,
    clipping: !!a.clipping,
    ...(px ? { pixels: px } : {}),
    ...(isGroup ? { children: (a.children ?? []).map(mapLayer) } : {}),
  };
}

export async function load(data: Uint8Array): Promise<PsdDoc> {
  installCanvasShim();
  const psd = readPsd(data, {
    useImageData: true,
    skipThumbnail: true,
    logMissingFeatures: true,
    throwForMissingFeatures: false,
  });
  if (psd.bitsPerChannel && psd.bitsPerChannel !== 8) {
    throw new Error(`unsupported bit depth: ${psd.bitsPerChannel} (only 8-bit RGB)`);
  }
  if (psd.colorMode !== undefined && psd.colorMode !== 3 /* RGB */) {
    throw new Error(`unsupported color mode: ${psd.colorMode} (only RGB)`);
  }
  return {
    canvas: { width: psd.width, height: psd.height, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: (psd.children ?? []).map(mapLayer),
  };
}
```

Also edit `packages/doctype-psd/package.json`: change `"ag-psd": "^28.0.0"` to `"ag-psd": "^31.0.0"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/psd-load.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/doctype-psd/src/psd/canvas-shim.ts packages/doctype-psd/src/psd/load.ts packages/doctype-psd/package.json packages/doctype-psd/tests/psd-load.test.ts
git commit -m "feat(doctype-psd): PSD load via ag-psd + pure-JS canvas shim"
```

---

### Task 8: save (PsdDoc → ag-psd bytes) + round-trip

**Files:**
- Create: `packages/doctype-psd/src/psd/save.ts`
- Test: `packages/doctype-psd/tests/psd-roundtrip.test.ts`

**Interfaces:**
- Consumes: `load` (Task 7), `types.ts`.
- Produces:
  - `save(doc: PsdDoc): Promise<Uint8Array>` — maps `PsdDoc` → ag-psd `Psd`, provides a composite `imageData` (top layer's pixels or a blank canvas) so writing needs no real canvas, returns bytes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/psd-roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";
import { save } from "../src/psd/save.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("save round-trip", () => {
  it("load → save → load preserves structure", async () => {
    const doc1 = await load(new Uint8Array(readFileSync(fixture)));
    const bytes = await save(doc1);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const doc2 = await load(bytes);
    expect(doc2.canvas).toMatchObject({ width: 256, height: 256 });
    expect(doc2.layers.map(l => l.name)).toEqual(doc1.layers.map(l => l.name));
    expect(doc2.layers.map(l => l.blendMode)).toEqual(doc1.layers.map(l => l.blendMode));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/psd-roundtrip.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `psd/save.ts`**

```ts
import { writePsd, type Psd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer } from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";

function mapLayer(l: Layer): AgLayer {
  const [top, left, bottom, right] = l.bounds;
  const out: AgLayer = {
    name: l.name,
    opacity: l.opacity,
    blendMode: l.blendMode as any,
    hidden: !l.visible,
    clipping: l.clipping,
    left, top, right, bottom,
  };
  if (l.children) out.children = l.children.map(mapLayer);
  else if (l.pixels) out.imageData = { width: l.pixels.width, height: l.pixels.height, data: l.pixels.data } as any;
  return out;
}

export async function save(doc: PsdDoc): Promise<Uint8Array> {
  installCanvasShim();
  const composite = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    data: new Uint8ClampedArray(doc.canvas.width * doc.canvas.height * 4),
  };
  const psd: Psd = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    children: doc.layers.map(mapLayer),
    imageData: composite as any,
  };
  const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
  return new Uint8Array(buffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/doctype-psd && npx vitest run tests/psd-roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/doctype-psd/src/psd/save.ts packages/doctype-psd/tests/psd-roundtrip.test.ts
git commit -m "feat(doctype-psd): PSD save + load/save round-trip"
```

---

### Task 9: Queries, tools, and DocumentType assembly

**Files:**
- Create: `packages/doctype-psd/src/queries.ts`
- Create: `packages/doctype-psd/src/tools.ts`
- Rewrite: `packages/doctype-psd/src/doctype.ts` (replace the stub)
- Modify: `packages/doctype-psd/src/index.ts` (export the real types)
- Test: `packages/doctype-psd/tests/doctype.test.ts`

**Interfaces:**
- Consumes: `apply` (Task 6), `load`/`save` (Tasks 7–8), `PsdDoc`/`PsdOp` types.
- Produces:
  - `runQuery(q: PsdQuery, doc: PsdDoc): Promise<QueryValue>` where `PsdQuery = { kind: "getLayers"; payload?: {} }` (getPreview intentionally deferred — throws "render not implemented yet").
  - `createPsdDocumentType(options?): DocumentType<PsdDoc, PsdQuery, PsdOp>`.
  - `tools`: `Record<string, AgentToolDefinition>` — one `apply_*` per op kind + `query_getLayers`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/doctype.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPsdDocumentType } from "../src/doctype.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("createPsdDocumentType", () => {
  const dt = createPsdDocumentType();

  it("init makes an empty doc", async () => {
    const d = await dt.init();
    expect(d.layers).toEqual([]);
    expect(d.canvas.colorMode).toBe("RGB");
  });

  it("load → apply → query flows through", async () => {
    const doc = await dt.load(new Uint8Array(readFileSync(fixture)));
    const doc2 = await dt.apply([{ kind: "set_props", payload: { layerId: doc.layers[1].id, props: { opacity: 0.5 } } }], doc);
    const layers = await dt.query({ kind: "getLayers" }, doc2) as any[];
    expect(layers.find(l => l.name === "red-box").opacity).toBe(0.5);
  });

  it("exposes apply_* and query_* tools + contentType", () => {
    expect(dt.contentType).toBe("image/vnd.adobe.photoshop");
    expect(dt.tools.add_layer.name).toBe("apply_add_layer");
    expect(dt.tools.getLayers.name).toBe("query_getLayers");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/doctype-psd && npx vitest run tests/doctype.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `queries.ts`, `tools.ts`, rewrite `doctype.ts`, update `index.ts`**

```ts
// queries.ts
import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue } from "@unidocs/core";

export type PsdQuery = { kind: "getLayers"; payload?: Record<string, never> } | { kind: "getPreview"; payload?: { scale?: number } };

function summarize(l: Layer): any {
  return {
    id: l.id, type: l.type, name: l.name, opacity: l.opacity, blendMode: l.blendMode,
    visible: l.visible, bounds: l.bounds,
    ...(l.children ? { children: l.children.map(summarize) } : {}),
  };
}

export async function runQuery(q: PsdQuery, doc: PsdDoc): Promise<QueryValue> {
  switch (q.kind) {
    case "getLayers":
      return doc.layers.map(summarize);
    case "getPreview":
      throw new Error("getPreview: render not implemented yet (see render plan)");
  }
}
```

```ts
// tools.ts
import type { AgentToolDefinition } from "@unidocs/core";

export const tools: Record<string, AgentToolDefinition> = {
  getLayers: { name: "query_getLayers", description: "List the layer tree (id, name, type, opacity, blendMode, bounds).", inputSchema: {} },
  add_layer: { name: "apply_add_layer", description: "Add a layer. Caller assigns the layer id and (for raster) pixels.", inputSchema: { type: "object", properties: { layer: { type: "object" }, parentId: { type: ["string", "null"] }, index: { type: "number" } }, required: ["layer", "parentId"] } },
  remove_layer: { name: "apply_remove_layer", description: "Delete a layer by id.", inputSchema: { type: "object", properties: { layerId: { type: "string" } }, required: ["layerId"] } },
  reorder: { name: "apply_reorder", description: "Move a layer to a new parent/index.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, parentId: { type: ["string", "null"] }, index: { type: "number" } }, required: ["layerId", "parentId"] } },
  set_props: { name: "apply_set_props", description: "Change name/opacity/blendMode/visible/locked/clipping.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, props: { type: "object" } }, required: ["layerId", "props"] } },
  crop: { name: "apply_crop", description: "Crop the canvas to [top,left,bottom,right].", inputSchema: { type: "object", properties: { rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } }, required: ["rect"] } },
  transform: { name: "apply_transform", description: "Translate or flip a layer (scale/rotate not yet supported).", inputSchema: { type: "object", properties: { layerId: { type: "string" }, op: { type: "object" } }, required: ["layerId", "op"] } },
  adjust: { name: "apply_adjust", description: "Change params of an existing adjustment layer.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, params: { type: "object" } }, required: ["layerId", "params"] } },
  mask_edit: { name: "apply_mask_edit", description: "Set, replace, or remove (null) a layer mask.", inputSchema: { type: "object", properties: { layerId: { type: "string" }, mask: { type: ["object", "null"] } }, required: ["layerId", "mask"] } },
  generative_fill: { name: "apply_generative_fill", description: "Insert a pre-generated raster layer with provenance (result pixels supplied by the tool layer).", inputSchema: { type: "object", properties: { layer: { type: "object" }, parentId: { type: ["string", "null"] }, index: { type: "number" }, provenance: { type: "object" } }, required: ["layer", "parentId", "provenance"] } },
};

export const instructions = `You are a PSD image editor operator. Query the layer tree with query_getLayers, then edit with apply_* tools.
Rules:
- Every new layer needs a caller-assigned unique id. Raster layers and generative results must include their pixel data.
- Generate images (generative_fill) in your own tool step first, then apply the resulting layer.
- Adjustment layers: create with apply_add_layer (type "adjustment"); change their params with apply_adjust.
- transform currently supports translate and flip only.`;
```

```ts
// doctype.ts (replaces the stub)
import type { DocumentTypeFactory } from "@unidocs/core";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { load } from "./psd/load.js";
import { save } from "./psd/save.js";
import { runQuery, type PsdQuery } from "./queries.js";
import { tools, instructions } from "./tools.js";

export type PsdOptions = Record<string, never>;
export type { PsdDoc, PsdQuery, PsdOp };

export const createPsdDocumentType: DocumentTypeFactory<PsdOptions, PsdDoc, PsdQuery, PsdOp> = (_options) => ({
  init: async (): Promise<PsdDoc> => ({
    canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [],
  }),
  load,
  save,
  apply,
  query: runQuery,
  contentType: "image/vnd.adobe.photoshop",
  tools,
  instructions,
});
```

```ts
// index.ts
export { createPsdDocumentType } from "./doctype.js";
export type { PsdDoc, PsdQuery, PsdOp, PsdOptions } from "./doctype.js";
export type { Canvas, Layer, Mask, Pixels, BlendMode, LayerType } from "./model/types.js";
```

- [ ] **Step 4: Run the full test suite**

Run: `cd packages/doctype-psd && npx vitest run`
Expected: PASS (all tests from Tasks 1–9).

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/doctype-psd && npx tsc --noEmit`
Expected: no errors. (If ag-psd type field names differ from Task 7 Step 1, fix the mappings.)

- [ ] **Step 6: Commit**

```bash
git add packages/doctype-psd/src/queries.ts packages/doctype-psd/src/tools.ts packages/doctype-psd/src/doctype.ts packages/doctype-psd/src/index.ts packages/doctype-psd/tests/doctype.test.ts
git commit -m "feat(doctype-psd): queries, tools, DocumentType assembly"
```

---

## Follow-up plans (not in scope here)

- **Plan ②: rendering** — canvaskit-wasm spike in workerd, `src/render/`, `getPreview` query, `transform` scale/rotate.
- **Plan ③: cloudflare-psd** — worker adapter, `wrangler` deploy, Gateway registration, DO-runtime end-to-end test.
- **Plan ④: web-psd** — UI, client-side render + optimistic local apply.

## Deferred / known gaps (tracked, intentional)

- `structuredClone` per op is simple but copies pixel buffers; revisit with structural sharing if profiling shows it hot.
- Unknown PSD blocks are dropped on load (strategy B); passthrough is post-MVP (design §6.3).
- `getPreview` throws until Plan ②.
- Groups map to `type: "group"`; fill/text/smartObject currently load as raster or group — richer typing is a later refinement.
