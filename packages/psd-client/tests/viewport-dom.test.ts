import { describe, it, expect, beforeAll } from "vitest";
import { Viewport } from "../src/viewport.js";

/**
 * Covers the two methods that touch the DOM and so were previously verified
 * only by running the app: `draw` (which now paints at 1:1 with no transform)
 * and `visibleTiles` (which culls through the measured ratio). Neither needs a
 * real 2d context — only that the right numbers reach it — so the canvas and
 * its context are stubs rather than jsdom.
 */

interface PutCall { x: number; y: number; width: number; height: number }

class StubImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}

beforeAll(() => {
  (globalThis as { ImageData?: unknown }).ImageData = StubImageData;
});

function stubCanvas(bitmap: { width: number; height: number }, cssBox: { left: number; top: number; width: number; height: number }) {
  const puts: PutCall[] = [];
  const drawImageCalls: unknown[] = [];
  const canvas = {
    width: bitmap.width,
    height: bitmap.height,
    getContext: () => ({
      putImageData: (img: StubImageData, x: number, y: number) => {
        puts.push({ x, y, width: img.width, height: img.height });
      },
      drawImage: (...args: unknown[]) => { drawImageCalls.push(args); },
    }),
    getBoundingClientRect: () => ({
      left: cssBox.left, top: cssBox.top,
      right: cssBox.left + cssBox.width, bottom: cssBox.top + cssBox.height,
      width: cssBox.width, height: cssBox.height,
    }),
  } as unknown as HTMLCanvasElement;
  return { canvas, puts, drawImageCalls };
}

function stubContainer(box: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({
      left: box.left, top: box.top,
      right: box.left + box.width, bottom: box.top + box.height,
      width: box.width, height: box.height,
    }),
  } as unknown as HTMLElement;
}

const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

describe("Viewport.draw", () => {
  it("paints a tile at its document-space origin", () => {
    const { canvas, puts } = stubCanvas({ width: 1024, height: 1024 }, { left: 0, top: 0, width: 1024, height: 1024 });
    new Viewport(canvas).draw(2, 3, pixels(256, 256), 256);
    expect(puts).toEqual([{ x: 512, y: 768, width: 256, height: 256 }]);
  });

  it("paints at the SAME place when the canvas is CSS-scaled, and never scales the tile itself", () => {
    // 400%: the browser stretches the element; the bitmap is untouched, so the
    // tile's destination must not move. Scaling here instead would paint each
    // tile at 4x its size into a document-sized bitmap — the corruption this
    // replaced.
    const { canvas, puts, drawImageCalls } = stubCanvas({ width: 1024, height: 1024 }, { left: 0, top: 0, width: 4096, height: 4096 });
    new Viewport(canvas).draw(2, 3, pixels(256, 256), 256);
    expect(puts).toEqual([{ x: 512, y: 768, width: 256, height: 256 }]);
    expect(drawImageCalls).toEqual([]);
  });

  it("paints an edge tile at its origin even when it is clipped small", () => {
    const { canvas, puts } = stubCanvas({ width: 600, height: 600 }, { left: 0, top: 0, width: 600, height: 600 });
    new Viewport(canvas).draw(2, 2, pixels(88, 88), 256);
    expect(puts).toEqual([{ x: 512, y: 512, width: 88, height: 88 }]);
  });
});

describe("Viewport.visibleTiles", () => {
  const setup = (bitmap: { width: number; height: number }, css: { left: number; top: number; width: number; height: number }, container: { left: number; top: number; width: number; height: number }) => {
    const { canvas } = stubCanvas(bitmap, css);
    const vp = new Viewport(canvas);
    vp.setDoc(bitmap);
    vp.setViewportEl(stubContainer(container));
    return vp;
  };
  const keys = (vp: Viewport, tileSize: number) => vp.visibleTiles(tileSize).map((t) => `${t.tx},${t.ty}`).sort();

  it("culls to the container at 1:1", () => {
    const vp = setup({ width: 512, height: 512 }, { left: 0, top: 0, width: 512, height: 512 }, { left: 0, top: 0, width: 256, height: 256 });
    expect(keys(vp, 256)).toEqual(["0,0"]);
  });

  it("returns MORE document tiles through the same container when zoomed out", () => {
    // 512 doc px squeezed into 256 CSS px: the whole document now fits in a
    // 256px container, so every tile is visible. This is the "fit to window
    // composites the whole document" cost, made explicit.
    const vp = setup({ width: 512, height: 512 }, { left: 0, top: 0, width: 256, height: 256 }, { left: 0, top: 0, width: 256, height: 256 });
    expect(keys(vp, 256)).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });

  it("returns FEWER document tiles through the same container when zoomed in", () => {
    // 512 doc px stretched over 1024 CSS px: 256 CSS px of container now shows
    // only 128 document px, which is one tile.
    const vp = setup({ width: 512, height: 512 }, { left: 0, top: 0, width: 1024, height: 1024 }, { left: 0, top: 0, width: 256, height: 256 });
    expect(keys(vp, 256)).toEqual(["0,0"]);
  });

  it("follows the canvas as it scrolls under the container", () => {
    // Canvas scrolled up 256 CSS px: the container now looks at the second row.
    const vp = setup({ width: 512, height: 512 }, { left: 0, top: -256, width: 512, height: 512 }, { left: 0, top: 0, width: 512, height: 256 });
    expect(keys(vp, 256)).toEqual(["0,1", "1,1"]);
  });

  it("returns nothing when the canvas is scrolled fully out of view", () => {
    const vp = setup({ width: 512, height: 512 }, { left: 0, top: -900, width: 512, height: 512 }, { left: 0, top: 0, width: 512, height: 256 });
    expect(keys(vp, 256)).toEqual([]);
  });
});

describe("Viewport screen<->canvas", () => {
  it("reflects the canvas's measured CSS box, with no state to set", () => {
    const { canvas } = stubCanvas({ width: 800, height: 600 }, { left: 0, top: 0, width: 1600, height: 1200 });
    const vp = new Viewport(canvas);
    // 200%: 100 CSS px in is 50 document px in.
    expect(vp.screenToCanvas(100, 40)).toEqual({ x: 50, y: 20 });
    expect(vp.canvasToScreen(50, 20)).toEqual({ x: 100, y: 40 });
  });

  it("round-trips a document point through the screen at a fractional zoom", () => {
    const { canvas } = stubCanvas({ width: 4001, height: 2999 }, { left: 0, top: 0, width: 1333.67, height: 999.67 });
    const vp = new Viewport(canvas);
    const s = vp.canvasToScreen(4001, 2999);
    expect(s.x).toBeCloseTo(1333.67);
    const back = vp.screenToCanvas(s.x, s.y);
    expect(back.x).toBeCloseTo(4001);
    expect(back.y).toBeCloseTo(2999);
  });
});
