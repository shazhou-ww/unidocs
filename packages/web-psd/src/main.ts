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
const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const chatSend = document.getElementById("chat-send") as HTMLButtonElement;

interface LayerSummary {
  id: string; type: string; name: string; opacity: number; blendMode: string; visible: boolean;
}
type Op = { kind: string; payload: Record<string, unknown> };

function setStatus(msg: string): void { statusEl.textContent = msg; }

/** Decode a base64 string into raw bytes. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function query(kind: string, payload?: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${GW}/users/${USER}/${TYPE}/${docId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ? { kind, payload } : { kind }),
  });
  const body = await r.json();
  if (!body.success) throw new Error(body.error ?? `query ${kind} failed`);
  if (typeof body.version === "number") version = body.version;
  return body.data;
}

async function refreshView(): Promise<void> {
  // getPreview returns { $image: { base64, mediaType }, width, height, region }.
  // Pass a large maxSize so the viewer gets a full-resolution render (the
  // agent, which omits maxSize, gets a downscaled preview instead).
  const res = await query("getPreview", { maxSize: 8192 }) as { $image: { base64: string } };
  const png = b64ToBytes(res.$image.base64);
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
 *  ReAct loop (query_/apply_ PSD tools) and mutates the document server-side. */
async function sendChat(text: string): Promise<void> {
  if (!docId || chatBusy) return;
  chatBusy = true;
  chatSend.disabled = true;
  addMsg("user", text);
  const thinking = addMsg("agent", "thinking…", true);
  try {
    const r = await fetch(`${GW}/users/${USER}/${TYPE}/${docId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: text }),
    });
    const body = await r.json();
    thinking.remove();
    if (!body.success) throw new Error(body.error ?? "agent run failed");
    const reply = body.data?.response;
    addMsg("agent", typeof reply === "string" && reply.trim() ? reply : "(done)");
    // The agent may have applied ops — resync the view, layers, and version.
    await refreshView();
    await refreshLayers();
    setStatus(`v${version} · ${docId?.slice(0, 8)}`);
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

// On start: upload the bundled sample and open it (fully server-side).
fetch(`${import.meta.env.BASE_URL}sample.psd`)
  .then((r) => r.arrayBuffer())
  .then((b) => createFrom(new Uint8Array(b), "sample.psd"))
  .catch((e) => setStatus(`no sample: ${(e as Error).message}`));
