import { describe, it, expect } from "vitest";
import { ZOOM_MIN, ZOOM_MAX, clampZoom, nextStop, fitZoom, initialZoom, anchorScroll } from "../src/ui/zoom.js";

describe("clampZoom", () => {
  it("holds the range", () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0.001)).toBe(ZOOM_MIN);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("falls back to 1 for a non-finite zoom rather than propagating NaN", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });
});

describe("nextStop", () => {
  it("steps between adjacent stops", () => {
    expect(nextStop(1, 1)).toBe(1.5);
    expect(nextStop(1, -1)).toBe(0.67);
    expect(nextStop(0.5, 1)).toBe(0.67);
  });

  it("saturates at the ends instead of running off the ladder", () => {
    expect(nextStop(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(nextStop(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it("steps to the next stop PAST an off-ladder zoom, not to the nearest", () => {
    // The wheel and "fit" both land between stops; a step must move in the
    // asked-for direction from wherever it actually is.
    expect(nextStop(0.37, 1)).toBe(0.5);
    expect(nextStop(0.37, -1)).toBe(0.33);
    expect(nextStop(2.4, -1)).toBe(2);
  });

  it("does not treat a value that IS a stop as already past itself", () => {
    expect(nextStop(0.67, 1)).toBe(1);
    expect(nextStop(0.67, -1)).toBe(0.5);
  });
});

describe("fitZoom", () => {
  it("fits a document wider than the stage", () => {
    // 2000 wide into 1032 usable (1064 - 32 margin) -> 0.516
    expect(fitZoom({ width: 2000, height: 500 }, { width: 1064, height: 900 })).toBeCloseTo(0.516, 3);
  });

  it("uses the tighter of the two axes", () => {
    const z = fitZoom({ width: 1000, height: 4000 }, { width: 1032, height: 532 });
    expect(z).toBeCloseTo(0.125, 3); // height-bound: 500/4000
  });

  it("scales a small document UP, because an explicit fit means fit", () => {
    // 200 wide into 500 usable -> 2.5, well clear of the ceiling so this
    // pins the scaling-up behaviour rather than the clamp.
    expect(fitZoom({ width: 200, height: 200 }, { width: 532, height: 532 })).toBeCloseTo(2.5, 3);
  });

  it("still obeys the ceiling when fitting would exceed it", () => {
    expect(fitZoom({ width: 100, height: 100 }, { width: 532, height: 532 })).toBe(ZOOM_MAX);
  });

  it("reaches far enough down for a document many times the stage", () => {
    // The reason the floor is 5% and not 25%: this is an ordinary large PSD.
    const z = fitZoom({ width: 6000, height: 4000 }, { width: 1432, height: 900 });
    expect(z).toBeGreaterThan(ZOOM_MIN);
    // Height-bound: 868/4000. Comfortably under the old 25% floor, which is
    // exactly why the floor moved.
    expect(z).toBeCloseTo(0.217, 3);
    expect(z).toBeLessThan(0.25);
  });

  it("is 1 for an empty document rather than dividing by zero", () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
  });
});

describe("initialZoom", () => {
  it("is 1:1 when the document already fits", () => {
    expect(initialZoom({ width: 256, height: 256 }, { width: 1000, height: 800 })).toBe(1);
  });

  it("never enlarges a small document on open", () => {
    expect(initialZoom({ width: 100, height: 100 }, { width: 1000, height: 800 })).toBe(1);
  });

  it("shrinks a document that overflows", () => {
    expect(initialZoom({ width: 4000, height: 100 }, { width: 1032, height: 800 })).toBeCloseTo(0.25, 3);
  });
});

describe("anchorScroll", () => {
  it("is the distance the anchor drifted, which is what to scroll back", () => {
    // The point the cursor was over ended up 40px right of the cursor after
    // the re-layout, so scroll right by 40 to put it back under the cursor.
    expect(anchorScroll(300, 340)).toBe(40);
    expect(anchorScroll(300, 260)).toBe(-40);
    expect(anchorScroll(300, 300)).toBe(0);
  });
});

describe("fitZoom on an unmeasured stage", () => {
  it("stays at 1:1 rather than collapsing to the floor", () => {
    // The stage is 0x0 until the browser lays it out. Treating that as a
    // tiny window would open every large document at 5%.
    expect(fitZoom({ width: 6000, height: 4000 }, { width: 0, height: 0 })).toBe(1);
    expect(initialZoom({ width: 6000, height: 4000 }, { width: 0, height: 0 })).toBe(1);
  });

  it("also refuses a stage smaller than the margin it would subtract", () => {
    expect(fitZoom({ width: 6000, height: 4000 }, { width: 20, height: 900 })).toBe(1);
  });
});
