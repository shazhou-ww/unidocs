// web-psd renders locally in the browser via @unidocs/psd-client: a Worker
// holds a persistent RenderCore (IncrementalCompositor + PixelCache) over the
// doc's lazy CAS-backed pixels, so after the cold-start load, every layer
// edit re-composites only the dirty tiles in-process — no per-edit
// full-canvas getPreview round trip to the gateway (that used to cost ~10s).
//
// The gateway is still the source of truth: every op is also fired at
// `/apply` in the background (best-effort; 409 just reloads for now — real
// rebase is Plan 5), and export/chat still go straight to the server.

import { CasBlobStore, loadDoc, RenderClient, Viewport } from "@unidocs/psd-client";

const GW = "/gw"; // Vite proxies this to the gateway (see vite.config.ts)
const USER = "u1";
const TYPE = "psd";

let docId: string | null = null;
let version = 0;

// Local render state: `doc` is this tab's own deserialized copy (used for the
// layers panel + layer-property patches), `renderClient`/`viewport` drive the
// resident Worker + canvas. `tileSize` comes back from the Worker's `init`
// ack once the doc is loaded.
let doc: Awaited<ReturnType<typeof loadDoc>>["doc"] | null = null;
let renderClient: RenderClient | null = null;
let viewport: Viewport | null = null;
let currentWorker: Worker | null = null;
let tileSize = 256;

const view = document.getElementById("view") as HTMLCanvasElement;
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

function findLocalLayer(layers: LocalLayer[], id: string): LocalLayer | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLocalLayer(l.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Fetches the doc's current snapshot hash + raw IR bytes (separately from
 *  `loadDoc`, which deserializes its own copy for this tab's local `doc`) —
 *  the Worker needs its own `Uint8Array` because `RenderClient.init`
 *  transfers (detaches) the buffer it's handed. */
async function fetchIrBytes(store: CasBlobStore): Promise<Uint8Array> {
  const r = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/snapshot`);
  if (!r.ok) throw new Error(`snapshot fetch failed: ${r.status}`);
  const snap = (await r.json()) as { hash: string };
  const ir = await store.get(snap.hash);
  if (!ir) throw new Error(`IR blob missing for hash "${snap.hash}"`);
  return ir;
}

/** Cold-starts local rendering for `docId`: loads this tab's own doc copy
 *  (for the layers panel), spins up a fresh render Worker with the IR bytes,
 *  sizes the canvas to the doc, and paints the full first frame. */
async function initRender(): Promise<void> {
  if (!docId) return;
  setStatus(`loading v${version} · ${docId.slice(0, 8)}…`);

  const store = new CasBlobStore({ gw: GW, user: USER });
  const [{ doc: d, version: v }, ir] = await Promise.all([
    loadDoc({ gw: GW, user: USER, type: TYPE, docId, store }),
    fetchIrBytes(store),
  ]);
  doc = d;
  version = v;

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
  const init = await renderClient.init({ ir, gw: GW, user: USER, cacheBytes });
  tileSize = init.tileSize;

  view.width = init.canvas.width;
  view.height = init.canvas.height;

  viewport = new Viewport(view);
  viewport.setDoc(init.canvas);

  const tiles = viewport.visibleTiles(tileSize);
  if (tiles.length > 0) await renderClient.requestTiles(tiles.map((t) => [t.tx, t.ty]));

  refreshLayers();
  setStatus(`v${version} · ${docId.slice(0, 8)}`);
}

function refreshLayers(): void {
  if (!doc) return;
  const layers = doc.layers as unknown as LocalLayer[];
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

/** Patches this tab's local `doc` copy so the layers panel + subsequent
 *  dirty-rect math stay consistent with what was just applied locally
 *  (the Worker's own resident doc is authoritative for rendering; this is
 *  just this tab's mirror of visible/opacity for UI purposes). */
function patchLocalLayer(op: Op): void {
  if (!doc || op.kind !== "set_props") return;
  const { layerId, props } = op.payload as { layerId?: string; props?: Record<string, unknown> };
  if (!layerId || !props) return;
  const layer = findLocalLayer(doc.layers as unknown as LocalLayer[], layerId);
  if (!layer) return;
  if (typeof props.visible === "boolean") layer.visible = props.visible;
  if (typeof props.opacity === "number") layer.opacity = props.opacity;
}

// --- Background server sync: best-effort, coalesced so rapid slider input
// doesn't fire one /apply per tick (each would race the others' baseVersion
// and likely 409). Never blocks local paint. ---
let syncPending: Op | null = null;
let syncBusy = false;

function syncOpToServer(op: Op): void {
  syncPending = op;
  if (syncBusy) return;
  syncBusy = true;
  void (async () => {
    try {
      while (syncPending) {
        const cur = syncPending;
        syncPending = null;
        const r = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/apply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operations: [cur], baseVersion: version }),
        });
        if (r.status === 409) {
          // Local optimistic edits have diverged from the server's canonical
          // version. Real rebase is Plan 5 (DocSession); for now just reload
          // to resync from the server's current snapshot.
          location.reload();
          return;
        }
        const body = await r.json();
        if (!body.success) throw new Error(body.error ?? "apply failed");
        version = body.version;
      }
      setStatus(`v${version} · ${docId?.slice(0, 8)}`);
    } catch (e) {
      setStatus(`server sync failed: ${(e as Error).message}`);
    } finally {
      syncBusy = false;
    }
  })();
}

/** Applies an op LOCALLY first (instant repaint of just the dirty tiles —
 *  the whole point of this task), then fires the same op at the server in
 *  the background without waiting for it. */
async function dispatch(op: Op): Promise<void> {
  patchLocalLayer(op);
  if (renderClient && viewport) {
    try {
      const rect = await renderClient.applyOp(op);
      const dirty = viewport.visibleTiles(tileSize).filter((t) => rectsOverlap(t.region, rect));
      if (dirty.length > 0) await renderClient.requestTiles(dirty.map((t) => [t.tx, t.ty]));
    } catch (e) {
      setStatus(`local apply failed: ${(e as Error).message}`);
    }
  }
  syncOpToServer(op);
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
    version = body.version;
    await initRender();
    setStatus(`v${version} · ${docId?.slice(0, 8)} · ${label}`);
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
 *  ReAct loop (query_/apply_ PSD tools) and mutates the document server-side.
 *  That mutation happens out from under this tab's local doc/Worker state, so
 *  we just reload — Plan 5 does incremental reconcile instead. */
async function sendChat(text: string): Promise<void> {
  if (!docId || chatBusy) return;
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
    location.reload();
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
