import { describe, it, expect } from "vitest";
import { measuredRatio, screenToCanvas, canvasToScreen, visibleBitmapRect, type BoxRect } from "../src/viewport.js";

/** A laid-out canvas box at (left,top) with the given CSS size. */
const box = (left: number, top: number, width: number, height: number): BoxRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

describe("measuredRatio", () => {
  it("is 1:1 when the CSS box matches the bitmap", () => {
    expect(measuredRatio({ width: 800, height: 600 }, box(0, 0, 800, 600))).toEqual({ x: 1, y: 1 });
  });

  it("reports bitmap-per-CSS-pixel when the box is scaled up (zoomed in)", () => {
    // 800 doc px shown across 1600 CSS px = 200% zoom = 0.5 doc px per CSS px.
    expect(measuredRatio({ width: 800, height: 600 }, box(0, 0, 1600, 1200))).toEqual({ x: 0.5, y: 0.5 });
  });

  it("reports bitmap-per-CSS-pixel when the box is scaled down (zoomed out)", () => {
    expect(measuredRatio({ width: 800, height: 600 }, box(0, 0, 200, 150))).toEqual({ x: 4, y: 4 });
  });

  it("falls back to 1:1 for an unlaid-out box instead of dividing by zero", () => {
    // jsdom, `display:none`, or a detached element: getBoundingClientRect is
    // all zeros. Infinity here would poison every coordinate downstream.
    expect(measuredRatio({ width: 800, height: 600 }, box(0, 0, 0, 0))).toEqual({ x: 1, y: 1 });
  });
});

describe("screenToCanvas / canvasToScreen", () => {
  it("is the identity at 1:1", () => {
    const r = { x: 1, y: 1 };
    expect(screenToCanvas(r, 42, 17)).toEqual({ x: 42, y: 17 });
    expect(canvasToScreen(r, 42, 17)).toEqual({ x: 42, y: 17 });
  });

  it("round-trips in both directions at an arbitrary ratio", () => {
    const r = { x: 0.5, y: 4 };
    for (const [sx, sy] of [[0, 0], [100, 50], [37.5, 12]] as const) {
      const c = screenToCanvas(r, sx, sy);
      const back = canvasToScreen(r, c.x, c.y);
      expect(back.x).toBeCloseTo(sx);
      expect(back.y).toBeCloseTo(sy);
    }
  });

  it("maps a zoomed-in cursor to sub-pixel document coordinates", () => {
    // At 400% (ratio 0.25) one CSS px is a quarter of a document pixel, so
    // the cursor can address inside a pixel — this is why zooming in makes
    // the eyedropper and marquee MORE precise, not less.
    expect(screenToCanvas({ x: 0.25, y: 0.25 }, 5, 9)).toEqual({ x: 1.25, y: 2.25 });
  });

  /**
   * The property the whole measured-ratio design exists for. A fractional
   * zoom lays the box out at a non-integer CSS size; deriving the mapping
   * from a stored zoom would leave a residue that grows with distance from
   * the origin, so the far corner of a large document would be off by
   * several document pixels while the top-left looked fine.
   */
  it("lands exactly on the far corner at a fractional zoom", () => {
    const bitmap = { width: 4001, height: 2999 };
    const laidOut = box(0, 0, 1333.67, 999.67); // what the browser actually did
    const r = measuredRatio(bitmap, laidOut);
    const corner = canvasToScreen(r, bitmap.width, bitmap.height);
    expect(corner.x).toBeCloseTo(laidOut.width);
    expect(corner.y).toBeCloseTo(laidOut.height);
    const back = screenToCanvas(r, corner.x, corner.y);
    expect(back.x).toBeCloseTo(bitmap.width);
    expect(back.y).toBeCloseTo(bitmap.height);
  });
});

describe("visibleBitmapRect", () => {
  const bitmap = { width: 256, height: 256 };

  it("returns the whole canvas when it fits inside the container", () => {
    expect(visibleBitmapRect(box(0, 0, 256, 256), box(0, 0, 400, 400), bitmap)).toEqual([0, 0, 256, 256]);
  });

  it("clips to the container when the canvas is scrolled under it", () => {
    // Canvas scrolled up by 100 CSS px: its top 100 rows are above the container.
    expect(visibleBitmapRect(box(0, -100, 256, 256), box(0, 0, 256, 100), bitmap)).toEqual([100, 0, 200, 256]);
  });

  it("returns null when the canvas is scrolled entirely out of view", () => {
    expect(visibleBitmapRect(box(0, -400, 256, 256), box(0, 0, 256, 100), bitmap)).toBeNull();
  });

  it("converts the visible slice into document pixels when zoomed out", () => {
    // 256 doc px drawn across 128 CSS px (50%); the container shows the top
    // 32 CSS px, which is the top 64 document rows.
    expect(visibleBitmapRect(box(0, 0, 128, 128), box(0, 0, 128, 32), bitmap)).toEqual([0, 0, 64, 256]);
  });

  it("converts the visible slice into document pixels when zoomed in", () => {
    // 256 doc px drawn across 512 CSS px (200%); 128 CSS px of container
    // shows 64 document rows.
    expect(visibleBitmapRect(box(0, 0, 512, 512), box(0, 0, 512, 128), bitmap)).toEqual([0, 0, 64, 256]);
  });

  it("never reports past the bitmap when the container is larger than the canvas", () => {
    expect(visibleBitmapRect(box(50, 50, 256, 256), box(0, 0, 1000, 1000), bitmap)).toEqual([0, 0, 256, 256]);
  });
});
