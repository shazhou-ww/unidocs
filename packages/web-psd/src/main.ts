// web-psd is a thin client of the UniDocs Gateway. It performs NO local
// editing/rendering — every layer list and every preview PNG comes from the
// psd worker (load/apply/render run server-side in the Editor DO).

const GW = "/gw"; // Vite proxies this to the gateway (see vite.config.ts)
const USER = "u1";
const TYPE = "psd";

let docId: string | null = null;
let version = 0;
let lastUrl: string | null = null;

const view = document.getElementById("view") as HTMLImageElement;
const layersEl = document.getElementById("layers") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;

interface LayerSummary {
  id: string; type: string; name: string; opacity: number; blendMode: string; visible: boolean;
}
type Op = { kind: string; payload: Record<string, unknown> };

function setStatus(msg: string): void { statusEl.textContent = msg; }

/** Unwrap the runtime's binary encoding: { $unidocs: { type: "bytes", base64 } }. */
function unwrapBytes(v: unknown): Uint8Array {
  const b64 = (v as { $unidocs: { base64: string } }).$unidocs.base64;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function query(kind: string): Promise<unknown> {
  const r = await fetch(`${GW}/users/${USER}/${TYPE}/${docId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  const body = await r.json();
  if (!body.success) throw new Error(body.error ?? `query ${kind} failed`);
  if (typeof body.version === "number") version = body.version;
  return body.data;
}

async function refreshView(): Promise<void> {
  const png = unwrapBytes(await query("getPreview"));
  const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
  view.src = url;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = url;
}

async function refreshLayers(): Promise<void> {
  const layers = (await query("getLayers")) as LayerSummary[];
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
    vis.onchange = () => dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { visible: vis.checked } } });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name || layer.id;
    row.append(vis, name);

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.value = String(Math.round(layer.opacity * 100));
    opacity.oninput = () => dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { opacity: Number(opacity.value) / 100 } } });

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${layer.type} · ${layer.blendMode} · ${Math.round(layer.opacity * 100)}%`;

    card.append(row, opacity, meta);
    layersEl.append(card);
  }
}

let pending: Op | null = null;
let busy = false;

/** Send an op to the server; coalesce rapid slider input into the latest op. */
async function dispatch(op: Op): Promise<void> {
  pending = op;
  if (busy) return;
  busy = true;
  try {
    while (pending) {
      const cur = pending;
      pending = null;
      const r = await fetch(`${GW}/users/${USER}/${TYPE}/${docId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: [cur], baseVersion: version }),
      });
      if (r.status === 409) {
        const e = await r.json();
        version = e.currentVersion ?? version;
        continue; // resync and retry the latest pending op
      }
      const body = await r.json();
      if (!body.success) throw new Error(body.error ?? "apply failed");
      version = body.version;
    }
    await refreshView();
    await refreshLayers();
    setStatus(`v${version} · ${docId?.slice(0, 8)}`);
  } catch (e) {
    setStatus(`edit failed: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

async function createFrom(bytes: Uint8Array, label: string): Promise<void> {
  setStatus(`creating from ${label}…`);
  try {
    const fd = new FormData();
    fd.append("file", new Blob([bytes as BlobPart]), label);
    const r = await fetch(`${GW}/users/${USER}/${TYPE}/`, { method: "POST", body: fd });
    const body = await r.json();
    if (!body.success) throw new Error(body.error ?? "create failed");
    docId = body.docId;
    version = body.version;
    await refreshView();
    await refreshLayers();
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
  a.href = `${GW}/users/${USER}/${TYPE}/${docId}/export`;
  a.download = "export.psd";
  a.click();
};

// On start: upload the bundled sample and open it (fully server-side).
fetch(`${import.meta.env.BASE_URL}sample.psd`)
  .then((r) => r.arrayBuffer())
  .then((b) => createFrom(new Uint8Array(b), "sample.psd"))
  .catch((e) => setStatus(`no sample: ${(e as Error).message}`));
