import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { applyOne } from "../src/ops/index.js";
import { render } from "../src/render/index.js";
import { opDirtyRect, opActiveIndex } from "../src/render/dirty-rect.js";

const canvas = { width: 100, height: 100, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const raster = (id: string, bounds: [number,number,number,number], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: px(bounds[3]-bounds[1], bounds[2]-bounds[0]), ...over,
});
const doc = (layers: Layer[]): PsdDoc => ({ canvas, layers });

describe("opDirtyRect", () => {
  it("set_props on a layer → that layer's influence bounds", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "a", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("transform move → union of old and new positions", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    // geometry-ops: translate is a [dx,dy] tuple; shiftBounds adds dx to
    // left/right, dy to top/bottom. [10,10,20,20] + [30,30] → [40,40,50,50].
    const op = { kind: "transform", payload: { layerId: "a", op: { translate: [30, 30] } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 50, 50]); // union of old+new
  });

  it("remove_layer → the removed layer's old influence", () => {
    const before = doc([raster("a", [10, 10, 20, 20]), raster("b", [50, 50, 60, 60])]);
    const op = { kind: "remove_layer", payload: { layerId: "a" } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("crop → full canvas", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "crop", payload: { rect: [0, 0, 50, 50] } };
    const after = applyOne(before, op);
    const r = opDirtyRect(op, before, after);
    expect(r[0]).toBe(0); expect(r[1]).toBe(0); // top-left of full canvas
  });

  it("unknown/absent layerId → full canvas (conservative)", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "nope", props: {} } };
    const after = before;
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 100, 100]);
  });

  it("reorder that lands a layer under a clip run → widened by the run", () => {
    // A clip layer's output depends on the nearest non-clipping visible layer below it.
    // Reordering a layer can change which layer is the clip-base, affecting the clip layer
    // far outside the reordered layer's own bounds — so the rect must cover the clip run too.
    const before = doc([
      raster("far", [0, 0, 10, 10]),
      raster("base", [50, 50, 90, 90]),
      raster("clip", [50, 50, 90, 90], { clipping: true }),
    ]);
    const op = { kind: "reorder", payload: { layerId: "far", parentId: null, index: 1 } };
    const after = applyOne(before, op);
    // after = [base, far, clip] → `clip` re-bases from `base` onto `far`. The change reaches
    // clip's bounds [50,50,90,90], far outside far's own [0,0,10,10]: union of both.
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 90, 90]);
  });

  it("set_props toggling visible on a clip-base → widened by the clip run", () => {
    // Hiding the clip-base layer un-confines the clipping layer above it, which can then
    // paint anywhere in its own bounds — outside the base's influence.
    const before = doc([
      raster("base", [50, 50, 90, 90]),
      raster("clip", [20, 20, 95, 95], { clipping: true }),
    ]);
    const op = { kind: "set_props", payload: { layerId: "base", props: { visible: false } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([20, 20, 95, 95]);
  });

  it("reorder without clipping layers → tight union rule (regression guard)", () => {
    // When no clipping layers are present, the tight union rule still applies.
    // This guards against over-broad fallback.
    const before = doc([
      raster("a", [10, 10, 20, 20]),
      raster("b", [50, 50, 60, 60]),
    ]);
    const op = { kind: "reorder", payload: { layerId: "a", parentId: null, index: 1 } };
    const after = applyOne(before, op);
    // Should be the union of a's influence before and after (no structural coupling).
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });
});

const group = (id: string, children: Layer[], over: Partial<Layer> = {}): Layer => ({
  id, type: "group", name: id, bounds: [0, 0, 100, 100], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, children, ...over,
});

// ---------------------------------------------------------------------------
// Precise clip-run analysis.
//
// The rule under test: an op only falls back past the tight union-of-target-
// influence when it can actually perturb `renderList`'s clip-base state machine
// — i.e. when the affected layer has a run of consecutive `clipping` SIBLINGS
// directly above it. Merely having a clipping layer *somewhere* in the document
// is not enough (that was the old, document-global guard).
//
// Every case below is checked twice: against the exact expected rect, AND
// against a real before/after render — `expectSuperset` fails if any pixel that
// actually changed falls outside the returned rect. That second check is the
// non-negotiable invariant; the exact-rect assertions just pin the tightness.
// ---------------------------------------------------------------------------

type Rect = [number, number, number, number];

/** Opaque-filled raster, so a render difference is actually observable. */
const solid = (id: string, b: Rect, rgba: [number, number, number, number], over: Partial<Layer> = {}): Layer => {
  const w = b[3] - b[1], h = b[2] - b[0];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i*4] = rgba[0]; data[i*4+1] = rgba[1]; data[i*4+2] = rgba[2]; data[i*4+3] = rgba[3]; }
  return { id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false, pixels: { width: w, height: h, data }, ...over };
};

/** Bounding box of the pixels that differ between two full renders (null if none). */
async function changedRect(before: PsdDoc, after: PsdDoc): Promise<Rect | null> {
  const a = await render(before), b = await render(after);
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i+1] !== b.data[i+1] || a.data[i+2] !== b.data[i+2] || a.data[i+3] !== b.data[i+3]) {
        if (y < top) top = y; if (x < left) left = x;
        if (y + 1 > bottom) bottom = y + 1; if (x + 1 > right) right = x + 1;
      }
    }
  }
  return bottom < 0 ? null : [top, left, bottom, right];
}

/** opDirtyRect(op) must be a SUPERSET of what actually changed. Returns the rect. */
async function expectSuperset(op: { kind: string; payload: Record<string, unknown> }, before: PsdDoc, after: PsdDoc): Promise<Rect> {
  const r = opDirtyRect(op, before, after) as Rect;
  const c = await changedRect(before, after);
  if (c) {
    expect({ dirty: r, changed: c, containsTop: r[0] <= c[0], containsLeft: r[1] <= c[1], containsBottom: r[2] >= c[2], containsRight: r[3] >= c[3] })
      .toMatchObject({ containsTop: true, containsLeft: true, containsBottom: true, containsRight: true });
  }
  return r;
}

describe("opDirtyRect — precise clip-run analysis", () => {
  const FULL: Rect = [0, 0, 100, 100];

  it("plain layer visibility toggle stays tight even though the doc HAS a clip run", async () => {
    // [bg, base, clip(clipping), plain] — `plain` sits above the run, so nothing
    // reads a clip base that its visibility could change. This is the live-app
    // case that used to repaint the whole canvas.
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("base", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("clip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      solid("plain", [0, 0, 12, 12], [0, 255, 0, 255]),
    ]);
    const op = { kind: "set_props", payload: { layerId: "plain", props: { visible: false } } };
    const after = applyOne(before, op);
    expect(await expectSuperset(op, before, after)).toEqual([0, 0, 12, 12]);
    expect(opDirtyRect(op, before, after)).not.toEqual(FULL);
  });

  it("toggling the clipping layer itself → its own influence (nothing above reads the base)", async () => {
    // `clip` has no clipping sibling above it, so the divergence it causes cannot
    // escape its own output. Widening would be wasted work, not safety — the
    // render-parity check proves the tight rect covers every changed pixel.
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("base", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("clip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      solid("plain", [0, 0, 12, 12], [0, 255, 0, 255]),
    ]);
    const op = { kind: "set_props", payload: { layerId: "clip", props: { visible: false } } };
    const after = applyOne(before, op);
    expect(await expectSuperset(op, before, after)).toEqual([20, 20, 90, 90]);
  });

  it("toggling a clip BASE widens by the clip run (the run un-confines)", async () => {
    // Hiding `base` leaves `clip` with a null base → it paints unconfined across
    // its full bounds [20,20,90,90], well outside base's own [40,40,60,60].
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("base", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("clip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
    ]);
    const op = { kind: "set_props", payload: { layerId: "base", props: { visible: false } } };
    const after = applyOne(before, op);
    const r = await expectSuperset(op, before, after);
    expect(r).toEqual([20, 20, 90, 90]);            // union(base, clip) influence
    expect(r[0]).toBeLessThan(40);                   // strictly wider than base's own bounds
  });

  it("promotion: un-hiding a base re-bases the whole clip run above it", async () => {
    // [hiddenBase, clipA, clipB]: while hiddenBase is hidden it RESETS the base to
    // null, so clipA paints unconfined and is PROMOTED to clipB's base. Showing it
    // re-bases clipA (and hence clipB) — both must be inside the dirty rect.
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("hiddenBase", [45, 45, 55, 55], [255, 0, 0, 255], { visible: false }),
      solid("clipA", [10, 10, 70, 70], [0, 0, 255, 255], { clipping: true }),
      solid("clipB", [30, 30, 96, 96], [0, 255, 255, 255], { clipping: true }),
    ]);
    const op = { kind: "set_props", payload: { layerId: "hiddenBase", props: { visible: true } } };
    const after = applyOne(before, op);
    const r = await expectSuperset(op, before, after);
    expect(r).toEqual([10, 10, 96, 96]); // union of hiddenBase + clipA + clipB influence
  });

  it("structural: reorder INTO a clip run widens; reorder of plain layers away from it stays tight", async () => {
    const base = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("cbase", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("clip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      solid("p1", [0, 0, 12, 12], [0, 255, 0, 255]),
      solid("p2", [0, 88, 12, 100], [255, 255, 0, 255]),
    ]);
    // (a) p1 moves to index 2 → [bg, cbase, p1, clip, p2]: it becomes clip's new
    //     base, so clip's output changes outside p1's [0,0,12,12].
    const intoRun = { kind: "reorder", payload: { layerId: "p1", parentId: null, index: 2 } };
    const afterInto = applyOne(base, intoRun);
    const rInto = await expectSuperset(intoRun, base, afterInto);
    expect(rInto).toEqual([0, 0, 90, 90]); // union(p1, clip)

    // (b) p1 and p2 swap ABOVE the run — no clipping sibling directly above p1 in
    //     either order, so the clip run is untouched → tight union, not full canvas.
    const swap = { kind: "reorder", payload: { layerId: "p1", parentId: null, index: 4 } };
    const afterSwap = applyOne(base, swap);
    const rSwap = await expectSuperset(swap, base, afterSwap);
    expect(rSwap).toEqual([0, 0, 12, 12]);
    expect(rSwap).not.toEqual(FULL);
  });

  it("structural: remove_layer next to a clip run widens; removing a plain layer stays tight", async () => {
    const base = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("cbase", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("clip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      solid("plain", [0, 0, 12, 12], [0, 255, 0, 255]),
    ]);
    const rmBase = { kind: "remove_layer", payload: { layerId: "cbase" } };
    expect(await expectSuperset(rmBase, base, applyOne(base, rmBase))).toEqual([20, 20, 90, 90]);

    const rmPlain = { kind: "remove_layer", payload: { layerId: "plain" } };
    const r = await expectSuperset(rmPlain, base, applyOne(base, rmPlain));
    expect(r).toEqual([0, 0, 12, 12]);
    expect(r).not.toEqual(FULL);
  });

  it("clip runs are per sibling list: a run inside a group does not taint the top level", async () => {
    // `renderList` recurses into group children with a FRESH baseCoverage, so the
    // group's internal clip run is invisible to the top-level state machine.
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      group("g", [
        solid("gbase", [40, 40, 60, 60], [255, 0, 0, 255]),
        solid("gclip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      ]),
      solid("plain", [0, 0, 12, 12], [0, 255, 0, 255]),
    ]);
    const op = { kind: "set_props", payload: { layerId: "plain", props: { visible: false } } };
    const after = applyOne(before, op);
    const r = await expectSuperset(op, before, after);
    expect(r).toEqual([0, 0, 12, 12]);
    expect(r).not.toEqual(FULL);
  });

  it("nested: toggling a clip base INSIDE a group widens by that group's own clip run", async () => {
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      group("g", [
        solid("gbase", [40, 40, 60, 60], [255, 0, 0, 255]),
        solid("gclip", [20, 20, 90, 90], [0, 0, 255, 255], { clipping: true }),
      ]),
    ]);
    const op = { kind: "set_props", payload: { layerId: "gbase", props: { visible: false } } };
    const after = applyOne(before, op);
    expect(await expectSuperset(op, before, after)).toEqual([20, 20, 90, 90]);
  });

  it("a `clipping` flag flip is clip-perturbing only when a clip run sits above", async () => {
    const before = doc([
      solid("bg", [0, 0, 100, 100], [20, 30, 40, 255]),
      solid("cbase", [40, 40, 60, 60], [255, 0, 0, 255]),
      solid("mid", [10, 10, 70, 70], [0, 0, 255, 255]),
      solid("top", [30, 30, 96, 96], [0, 255, 255, 255], { clipping: true }),
    ]);
    // `mid` gains `clipping` → it confines to cbase AND stops being `top`'s base
    // (the run above it re-bases). Must cover `top`.
    const flip = { kind: "set_props", payload: { layerId: "mid", props: { clipping: true } } };
    expect(await expectSuperset(flip, before, applyOne(before, flip))).toEqual([10, 10, 96, 96]);

    // `top` losing `clipping` perturbs nothing above it (it is the topmost layer).
    const unflip = { kind: "set_props", payload: { layerId: "top", props: { clipping: false } } };
    const r = await expectSuperset(unflip, before, applyOne(before, unflip));
    expect(r).toEqual([30, 30, 96, 96]);
  });
});

// Seeded property gate for the invariant itself: over documents deliberately
// dense in clip runs (multiple runs, hidden bases, hidden clipping layers that
// pass the base through, promotion chains, a group with its own internal run,
// an adjustment layer), EVERY pixel that a random op actually changes must land
// inside opDirtyRect's answer. This is the test that would catch an unsound
// narrowing of the clip-run predicate; incremental-random.test.ts then catches
// it a second time end-to-end via tile byte-parity.
describe("opDirtyRect — superset invariant over seeded random ops (clip-dense docs)", () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const smallCanvas = { width: 60, height: 60, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
  const s = (id: string, b: Rect, rgba: [number, number, number, number], over: Partial<Layer> = {}) => solid(id, b, rgba, over);

  const makeDoc = (): PsdDoc => ({ canvas: smallCanvas, layers: [
    s("bg", [0, 0, 60, 60], [20, 30, 40, 255]),
    s("b1", [5, 5, 25, 25], [255, 0, 0, 255]),
    s("c1", [0, 0, 40, 40], [0, 0, 255, 200], { clipping: true }),
    s("c2", [10, 10, 55, 55], [0, 255, 255, 180], { clipping: true, blendMode: "multiply" }),
    s("hid", [0, 30, 20, 60], [255, 255, 0, 255], { visible: false }),
    s("b2", [30, 30, 50, 50], [0, 200, 0, 255]),
    s("hc", [0, 0, 60, 60], [255, 0, 255, 255], { clipping: true, visible: false }), // hidden clip: passes base through
    s("c3", [20, 0, 60, 35], [255, 128, 0, 220], { clipping: true }),
    { id: "adj", type: "adjustment", name: "adj", bounds: [0, 0, 60, 60], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false, adjustType: "brit", params: { brightness: 0.05, contrast: 0.1 } },
    group("g", [
      s("gb", [5, 35, 25, 55], [128, 128, 255, 255]),
      s("gc", [0, 25, 40, 60], [255, 255, 255, 200], { clipping: true }),
      s("gp", [40, 40, 55, 55], [10, 10, 10, 255]),
    ]),
    s("top", [45, 0, 60, 20], [0, 0, 0, 255]),
  ]});

  const ids = ["bg", "b1", "c1", "c2", "hid", "b2", "hc", "c3", "adj", "g", "gb", "gc", "gp", "top"];

  function genOp(rng: () => number, d: PsdDoc, n: number) {
    const id = ids[Math.floor(rng() * ids.length)];
    const kinds = ["visible", "visible", "clipping", "reorder", "reorder", "reorder-into-group", "remove", "translate", "opacity"] as const;
    switch (kinds[Math.floor(rng() * kinds.length)]) {
      case "visible": return { kind: "set_props", payload: { layerId: id, props: { visible: rng() > 0.5 } } };
      case "clipping": return { kind: "set_props", payload: { layerId: id, props: { clipping: rng() > 0.5 } } };
      case "reorder": return { kind: "reorder", payload: { layerId: id, parentId: null, index: Math.floor(rng() * (d.layers.length + 1)) } };
      case "reorder-into-group": return { kind: "reorder", payload: { layerId: id, parentId: "g", index: Math.floor(rng() * 4) } };
      case "remove": return { kind: "remove_layer", payload: { layerId: id } };
      case "translate": return { kind: "transform", payload: { layerId: id, op: { translate: [Math.floor(rng() * 20) - 10, Math.floor(rng() * 20) - 10] } } };
      case "opacity": return { kind: "set_props", payload: { layerId: id, props: { opacity: Math.round(rng() * 100) / 100 } } };
    }
  }

  for (const seed of [1, 7, 42, 1234]) {
    it(`seed ${seed}: dirty rect contains every changed pixel over 40 random ops`, async () => {
      const rng = mulberry32(seed);
      let d = makeDoc();
      for (let n = 0; n < 40; n++) {
        const op = genOp(rng, d, n)!;
        let next: PsdDoc;
        try { next = applyOne(d, op); } catch { continue; } // handler-rejected ops (cycles, missing ids) don't ship
        await expectSuperset(op, d, next);
        d = next;
      }
    });
  }
});

describe("opActiveIndex", () => {
  it("set_props on the k-th top-level layer → k", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]);
    const op = { kind: "set_props", payload: { layerId: "b", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("set_props on a group's child → the group's top-level index (top ancestor)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), group("g", [raster("child", [0, 0, 10, 10])])]); // g at index 1
    const op = { kind: "set_props", payload: { layerId: "child", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("reorder → min(old top index, new top index)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]); // c at 2
    const op = { kind: "reorder", payload: { layerId: "c", parentId: null, index: 0 } }; // c: 2 → 0
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(0); // min(2, 0)
  });

  it("crop → 0", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10])]);
    const op = { kind: "crop", payload: { rect: [0, 0, 5, 5] } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(0);
  });

  it("remove_layer → the removed layer's top index in before (absent from after)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]);
    const op = { kind: "remove_layer", payload: { layerId: "b" } }; // index 1 in before, gone in after
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("add_layer at top index i → i (new layer absent from before)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10])]);
    const op = { kind: "add_layer", payload: { layer: raster("n", [0, 0, 10, 10]), parentId: null, index: 1 } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("set_props on an absent layer → 0 (conservative)", () => {
    const before = doc([raster("a", [0, 0, 10, 10])]);
    const op = { kind: "set_props", payload: { layerId: "nope", props: {} } };
    expect(opActiveIndex(op, before, before)).toBe(0);
  });
});
