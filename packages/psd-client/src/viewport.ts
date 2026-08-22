import type { Pixels, Tile } from "@unidocs/doctype-psd/engine";
import { tilesForRect } from "@unidocs/doctype-psd/engine";

export interface View {
  pan: { x: number; y: number };
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Pure affine map between screen space (CSS px inside the viewport element)
 *  and canvas space (document pixels): `canvas = (screen - pan) / zoom`.
 *  Everything canvas-independent about pan/zoom lives here so it can be unit
 *  tested without a DOM. */
export function viewTransform(view: View): {
  toCanvas(sx: number, sy: number): Point;
  toScreen(cx: number, cy: number): Point;
} {
  const { pan, zoom } = view;
  return {
    toCanvas: (sx, sy) => ({ x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }),
    toScreen: (cx, cy) => ({ x: cx * zoom + pan.x, y: cy * zoom + pan.y }),
  };
}

export function screenToCanvas(view: View, sx: number, sy: number): Point {
  return viewTransform(view).toCanvas(sx, sy);
}

export function canvasToScreen(view: View, cx: number, cy: number): Point {
  return viewTransform(view).toScreen(cx, cy);
}

/** Tiles (from the engine's tile grid) currently visible given the view's
 *  pan/zoom and the on-screen size of the viewport element. */
export function visibleTiles(view: View, canvasSize: Size, tileSize: number, viewportPx: Size): Tile[] {
  const t = viewTransform(view);
  const topLeft = t.toCanvas(0, 0);
  const bottomRight = t.toCanvas(viewportPx.width, viewportPx.height);
  const rect: [number, number, number, number] = [topLeft.y, topLeft.x, bottomRight.y, bottomRight.x];
  return tilesForRect(canvasSize, tileSize, rect);
}

/** Thin DOM glue over a `<canvas>`: pan/zoom state + painting decoded tiles.
 *  Not unit-tested (needs a real canvas 2d context) — verified by running
 *  the app (Task 5). All the coordinate math it delegates to is pure and
 *  tested above. */
export class Viewport {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private docSize: Size = { width: 0, height: 0 };
  private view: View = { pan: { x: 0, y: 0 }, zoom: 1 };
  private container: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Viewport: canvas 2d context unavailable");
    this.ctx = ctx;
  }

  /** Registers the scrolling container the canvas sits inside (e.g. `#stage`,
   *  which has `overflow:auto` and is usually much smaller on-screen than a
   *  large document rendered at native resolution). Once set, `visibleTiles`
   *  culls to the on-screen intersection of the canvas and this element
   *  instead of the whole canvas — see the module doc on `visibleTiles`
   *  above for why that distinction matters. */
  setViewportEl(el: HTMLElement): void {
    this.container = el;
  }

  /** Records the document's pixel dimensions, used to clip `visibleTiles`
   *  to the document bounds. The canvas element's own bitmap size is the
   *  on-screen viewport (independent of doc size, since pan/zoom means the
   *  visible window is usually smaller than the full document) — sizing it
   *  is the caller's responsibility (CSS/container layout). */
  setDoc(size: Size): void {
    this.docSize = size;
  }

  getView(): View {
    return { pan: { ...this.view.pan }, zoom: this.view.zoom };
  }

  setPan(x: number, y: number): void {
    this.view = { ...this.view, pan: { x, y } };
  }

  panBy(dx: number, dy: number): void {
    this.view = { ...this.view, pan: { x: this.view.pan.x + dx, y: this.view.pan.y + dy } };
  }

  setZoom(zoom: number): void {
    this.view = { ...this.view, zoom };
  }

  screenToCanvas(sx: number, sy: number): Point {
    return screenToCanvas(this.view, sx, sy);
  }

  canvasToScreen(cx: number, cy: number): Point {
    return canvasToScreen(this.view, cx, cy);
  }

  /** Tiles currently visible on-screen. When the canvas is rendered at
   *  native document resolution inside a scrolling container (e.g. `#stage`,
   *  `overflow:auto`), `canvas.clientWidth/Height` equal the FULL bitmap
   *  size — not what's actually on-screen — so falling back to that (no
   *  `setViewportEl` call) returns every tile of the whole canvas. With a
   *  container registered, we instead intersect the canvas's and
   *  container's on-screen rects (`getBoundingClientRect`) and map that
   *  intersection into bitmap-pixel coordinates, so only the tiles actually
   *  visible through the scroll viewport are requested. */
  visibleTiles(tileSize: number): Tile[] {
    if (!this.container) {
      return visibleTiles(this.view, this.docSize, tileSize, {
        width: this.canvas.clientWidth || this.canvas.width,
        height: this.canvas.clientHeight || this.canvas.height,
      });
    }
    const cr = this.canvas.getBoundingClientRect();
    const vr = this.container.getBoundingClientRect();
    // displayed->bitmap ratio (==1 at native size; robust if CSS ever scales
    // the canvas element itself, independent of the Viewport's own zoom).
    const rx = this.canvas.width / (cr.width || this.canvas.width);
    const ry = this.canvas.height / (cr.height || this.canvas.height);
    const left = Math.max(0, (Math.max(cr.left, vr.left) - cr.left) * rx);
    const top = Math.max(0, (Math.max(cr.top, vr.top) - cr.top) * ry);
    const right = Math.min(this.canvas.width, (Math.min(cr.right, vr.right) - cr.left) * rx);
    const bottom = Math.min(this.canvas.height, (Math.min(cr.bottom, vr.bottom) - cr.top) * ry);
    if (right <= left || bottom <= top) return [];
    return tilesForRect(this.docSize, tileSize, [Math.floor(top), Math.floor(left), Math.ceil(bottom), Math.ceil(right)]);
  }

  /** Paints one decoded tile at (tx,ty) onto the canvas at its pan/zoom-mapped
   *  position. `putImageData` can't scale, so at zoom !== 1 we stage the tile
   *  through an offscreen canvas and `drawImage` it at the zoomed size. */
  draw(tx: number, ty: number, px: Pixels, tileSize: number): void {
    const { x: sx, y: sy } = this.canvasToScreen(tx * tileSize, ty * tileSize);
    // Uint8ClampedArray is generic over its backing buffer in newer lib.dom
    // typings; `ImageData` wants one backed by a plain `ArrayBuffer`, so copy
    // to be safe regardless of what buffer `px.data` happens to carry.
    const imageData = new ImageData(new Uint8ClampedArray(px.data), px.width, px.height);

    if (this.view.zoom === 1) {
      this.ctx.putImageData(imageData, Math.round(sx), Math.round(sy));
      return;
    }

    const staging = document.createElement("canvas");
    staging.width = px.width;
    staging.height = px.height;
    const stagingCtx = staging.getContext("2d");
    if (!stagingCtx) return;
    stagingCtx.putImageData(imageData, 0, 0);
    this.ctx.drawImage(staging, sx, sy, px.width * this.view.zoom, px.height * this.view.zoom);
  }
}
