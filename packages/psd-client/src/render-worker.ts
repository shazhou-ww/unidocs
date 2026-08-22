/// <reference lib="webworker" />
import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import { deserialize } from "@unidocs/doctype-psd/engine";
import { CasBlobStore } from "./cas-blob-store.js";
import { RenderCore } from "./render-core.js";

type Rect = [number, number, number, number];

/** Message protocol between the main thread `RenderClient` and this Worker.
 *  Every request carries the id `RenderClient` assigned it; every response
 *  echoes that id back, so the client can route strictly by id instead of
 *  assuming responses arrive in request order (they mostly do, since the
 *  worker processes requests through a queue below — but `tiles` batches
 *  can emit several responses per request, and errors need to name which
 *  request they belong to). */
export type WorkerRequest =
  | { type: "init"; id: number; ir: Uint8Array; gw: string; user: string; tileSize?: number; cacheBytes?: number }
  | { type: "applyOp"; id: number; op: PsdOp }
  | { type: "tiles"; id: number; tiles: Array<[number, number]> }
  | { type: "reset"; id: number; doc: PsdDoc };

export type WorkerResponse =
  | { type: "ready"; id: number; tileSize: number; canvas: { width: number; height: number } }
  | { type: "dirty"; id: number; rect: Rect }
  | { type: "tile"; id: number; tx: number; ty: number; width: number; height: number; data: Uint8ClampedArray }
  | { type: "tilesDone"; id: number }
  | { type: "resetDone"; id: number }
  | { type: "error"; id: number; message: string };

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
        const store = new CasBlobStore({ gw: req.gw, user: req.user });
        const doc = await deserialize(req.ir, store);
        core = new RenderCore(doc, store, { tileSize: req.tileSize, cacheBytes: req.cacheBytes });
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
      for (const [tx, ty] of req.tiles) {
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
  }
}

// Requests are processed strictly in arrival order via a chained promise
// queue. Without this, an async handler's `await` points let the worker's
// message dispatcher start the next handler before the previous one
// finishes, which could interleave two mutations of the single resident
// RenderCore (or race an applyOp against a tiles read mid-composite).
let queue: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  // `handle()` already catches and reports every request-scoped failure as
  // an `error` response, so this `.catch` is a last-resort backstop for
  // anything that escapes it (e.g. a bug in `handle` itself throwing before
  // its own try/catch). Without it, a rejection here would propagate into
  // `queue` and every future `.then(() => handle(...))` chained onto it
  // would be skipped — one bad message would permanently wedge the worker
  // for the rest of the session.
  queue = queue.then(() => handle(ev.data)).catch((err) => {
    console.error("render-worker: unhandled error draining message queue", err);
  });
};
