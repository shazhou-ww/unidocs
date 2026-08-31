import type { Pixels, Tile } from "@unidocs/doctype-psd/engine";
import { tilesForRect } from "@unidocs/doctype-psd/engine";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The subset of `DOMRect` this module reads. Declared structurally so the
 *  pure functions below can be exercised without a DOM. */
export interface BoxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

type Rect = [number, number, number, number]; // [top,left,bottom,right]

/**
 * Bitmap pixels per CSS pixel, one factor per axis.
 *
 * This is THE zoom factor, and it is deliberately *measured* rather than
 * carried as state: the canvas bitmap is always the document at 1:1, so
 * whatever CSS size the browser actually laid the element out at IS the
 * zoom. Reading it back means the mapping cannot drift from what the user
 * sees — no rounding of a fractional zoom, no stale value after a resize,
 * no accumulating error toward the far corner of a large document. Anything
 * that scales the canvas box (a zoom control, a `max-width`, a print
 * stylesheet) is picked up for free, because nothing has to be told.
 */
export interface Ratio {
  x: number;
  y: number;
}

/**
 * `bitmap` is the canvas's intrinsic pixel size, `box` its laid-out CSS size.
 *
 * A zero-sized box means the element is not laid out (detached, `display:
 * none`, or a jsdom test where `getBoundingClientRect` returns zeros). There
 * is no meaningful ratio then, so fall back to 1:1 rather than producing
 * `Infinity` and poisoning every coordinate downstream.
 */
export function measuredRatio(bitmap: Size, box: Size): Ratio {
  return {
    x: box.width > 0 ? bitmap.width / box.width : 1,
    y: box.height > 0 ? bitmap.height / box.height : 1,
  };
}

/** CSS px relative to the canvas's top-left → document pixels. */
export function screenToCanvas(ratio: Ratio, sx: number, sy: number): Point {
  return { x: sx * ratio.x, y: sy * ratio.y };
}

/** Document pixels → CSS px relative to the canvas's top-left. */
export function canvasToScreen(ratio: Ratio, cx: number, cy: number): Point {
  return { x: cx / ratio.x, y: cy / ratio.y };
}

/**
 * The document-space rect of the canvas currently visible through a scrolling
 * container, or null when the canvas is scrolled entirely out of view.
 *
 * Both rects are viewport-relative (`getBoundingClientRect`), so their
 * intersection is taken in CSS space and only then mapped into document
 * pixels through the measured ratio — which is what makes this correct at
 * any zoom without being told the zoom.
 */
export function visibleBitmapRect(canvas: BoxRect, container: BoxRect, bitmap: Size): Rect | null {
  const ratio = measuredRatio(bitmap, canvas);
  const left = Math.max(0, (Math.max(canvas.left, container.left) - canvas.left) * ratio.x);
  const top = Math.max(0, (Math.max(canvas.top, container.top) - canvas.top) * ratio.y);
  const right = Math.min(bitmap.width, (Math.min(canvas.right, container.right) - canvas.left) * ratio.x);
  const bottom = Math.min(bitmap.height, (Math.min(canvas.bottom, container.bottom) - canvas.top) * ratio.y);
  if (right <= left || bottom <= top) return null;
  return [Math.floor(top), Math.floor(left), Math.ceil(bottom), Math.ceil(right)];
}

/**
 * Thin DOM glue over a `<canvas>` whose bitmap is ALWAYS the document at 1:1.
 *
 * Two invariants hold this together, and both are load-bearing:
 *
 * 1. **The bitmap is document space.** Tile (tx,ty) is painted at exactly
 *    `(tx*tileSize, ty*tileSize)` — no transform, ever. Zoom is applied by
 *    the browser when it scales the element's CSS box, which costs nothing
 *    and keeps the compositor's tile pipeline (fixed to document pixels, no
 *    scale parameter anywhere in the engine) untouched.
 * 2. **Screen↔document mapping is measured, never stored.** See `Ratio`.
 *    Every consumer — marquee, layer drag, eyedropper, selection overlay —
 *    goes through `screenToCanvas`/`canvasToScreen` so they cannot drift
 *    apart from each other or from what is on screen.
 *
 * Panning is the container's native scrolling; this class deliberately holds
 * no pan state.
 */
export class Viewport {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private docSize: Size = { width: 0, height: 0 };
  private container: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Viewport: canvas 2d context unavailable");
    this.ctx = ctx;
  }

  /** Registers the scrolling container the canvas sits inside (e.g. `.stage`,
   *  which has `overflow:auto` and is usually much smaller on-screen than a
   *  large document). Once set, `visibleTiles` culls to the on-screen
   *  intersection of the canvas and this element instead of the whole
   *  canvas. */
  setViewportEl(el: HTMLElement): void {
    this.container = el;
  }

  /** Records the document's pixel dimensions. Equal to the canvas bitmap size
   *  by invariant (1) above; sizing the bitmap is the caller's job. */
  setDoc(size: Size): void {
    this.docSize = size;
  }

  /** The live bitmap-per-CSS-pixel ratio of the canvas element. */
  ratio(): Ratio {
    return measuredRatio(
      { width: this.canvas.width, height: this.canvas.height },
      this.canvas.getBoundingClientRect(),
    );
  }

  screenToCanvas(sx: number, sy: number): Point {
    return screenToCanvas(this.ratio(), sx, sy);
  }

  canvasToScreen(cx: number, cy: number): Point {
    return canvasToScreen(this.ratio(), cx, cy);
  }

  /** Tiles currently visible on-screen. Without a registered container the
   *  canvas's own bitmap is assumed fully visible, which for a document
   *  larger than the screen means every tile — hence `setViewportEl`. */
  visibleTiles(tileSize: number): Tile[] {
    const bitmap = { width: this.canvas.width, height: this.canvas.height };
    if (!this.container) return tilesForRect(this.docSize, tileSize, [0, 0, bitmap.height, bitmap.width]);
    const rect = visibleBitmapRect(this.canvas.getBoundingClientRect(), this.container.getBoundingClientRect(), bitmap);
    if (!rect) return [];
    return tilesForRect(this.docSize, tileSize, rect);
  }

  /** Paints one decoded tile at its document-space position. Straight
   *  `putImageData` — see invariant (1): the bitmap is document space, so
   *  there is nothing to transform. */
  draw(tx: number, ty: number, px: Pixels, tileSize: number): void {
    // Uint8ClampedArray is generic over its backing buffer in newer lib.dom
    // typings; `ImageData` wants one backed by a plain `ArrayBuffer`, so copy
    // to be safe regardless of what buffer `px.data` happens to carry.
    const imageData = new ImageData(new Uint8ClampedArray(px.data), px.width, px.height);
    this.ctx.putImageData(imageData, tx * tileSize, ty * tileSize);
  }
}
