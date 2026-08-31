import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import type { WorkerRequest, WorkerResponse } from "./render-worker.js";
import type { HitCandidate, Rect as AlphaRect } from "./layer-alpha.js";

type Rect = [number, number, number, number];

export interface LayerAlphaResult { bounds: AlphaRect; width: number; height: number; data: Uint8ClampedArray }

export interface TileMessage {
  tx: number;
  ty: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type InitResult = { tileSize: number; canvas: { width: number; height: number } };

// One entry per in-flight request, keyed by the id `RenderClient` assigned
// it. Tagged with `kind` (rather than one untyped `Map<number, {resolve:
// (v:unknown)=>void, ...}>`) so each response handler can resolve with its
// real type without an `unknown`/`any` cast at the call site. Every
// response echoes the id of the request it answers, so — unlike a FIFO
// queue — an out-of-order or unrelated response (e.g. a `tiles` batch's
// per-tile error arriving while an `applyOp` is also pending) can never be
// routed to the wrong caller.
type PendingEntry =
  | { kind: "init"; resolve: (v: InitResult) => void; reject: (e: unknown) => void }
  | { kind: "applyOp"; resolve: (rect: Rect) => void; reject: (e: unknown) => void }
  | { kind: "tiles"; resolve: () => void; reject: (e: unknown) => void }
  | { kind: "reset"; resolve: () => void; reject: (e: unknown) => void }
  | { kind: "hitTest"; resolve: (hits: HitCandidate[]) => void; reject: (e: unknown) => void }
  | { kind: "layerAlpha"; resolve: (v: LayerAlphaResult | null) => void; reject: (e: unknown) => void };

/** Main-thread handle on the render Worker: serializes/deserializes the
 *  {@link WorkerRequest}/{@link WorkerResponse} protocol. Thin message
 *  glue — no render logic lives here (that's `RenderCore`, resident in
 *  the Worker). Not unit-tested; verified by running the app (Task 5). */
export class RenderClient {
  private readonly worker: Worker;
  private readonly tileHandlers: Array<(tile: TileMessage) => void> = [];
  private readonly dirtyHandlers: Array<(rect: Rect) => void> = [];
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      this.handleMessage(ev.data);
    };
  }

  private handleMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "ready": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "init") entry.resolve({ tileSize: msg.tileSize, canvas: msg.canvas });
        this.pending.delete(msg.id);
        break;
      }
      case "dirty": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "applyOp") entry.resolve(msg.rect);
        this.pending.delete(msg.id);
        for (const cb of this.dirtyHandlers) cb(msg.rect);
        break;
      }
      case "tile": {
        // Tiles don't settle the batch promise themselves — only
        // `tilesDone`/`error` do — so no `pending` lookup here, just fan
        // out to whoever's listening for painted pixels.
        const tile: TileMessage = { tx: msg.tx, ty: msg.ty, width: msg.width, height: msg.height, data: msg.data };
        for (const cb of this.tileHandlers) cb(tile);
        break;
      }
      case "tilesDone": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "tiles") entry.resolve();
        this.pending.delete(msg.id);
        break;
      }
      case "resetDone": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "reset") entry.resolve();
        this.pending.delete(msg.id);
        break;
      }
      case "error": {
        // Routed strictly by id: rejects only the request this error
        // actually belongs to, never an unrelated pending applyOp/init.
        // If the entry was already settled (e.g. a tiles batch that hit a
        // per-tile error and already rejected, then later emits
        // `tilesDone`), this is a no-op — `pending.get` returns undefined.
        this.pending.get(msg.id)?.reject(new Error(msg.message));
        this.pending.delete(msg.id);
        break;
      }
      case "hit": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "hitTest") entry.resolve(msg.hits);
        this.pending.delete(msg.id);
        break;
      }
      case "layerAlpha": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "layerAlpha") {
          entry.resolve(msg.bounds ? { bounds: msg.bounds, width: msg.width, height: msg.height, data: msg.data } : null);
        }
        this.pending.delete(msg.id);
        break;
      }
    }
  }

  /** Sends the cold-start TDoc snapshot bytes (already fetched via `loadDoc`) to the
  *  Worker; it builds its own `CasBlobStore` from `apiBaseUrl` to fault in
   *  layer pixels and stands up the persistent `RenderCore`. Resolves once
   *  the Worker acks with the doc's tile size and canvas dimensions. */
  init(opts: { snapshot: Uint8Array; apiBaseUrl: string; tileSize?: number; cacheBytes?: number }): Promise<InitResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "init", resolve, reject });
      const req: WorkerRequest = {
        type: "init",
        id,
        snapshot: opts.snapshot,
        apiBaseUrl: opts.apiBaseUrl,
        tileSize: opts.tileSize,
        cacheBytes: opts.cacheBytes,
      };
      this.worker.postMessage(req, [opts.snapshot.buffer]);
    });
  }

  /** Applies one op to the resident doc in the Worker; resolves with the
   *  dirty rect (canvas coords) once re-composited. */
  applyOp(op: PsdOp): Promise<Rect> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "applyOp", resolve, reject });
      const req: WorkerRequest = { type: "applyOp", id, op };
      this.worker.postMessage(req);
    });
  }

  /** Swaps the Worker's resident doc for `doc` (e.g. after a 409/agent
   *  rebase), keeping the Worker's warm `PixelCache`: layers whose blob hash
   *  is unchanged are served from cache instead of being re-fetched. `doc`
   *  is a lazy doc (layers are `PixelRef{width,height,hash}`, no resident
   *  pixel arrays), so it's cheap to structured-clone across `postMessage` —
   *  sent with no transfer list. */
  reset(doc: PsdDoc): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "reset", resolve, reject });
      const req: WorkerRequest = { type: "reset", id, doc };
      this.worker.postMessage(req);
    });
  }

  /** Requests a batch of tiles; each tile arrives asynchronously via
   *  `onTile` as it's ready. The returned promise resolves once the whole
   *  batch has been attempted (`tilesDone`) or rejects on the first
   *  per-tile error in the batch. */
  requestTiles(tiles: Array<[number, number]>): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "tiles", resolve, reject });
      const req: WorkerRequest = { type: "tiles", id, tiles };
      this.worker.postMessage(req);
    });
  }

  onTile(cb: (tile: TileMessage) => void): void {
    this.tileHandlers.push(cb);
  }

  onDirty(cb: (rect: Rect) => void): void {
    this.dirtyHandlers.push(cb);
  }

  /** Every layer under the point, topmost first. `radius` is the click
   *  tolerance in DOCUMENT pixels — the caller converts it from CSS pixels,
   *  which is zoom-dependent. `hover: true` marks the request DISCARDABLE:
   *  the Worker replaces a waiting one and skips it while real work is in
   *  flight, resolving the skipped one with `[]`. */
  hitTest(x: number, y: number, opts: { radius: number; threshold?: number; hover?: boolean }): Promise<HitCandidate[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "hitTest", resolve, reject });
      const req: WorkerRequest = { type: "hitTest", id, x, y, radius: opts.radius, threshold: opts.threshold, hover: opts.hover };
      this.worker.postMessage(req);
    });
  }

  /** One layer's alpha as a single-channel coverage buffer over its own box;
   *  null when the layer is gone or has no extent. */
  layerAlpha(layerId: string): Promise<LayerAlphaResult | null> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "layerAlpha", resolve, reject });
      const req: WorkerRequest = { type: "layerAlpha", id, layerId };
      this.worker.postMessage(req);
    });
  }
}
