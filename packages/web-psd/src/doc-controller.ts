// web-psd renders locally in the browser via @unidocs/psd-client: a Worker
// holds a persistent RenderCore (IncrementalCompositor + PixelCache) over the
// doc's lazy CAS-backed pixels, so after the cold-start load, every layer
// edit re-composites only the dirty tiles in-process — no per-edit
// full-canvas getPreview round trip to the gateway (that used to cost ~10s).
//
// The gateway is still the source of truth. `DocSession` owns the
// baseVersion + per-op pending queue and the background `/apply` submit
// loop: every op applies locally (instant paint) and is durably queued —
// no single-slot overwrite — then submitted in the background. A 409 (or
// an out-of-band server change, e.g. a chat agent run) triggers a rebase
// inside `DocSession` (new snapshot + replay pending + warm `render.reset`)
// instead of a full-page reload.

import { CasBlobStore, DocSession, loadDoc, RenderClient, Viewport } from "@unidocs/psd-client";
import { cacheBytesFor, countLayers, rectsOverlap, type LocalLayer, type Rect, type SizedLayer } from "./doc-model.js";

// Dev: Vite proxies `/gw/*` to the gateway (see vite.config.ts), which keeps
// the browser same-origin without CORS. Production: the built app is served
// BY the gateway itself, so the API is already same-origin and the prefix
// would be a path that does not exist there. `import.meta.env.DEV` is
// substituted at build time, so the dev-only branch is not shipped.
export const GW = import.meta.env.DEV ? "/gw" : "";
export const USER = "u1";
export const API_BASE_URL = `${GW}/tenants/${USER}`;
export const TYPE = "psd";

export interface Op { kind: string; payload: Record<string, unknown> }

export interface DocControllerEvents {
  onStatus(message: string): void;
  /** Fires whenever the document or version changes: cold start, local op,
   *  rebase (409 / agent run / another tab), rollback. */
  onDoc(doc: DocSession["doc"], version: number): void;
}

export class DocController {
  private readonly view: HTMLCanvasElement;
  private readonly stageEl: HTMLElement;
  private readonly events: DocControllerEvents;

  // Local render state: `session` is the durable sync core (owns the local
  // doc copy + baseVersion + pending queue — see doc-session.ts) that the
  // layers panel reads from. `renderClient`/`viewport` drive the resident
  // Worker + canvas. `tileSize` comes back from the Worker's `init` ack once
  // the doc is loaded.
  private docIdField: string | null = null;
  private session: DocSession | null = null;
  private renderClient: RenderClient | null = null;
  private viewport: Viewport | null = null;
  private currentWorker: Worker | null = null;
  private tileSize = 256;

  private readonly onScroll: () => void;
  private readonly onResize: () => void;

  constructor(view: HTMLCanvasElement, stage: HTMLElement, events: DocControllerEvents) {
    this.view = view;
    this.stageEl = stage;
    this.events = events;

    this.onScroll = debounce(() => this.requestVisibleTiles(), 60);
    this.onResize = debounce(() => this.requestVisibleTiles(), 120);
    // Registered once here (not per `initRender`) — `renderClient`/
    // `viewport` are read fresh inside `requestVisibleTiles` on each fire, so
    // a doc swap (new worker + Viewport) is picked up automatically without
    // needing to tear down and re-add listeners.
    this.stageEl.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
  }

  get docId(): string | null {
    return this.docIdField;
  }

  get version(): number {
    return this.session?.version ?? 0;
  }

  get doc(): DocSession["doc"] | null {
    return this.session?.doc ?? null;
  }

  /** Cold-starts local rendering for `docId`: loads this tab's own doc copy,
   *  spins up a fresh render Worker with canonical TDoc bytes, sizes the canvas to
   *  the doc, constructs the `DocSession` sync core, and paints the full
   *  first frame. */
  private async initRender(): Promise<void> {
    const docId = this.docIdField;
    if (!docId) return;
    this.events.onStatus(`loading ${docId.slice(0, 8)}…`);

    const store = new CasBlobStore({ apiBaseUrl: API_BASE_URL });
    const { doc, version, snapshot } = await loadDoc({
      apiBaseUrl: API_BASE_URL,
      type: TYPE,
      docId,
      store,
    });

    // Tear down any previous doc's worker before starting a new one.
    this.currentWorker?.terminate();
    const worker = new Worker(new URL("../../psd-client/src/render-worker.ts", import.meta.url), { type: "module" });
    this.currentWorker = worker;
    this.renderClient = new RenderClient(worker);
    this.renderClient.onTile((tile) => {
      this.viewport?.draw(tile.tx, tile.ty, { width: tile.width, height: tile.height, data: tile.data }, this.tileSize);
    });

    // Size the browser cache to actually hold this doc's decoded layers (see
    // `decodedBytes` above), not the engine's small resident-doc default.
    const cacheBytes = cacheBytesFor(doc.layers as unknown as SizedLayer[]);
    const workerInitStart = performance.now();
    const init = await this.renderClient.init({ snapshot, apiBaseUrl: API_BASE_URL, cacheBytes });
    const workerInitMs = performance.now() - workerInitStart;
    this.tileSize = init.tileSize;

    this.view.width = init.canvas.width;
    this.view.height = init.canvas.height;

    this.viewport = new Viewport(this.view);
    this.viewport.setDoc(init.canvas);
    this.viewport.setViewportEl(this.stageEl);

    this.session = new DocSession({
      apiBaseUrl: API_BASE_URL,
      type: TYPE,
      docId,
      doc,
      version,
      store,
      render: this.renderClient,
      // Fires on EVERY rebase, not just the explicit chat->reconcile() path
      // below — including an autonomous 409 during a background drain (e.g.
      // an edit queued while an agent `/run` or another tab is mid-flight),
      // which otherwise has no UI-refresh hook and would leave the canvas +
      // layers panel stale until the next unrelated user interaction.
      onRebase: (rebasedDoc) => {
        void this.repaintAfterDocChange(rebasedDoc);
      },
    });

    const tiles = this.viewport.visibleTiles(this.tileSize);
    const totalTiles = Math.ceil(init.canvas.width / this.tileSize) * Math.ceil(init.canvas.height / this.tileSize);
    console.log(
      `[psd-perf] init: doc ${init.canvas.width}x${init.canvas.height}, tileSize=${this.tileSize}, ` +
      `layers=${countLayers(doc.layers as unknown as LocalLayer[])}, totalTiles=${totalTiles}, ` +
      `visibleTiles=${tiles.length}, stageRect=${this.stageEl.clientWidth}x${this.stageEl.clientHeight}, ` +
      `canvasRect=${this.view.width}x${this.view.height}`,
    );

    const firstPaintStart = performance.now();
    if (tiles.length > 0) await this.renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
    const firstPaintMs = performance.now() - firstPaintStart;
    console.log(`[psd-perf] init: workerInit=${Math.round(workerInitMs)}ms firstPaint=${Math.round(firstPaintMs)}ms (tiles=${tiles.length})`);

    this.events.onDoc(this.session.doc, this.session.version);
    this.events.onStatus(`v${this.session.version} · ${docId.slice(0, 8)}`);
  }

  /** Resyncs the DOM canvas + Viewport transform to `doc`'s current
   *  dimensions if they changed (e.g. an agent crop/resize) — mirroring what
   *  `initRender` does on cold start — then repaints the currently visible
   *  tiles and refreshes the layers panel. Called both from `DocSession`'s
   *  `onRebase` hook (an autonomous rebase, see above) and explicitly after
   *  chat's `reconcile()` below, so a canvas-dimension change is always
   *  picked up regardless of which path triggered the rebase. */
  private async repaintAfterDocChange(doc: DocSession["doc"]): Promise<void> {
    if (!this.viewport || !this.renderClient) return;
    if (doc.canvas.width !== this.view.width || doc.canvas.height !== this.view.height) {
      this.view.width = doc.canvas.width;
      this.view.height = doc.canvas.height;
      this.viewport.setDoc(doc.canvas);
    }
    const tiles = this.viewport.visibleTiles(this.tileSize);
    if (tiles.length > 0) await this.renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
    if (this.session) this.events.onDoc(this.session.doc, this.session.version);
  }

  /** Requests whatever tiles `viewport.visibleTiles` currently reports —
   *  called on scroll/resize of `#stage` so panning around a large doc
   *  streams in newly-visible tiles. Already-composed clean tiles are cache
   *  hits in the Worker (`IncrementalCompositor` returns the cached tile
   *  unless it's been invalidated), so re-requesting the on-screen set on
   *  every scroll is cheap — only tiles that haven't been composed yet (or
   *  were invalidated by an edit) actually do work. */
  requestVisibleTiles(): void {
    if (!this.renderClient || !this.viewport) return;
    const tiles = this.viewport.visibleTiles(this.tileSize);
    if (tiles.length > 0) void this.renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
  }

  /** Zoom changes only ever reach the canvas as a CSS box size, which the
   *  Viewport measures rather than being told (see `Ratio` in viewport.ts).
   *  So there is nothing to set here — only newly-exposed tiles to fetch,
   *  since zooming out widens the visible document area. */
  setZoom(): void {
    this.requestVisibleTiles();
  }

  /** Client (viewport) coords → document pixels. */
  toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return this.viewport?.screenToCanvas(clientX - r.left, clientY - r.top) ?? { x: 0, y: 0 };
  }

  /** Document pixels → coords relative to the canvas element's top-left. */
  toScreen(cx: number, cy: number): { x: number; y: number } {
    return this.viewport?.canvasToScreen(cx, cy) ?? { x: 0, y: 0 };
  }

  /** Reads one pixel from the composited canvas. Used by the eyedropper tool.
   *  Returns null when the point is outside the canvas or the 2D context is
   *  unavailable.
   *
   *  Goes through `toCanvas` rather than doing its own client-rect math: the
   *  eyedropper, the marquee and the layer drag must agree on which document
   *  pixel the cursor is over at every zoom, and the only way to guarantee
   *  that is for them to share one mapping. */
  pickColor(clientX: number, clientY: number): string | null {
    const ctx = this.view.getContext("2d");
    if (!ctx) return null;
    const { x: fx, y: fy } = this.toCanvas(clientX, clientY);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= this.view.width || y >= this.view.height) return null;
    const [rr, gg, bb] = ctx.getImageData(x, y, 1, 1).data;
    return "#" + [rr, gg, bb].map((c) => c.toString(16).padStart(2, "0")).join("");
  }

  /** Applies an op LOCALLY first via `DocSession` (instant repaint of just the
   *  dirty tiles — the whole point of this task): `session.applyLocal`
   *  advances the session's own doc copy, paints it through `renderClient`,
   *  and durably queues the op for background submission (no single-slot
   *  overwrite — rapid edits all make it to the server, in order). Any 409 or
   *  agent-driven server change is rebased onto inside `DocSession` itself. */
  async dispatch(op: Op): Promise<void> {
    if (!this.session) return;
    const totalStart = performance.now();
    let rect: Rect | undefined;
    let applyOpMs = 0;
    let tilesMs = 0;
    let visibleCount = 0;
    let requestedCount = 0;
    try {
      const applyStart = performance.now();
      rect = await this.session.applyLocal(op);
      applyOpMs = performance.now() - applyStart;
      // `applyLocal` REPLACES `session.doc` with a fresh object, so every
      // component that reads the doc out of the store — the layer tree's
      // visibility glyph, the properties pane's effect spreads — is holding a
      // stale copy until this fires. Without it a local edit repaints the
      // canvas correctly while the whole right column silently keeps showing
      // (and writing from) pre-edit values: the eye could hide a layer but
      // never un-hide it, and a props write spread a stale effect object back
      // over the server's newer one. `session.version` deliberately does NOT
      // advance until the background drain acks, so the version badge lags by
      // design; the DOCUMENT must not.
      this.events.onDoc(this.session.doc, this.session.version);
      if (this.renderClient && this.viewport) {
        const visible = this.viewport.visibleTiles(this.tileSize);
        visibleCount = visible.length;
        const dirty = visible.filter((t) => rectsOverlap(t.region, rect as Rect));
        requestedCount = dirty.length;
        if (dirty.length > 0) {
          const tilesStart = performance.now();
          await this.renderClient.requestTiles(dirty.map((t) => [t.tx, t.ty]));
          tilesMs = performance.now() - tilesStart;
        }
      }
    } catch (e) {
      this.events.onStatus(`local apply failed: ${(e as Error).message}`);
    } finally {
      const totalMs = performance.now() - totalStart;
      const layerId = (op.payload as { layerId?: string }).layerId ?? "?";
      const [t, l, b, r] = rect ?? [0, 0, 0, 0];
      console.log(
        `[psd-perf] toggle ${op.kind}/${layerId}: dirty=[${t},${l},${b},${r}] dirtyArea=${r - l}x${b - t} ` +
        `visible=${visibleCount} requested=${requestedCount} applyOpMs=${Math.round(applyOpMs)}ms ` +
        `tilesMs=${Math.round(tilesMs)}ms totalMs=${Math.round(totalMs)}ms`,
      );
    }
  }

  async createFrom(bytes: Uint8Array, label: string): Promise<void> {
    this.events.onStatus(`creating from ${label}…`);
    try {
      const fd = new FormData();
      fd.append("file", new Blob([bytes as BlobPart]), label);
      const r = await fetch(`${GW}/tenants/${USER}/docs/${TYPE}/`, { method: "POST", body: fd });
      const body = await r.json();
      if (!body.success) throw new Error(body.error ?? "create failed");
      this.docIdField = body.docId;
      await this.initRender();
      this.events.onStatus(`v${this.session?.version} · ${this.docIdField?.slice(0, 8)} · ${label}`);
    } catch (e) {
      this.events.onStatus(`failed: ${(e as Error).message}`);
    }
  }

  async reconcile(): Promise<void> {
    if (!this.session) return;
    await this.session.reconcile();
    await this.repaintAfterDocChange(this.session.doc);
  }

  dispose(): void {
    this.stageEl.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    this.currentWorker?.terminate();
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(fn, ms);
  };
}
