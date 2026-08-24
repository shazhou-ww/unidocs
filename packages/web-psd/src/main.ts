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

const GW = "/gw"; // Vite proxies this to the gateway (see vite.config.ts)
const USER = "u1";
const TYPE = "psd";

let docId: string | null = null;

// Local render state: `session` is the durable sync core (owns the local
// doc copy + baseVersion + pending queue — see doc-session.ts) that the
// layers panel reads from. `renderClient`/`viewport` drive the resident
// Worker + canvas. `tileSize` comes back from the Worker's `init` ack once
// the doc is loaded.
let session: DocSession | null = null;
let renderClient: RenderClient | null = null;
let viewport: Viewport | null = null;
let currentWorker: Worker | null = null;
let tileSize = 256;

const view = document.getElementById("view") as HTMLCanvasElement;
const stageEl = document.getElementById("stage") as HTMLDivElement; // scrolling container around #view — see Viewport.setViewportEl
const layersEl = document.getElementById("layers") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const chatSend = document.getElementById("chat-send") as HTMLButtonElement;

type Op = { kind: string; payload: Record<string, unknown> };
type Rect = [number, number, number, number]; // [top,left,bottom,right] — matches the engine's convention

// Minimal shape of the layer nodes on `doc.layers` that the panel reads/writes.
// (Structurally compatible with the engine's `Layer` — kept local so web-psd
// doesn't need a direct dependency on @unidocs/doctype-psd.)
interface LocalLayer {
  id: string; type: string; name: string; opacity: number; blendMode: string; visible: boolean;
  children?: LocalLayer[];
}

// Superset of LocalLayer used only for sizing the render cache — adds the
// (lazy-ref or resident) pixel dimensions `decodedBytes` walks. Both
// `Layer.pixels` (a `PixelRef`/`Pixels`) and `Layer.mask.pixels` carry
// `width`/`height` regardless of whether they're resolved yet.
interface SizedLayer extends LocalLayer {
  pixels?: { width: number; height: number };
  mask?: { pixels: { width: number; height: number } };
  children?: SizedLayer[];
}

/** Recursive count of every layer, including group children — used by the
 *  [psd-perf] init log to report doc complexity alongside tile counts. */
function countLayers(layers: LocalLayer[]): number {
  let n = 0;
  for (const l of layers) {
    n += 1;
    if (l.children) n += countLayers(l.children);
  }
  return n;
}

/** Sum of every layer's (and mask's) decoded RGBA byte size, walking group
 *  children. Used to size the Worker's PixelCache to the doc: the engine
 *  default (64 MiB) is fine for small docs but evicts constantly on a large
 *  PSD (hundreds of MB–1GB+ of decoded pixels), which defeats the whole
 *  point of the persistent cache — every composite re-faults (re-fetches +
 *  re-decodes from CAS) whatever got evicted since the last one. */
function decodedBytes(layers: SizedLayer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.pixels) n += l.pixels.width * l.pixels.height * 4;
    if (l.mask?.pixels) n += l.mask.pixels.width * l.mask.pixels.height * 4;
    if (l.children) n += decodedBytes(l.children);
  }
  return n;
}

const CACHE_FLOOR = 128 * 1024 * 1024; // 128 MiB — small docs still get real headroom
const CACHE_HEADROOM = 64 * 1024 * 1024; // slack for tile buffers alongside layer pixels
const CACHE_CAP = 1024 * 1024 * 1024; // 1 GiB ceiling — don't reserve unbounded memory for huge docs

function setStatus(msg: string): void { statusEl.textContent = msg; }

function rectsOverlap(a: Rect, b: Rect): boolean {
  const [at, al, ab, ar] = a;
  const [bt, bl, bb, br] = b;
  return at < bb && ab > bt && al < br && ar > bl;
}

/** Fetches the doc's raw current IR bytes directly (separately from
 *  `loadDoc`, which deserializes its own copy for this tab's local `doc`) —
 *  the Worker needs its own `Uint8Array` because `RenderClient.init`
 *  transfers (detaches) the buffer it's handed.
 *
 *  Goes through `GET .../ir` rather than `.../snapshot` + the user-scoped
 *  CAS: the snapshot hash is a 16-char durable-storage (R2) key, not a
 *  64-char user-CAS node hash, so `store.get(hash)` on it 400s ("Invalid
 *  hash") — see `DocumentSession.ir()` in server-core. */
async function fetchIrBytes(): Promise<Uint8Array> {
  const r = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/ir`);
  if (!r.ok) throw new Error(`ir fetch failed: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Cold-starts local rendering for `docId`: loads this tab's own doc copy,
 *  spins up a fresh render Worker with the IR bytes, sizes the canvas to
 *  the doc, constructs the `DocSession` sync core, and paints the full
 *  first frame. */
async function initRender(): Promise<void> {
  if (!docId) return;
  setStatus(`loading ${docId.slice(0, 8)}…`);

  const store = new CasBlobStore({ gw: GW, user: USER });
  const [{ doc, version }, ir] = await Promise.all([
    loadDoc({ gw: GW, user: USER, type: TYPE, docId, store }),
    fetchIrBytes(),
  ]);

  // Tear down any previous doc's worker before starting a new one.
  currentWorker?.terminate();
  const worker = new Worker(new URL("../../psd-client/src/render-worker.ts", import.meta.url), { type: "module" });
  currentWorker = worker;
  renderClient = new RenderClient(worker);
  renderClient.onTile((tile) => {
    viewport?.draw(tile.tx, tile.ty, { width: tile.width, height: tile.height, data: tile.data }, tileSize);
  });

  // Size the browser cache to actually hold this doc's decoded layers (see
  // `decodedBytes` above), not the engine's small resident-doc default.
  const cacheBytes = Math.min(
    CACHE_CAP,
    Math.max(CACHE_FLOOR, decodedBytes(doc.layers as unknown as SizedLayer[]) + CACHE_HEADROOM),
  );
  const workerInitStart = performance.now();
  const init = await renderClient.init({ ir, gw: GW, user: USER, cacheBytes });
  const workerInitMs = performance.now() - workerInitStart;
  tileSize = init.tileSize;

  view.width = init.canvas.width;
  view.height = init.canvas.height;

  viewport = new Viewport(view);
  viewport.setDoc(init.canvas);
  viewport.setViewportEl(stageEl);

  session = new DocSession({
    gw: GW,
    user: USER,
    type: TYPE,
    docId,
    doc,
    version,
    store,
    render: renderClient,
    // Fires on EVERY rebase, not just the explicit chat->reconcile() path
    // below — including an autonomous 409 during a background drain (e.g.
    // an edit queued while an agent `/run` or another tab is mid-flight),
    // which otherwise has no UI-refresh hook and would leave the canvas +
    // layers panel stale until the next unrelated user interaction.
    onRebase: (rebasedDoc) => {
      void repaintAfterDocChange(rebasedDoc);
    },
  });

  const tiles = viewport.visibleTiles(tileSize);
  const totalTiles = Math.ceil(init.canvas.width / tileSize) * Math.ceil(init.canvas.height / tileSize);
  console.log(
    `[psd-perf] init: doc ${init.canvas.width}x${init.canvas.height}, tileSize=${tileSize}, ` +
    `layers=${countLayers(doc.layers as unknown as LocalLayer[])}, totalTiles=${totalTiles}, ` +
    `visibleTiles=${tiles.length}, stageRect=${stageEl.clientWidth}x${stageEl.clientHeight}, ` +
    `canvasRect=${view.width}x${view.height}`,
  );

  const firstPaintStart = performance.now();
  if (tiles.length > 0) await renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
  const firstPaintMs = performance.now() - firstPaintStart;
  console.log(`[psd-perf] init: workerInit=${Math.round(workerInitMs)}ms firstPaint=${Math.round(firstPaintMs)}ms (tiles=${tiles.length})`);

  refreshLayers();
  setStatus(`v${session.version} · ${docId.slice(0, 8)}`);
}

/** Resyncs the DOM canvas + Viewport transform to `doc`'s current
 *  dimensions if they changed (e.g. an agent crop/resize) — mirroring what
 *  `initRender` does on cold start — then repaints the currently visible
 *  tiles and refreshes the layers panel. Called both from `DocSession`'s
 *  `onRebase` hook (an autonomous rebase, see above) and explicitly after
 *  chat's `reconcile()` below, so a canvas-dimension change is always
 *  picked up regardless of which path triggered the rebase. */
async function repaintAfterDocChange(doc: DocSession["doc"]): Promise<void> {
  if (!viewport || !renderClient) return;
  if (doc.canvas.width !== view.width || doc.canvas.height !== view.height) {
    view.width = doc.canvas.width;
    view.height = doc.canvas.height;
    viewport.setDoc(doc.canvas);
  }
  const tiles = viewport.visibleTiles(tileSize);
  if (tiles.length > 0) await renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
  refreshLayers();
}

/** Requests whatever tiles `viewport.visibleTiles` currently reports —
 *  called on scroll/resize of `#stage` so panning around a large doc
 *  streams in newly-visible tiles. Already-composed clean tiles are cache
 *  hits in the Worker (`IncrementalCompositor` returns the cached tile
 *  unless it's been invalidated), so re-requesting the on-screen set on
 *  every scroll is cheap — only tiles that haven't been composed yet (or
 *  were invalidated by an edit) actually do work. */
function requestVisibleTiles(): void {
  if (!renderClient || !viewport) return;
  const tiles = viewport.visibleTiles(tileSize);
  if (tiles.length > 0) void renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));
}

function debounce(fn: () => void, ms: number): () => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(fn, ms);
  };
}

// Registered once at module scope (not per `initRender`) — `renderClient`/
// `viewport` are read fresh inside `requestVisibleTiles` on each fire, so a
// doc swap (new worker + Viewport) is picked up automatically without
// needing to tear down and re-add listeners.
stageEl.addEventListener("scroll", debounce(requestVisibleTiles, 60), { passive: true });
window.addEventListener("resize", debounce(requestVisibleTiles, 120));

function refreshLayers(): void {
  if (!session) return;
  const layers = session.doc.layers as unknown as LocalLayer[];
  layersEl.innerHTML = "";
  for (const layer of [...layers].reverse()) {
    const card = document.createElement("div");
    card.className = "layer";

    const row = document.createElement("div");
    row.className = "row";

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = layer.visible;
    vis.title = "visible";
    vis.onchange = () => void dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { visible: vis.checked } } });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name || layer.id;
    row.append(vis, name);

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.value = String(Math.round(layer.opacity * 100));
    opacity.oninput = () => void dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { opacity: Number(opacity.value) / 100 } } });

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${layer.type} · ${layer.blendMode} · ${Math.round(layer.opacity * 100)}%`;

    card.append(row, opacity, meta);
    layersEl.append(card);
  }
}

/** Applies an op LOCALLY first via `DocSession` (instant repaint of just the
 *  dirty tiles — the whole point of this task): `session.applyLocal`
 *  advances the session's own doc copy, paints it through `renderClient`,
 *  and durably queues the op for background submission (no single-slot
 *  overwrite — rapid edits all make it to the server, in order). Any 409 or
 *  agent-driven server change is rebased onto inside `DocSession` itself. */
async function dispatch(op: Op): Promise<void> {
  if (!session) return;
  const totalStart = performance.now();
  let rect: Rect | undefined;
  let applyOpMs = 0;
  let tilesMs = 0;
  let visibleCount = 0;
  let requestedCount = 0;
  try {
    const applyStart = performance.now();
    rect = await session.applyLocal(op);
    applyOpMs = performance.now() - applyStart;
    if (renderClient && viewport) {
      const visible = viewport.visibleTiles(tileSize);
      visibleCount = visible.length;
      const dirty = visible.filter((t) => rectsOverlap(t.region, rect as Rect));
      requestedCount = dirty.length;
      if (dirty.length > 0) {
        const tilesStart = performance.now();
        await renderClient.requestTiles(dirty.map((t) => [t.tx, t.ty]));
        tilesMs = performance.now() - tilesStart;
      }
    }
  } catch (e) {
    setStatus(`local apply failed: ${(e as Error).message}`);
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

async function createFrom(bytes: Uint8Array, label: string): Promise<void> {
  setStatus(`creating from ${label}…`);
  try {
    const fd = new FormData();
    fd.append("file", new Blob([bytes as BlobPart]), label);
    const r = await fetch(`${GW}/users/${USER}/docs/${TYPE}/`, { method: "POST", body: fd });
    const body = await r.json();
    if (!body.success) throw new Error(body.error ?? "create failed");
    docId = body.docId;
    await initRender();
    setStatus(`v${session?.version} · ${docId?.slice(0, 8)} · ${label}`);
  } catch (e) {
    setStatus(`failed: ${(e as Error).message}`);
  }
}

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await createFrom(new Uint8Array(await f.arrayBuffer()), f.name);
};

saveBtn.onclick = () => {
  if (!docId) return;
  // Server export (GET) — same-origin via proxy, so the browser downloads it.
  const a = document.createElement("a");
  a.href = `${GW}/users/${USER}/docs/${TYPE}/${docId}/export`;
  a.download = "export.psd";
  a.click();
};

// --- Chat: talk directly to the PSD domain agent (Operator DO) ---

function addMsg(role: "user" | "agent" | "err", text: string, pending = false): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `msg ${role}${pending ? " pending" : ""}`;
  el.textContent = text;
  chatLog.append(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

let chatBusy = false;

/** Send a natural-language instruction to the Operator; it runs its own
 *  ReAct loop (query_/apply_ PSD tools) and mutates the document
 *  server-side. That mutation happens out from under this tab's local
 *  doc/Worker state, so on success we `session.reconcile()`: it fetches the
 *  server's new snapshot, replays any still-pending local ops on top, and
 *  warm-resets the render onto the rebased doc (keeping the Worker's pixel
 *  cache instead of a cold re-init / full-page reload). We then call
 *  `repaintAfterDocChange` to resync the canvas size (in case the agent
 *  cropped/resized) and repaint — `onRebase` already does this for the
 *  DocSession-internal parts of a rebase, but we call it again explicitly
 *  here since `reconcile()`'s promise resolving is our reliable signal that
 *  the agent's response is fully settled and it's safe to update status. */
async function sendChat(text: string): Promise<void> {
  if (!docId || chatBusy || !session) return;
  chatBusy = true;
  chatSend.disabled = true;
  addMsg("user", text);
  const thinking = addMsg("agent", "thinking…", true);
  try {
    const r = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: text }),
    });
    const body = await r.json();
    thinking.remove();
    if (!body.success) throw new Error(body.error ?? "agent run failed");
    const reply = body.data?.response;
    addMsg("agent", typeof reply === "string" && reply.trim() ? reply : "(done)");

    await session.reconcile();
    await repaintAfterDocChange(session.doc);
    setStatus(`v${session.version} · ${docId.slice(0, 8)}`);
  } catch (e) {
    thinking.remove();
    addMsg("err", (e as Error).message);
  } finally {
    chatBusy = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  void sendChat(text);
};

// Enter sends; Shift+Enter inserts a newline.
chatInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
};

// On start: upload the bundled sample and open it (creation is server-side;
// rendering from then on is local).
fetch(`${import.meta.env.BASE_URL}sample.psd`)
  .then((r) => r.arrayBuffer())
  .then((b) => createFrom(new Uint8Array(b), "sample.psd"))
  .catch((e) => setStatus(`no sample: ${(e as Error).message}`));
