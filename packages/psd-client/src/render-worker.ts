/// <reference lib="webworker" />
import { decodeSValue } from "@unidocs/svalue-codec";
import type { PsdDoc, PsdOp, PsdStoredDoc } from "@unidocs/doctype-psd/engine";
import { materializePsdDocFromStore } from "@unidocs/doctype-psd/engine";
import { CasBlobStore } from "./cas-blob-store.js";
import { RenderCore } from "./render-core.js";
import { createRequestQueue } from "./request-queue.js";
import type { HitCandidate, Rect as AlphaRect } from "./layer-alpha.js";

type Rect = [number, number, number, number];

/** Message protocol between the main thread `RenderClient` and this Worker.
 *  Every request carries the id `RenderClient` assigned it; every response
 *  echoes that id back, so the client can route strictly by id instead of
 *  assuming responses arrive in request order (they mostly do, since the
 *  worker processes requests through a queue below — but `tiles` batches
 *  can emit several responses per request, and errors need to name which
 *  request they belong to). */
export type WorkerRequest =
  | { type: "init"; id: number; snapshot: Uint8Array; apiBaseUrl: string; tileSize?: number; cacheBytes?: number }
  | { type: "applyOp"; id: number; op: PsdOp }
  | { type: "tiles"; id: number; tiles: Array<[number, number]> }
  | { type: "reset"; id: number; doc: PsdDoc }
  | { type: "hitTest"; id: number; x: number; y: number; radius: number; threshold?: number; hover?: boolean }
  | { type: "layerAlpha"; id: number; layerId: string };

export type WorkerResponse =
  | { type: "ready"; id: number; tileSize: number; canvas: { width: number; height: number } }
  | { type: "dirty"; id: number; rect: Rect }
  | { type: "tile"; id: number; tx: number; ty: number; width: number; height: number; data: Uint8ClampedArray }
  | { type: "tilesDone"; id: number }
  | { type: "resetDone"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "hit"; id: number; hits: HitCandidate[] }
  | { type: "layerAlpha"; id: number; bounds: AlphaRect | null; width: number; height: number; data: Uint8ClampedArray };

// `self` is the DedicatedWorkerGlobalScope per the webworker lib reference
// above. RenderCore is built once on "init" and reused across every
// subsequent "applyOp"/"tiles" message — this is the persistent
// compositor+cache invariant RenderCore exists to hold in the browser.
let core: RenderCore | null = null;

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "init": {
      try {
        const store = new CasBlobStore({ apiBaseUrl: req.apiBaseUrl });
        const state = decodeSValue(req.snapshot) as unknown as PsdStoredDoc;
        const doc = await materializePsdDocFromStore(state, store);
        core = new RenderCore(doc, store, { tileSize: req.tileSize, cacheBytes: req.cacheBytes });
        // Warm the decoded-pixel cache with ONE parallel batch of blob fetches
        // before answering "ready". Without this, the first `tiles` batch
        // faults every layer in serially (tiles × layers round-trips), and a
        // queued `applyOp` (from a live edit) is stuck behind that whole slow
        // batch — the ~1min "editing hangs" symptom. Awaiting it here means
        // "ready" itself is delayed by the warm-up, but every subsequent
        // "tiles"/"applyOp" is fast (cache hits only), so the queue never backs up.
        const prefetchStart = performance.now();
        const prefetchCount = await core.prefetch();
        console.log(`[psd-perf] worker: prefetch ${prefetchCount} blobs in ${Math.round(performance.now() - prefetchStart)}ms`);
        post({ type: "ready", id: req.id, tileSize: core.tileSize, canvas: { width: core.doc.canvas.width, height: core.doc.canvas.height } });
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
    case "applyOp": {
      try {
        if (!core) throw new Error("render-worker: received applyOp before init");
        const rect = await core.applyOp(req.op);
        post({ type: "dirty", id: req.id, rect });
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
    case "tiles": {
      if (!core) {
        post({ type: "error", id: req.id, message: "render-worker: received tiles before init" });
        post({ type: "tilesDone", id: req.id });
        break;
      }
      // Each tile is fetched/posted independently: one bad tile (a decode
      // failure, a missing CAS blob, ...) must not abort the rest of the
      // batch. `tilesDone` always fires at the end so the client's
      // `requestTiles` promise settles even if every tile in the batch
      // failed.
      {
        const batchStart = performance.now();
        let slowestTileMs = 0;
        for (const [tx, ty] of req.tiles) {
          const tileStart = performance.now();
          try {
            const px = await core.tile(tx, ty);
            // Copy into a fresh, transferable buffer: px.data may be a view
            // backed by the persistent PixelCache's storage, which we must
            // not hand off (transfer detaches the buffer on the sending side).
            const data = new Uint8ClampedArray(px.data);
            post({ type: "tile", id: req.id, tx, ty, width: px.width, height: px.height, data }, [data.buffer]);
          } catch (err) {
            post({ type: "error", id: req.id, message: errorMessage(err) });
          }
          slowestTileMs = Math.max(slowestTileMs, performance.now() - tileStart);
        }
        console.log(`[psd-perf] worker: batch tiles=${req.tiles.length} totalMs=${Math.round(performance.now() - batchStart)}ms slowestTileMs=${Math.round(slowestTileMs)}ms`);
      }
      post({ type: "tilesDone", id: req.id });
      break;
    }
    case "reset": {
      try {
        if (!core) throw new Error("render-worker: received reset before init");
        core.reset(req.doc);
        post({ type: "resetDone", id: req.id });
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
    case "hitTest": {
      try {
        if (!core) throw new Error("render-worker: received hitTest before init");
        post({ type: "hit", id: req.id, hits: await core.hitTest(req.x, req.y, { radius: req.radius, threshold: req.threshold }) });
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
    case "layerAlpha": {
      try {
        if (!core) throw new Error("render-worker: received layerAlpha before init");
        const region = await core.layerAlphaRegion(req.layerId);
        if (!region) {
          post({ type: "layerAlpha", id: req.id, bounds: null, width: 0, height: 0, data: new Uint8ClampedArray(0) });
          break;
        }
        const [top, left, bottom, right] = region.bounds;
        // A fresh buffer, because `region.data` may be a view over the
        // persistent PixelCache's storage and transferring detaches it here —
        // same reason the tiles branch copies.
        const data = new Uint8ClampedArray(region.data);
        post({ type: "layerAlpha", id: req.id, bounds: region.bounds, width: right - left, height: bottom - top, data }, [data.buffer]);
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
  }
}

const queue = createRequestQueue<WorkerRequest>({
  run: (req) => handle(req),
  // A hover request that never runs still owes its caller an answer: the
  // client keeps one pending entry per id, and an unanswered one is a leaked
  // map entry and a promise that never settles.
  drop: (req) => { if (req.type === "hitTest") post({ type: "hit", id: req.id, hits: [] }); },
  // Only hover hit tests. `applyOp` is document state and a click is a user
  // waiting for an answer — neither may be skipped.
  discardable: (req) => req.type === "hitTest" && !!req.hover,
});

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue.submit(ev.data);
};
