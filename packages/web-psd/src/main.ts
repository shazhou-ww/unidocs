// Thin UI shell over `DocController` (see doc-controller.ts for the render/
// sync orchestration this used to contain). This file is DOM wiring only:
// element lookups, the layers panel, the file input, the export button, and
// the chat form — all delegating to the controller.

import type { DocSession } from "@unidocs/psd-client";
import { DocController, GW, TYPE, USER } from "./doc-controller.js";
import type { LocalLayer } from "./doc-model.js";

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

function setStatus(msg: string): void { statusEl.textContent = msg; }

const controller = new DocController(view, stageEl, {
  onStatus: setStatus,
  onDoc: (_doc: DocSession["doc"], _version: number) => refreshLayers(),
});

function refreshLayers(): void {
  const doc = controller.doc;
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
    vis.onchange = () => void controller.dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { visible: vis.checked } } });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name || layer.id;
    row.append(vis, name);

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.value = String(Math.round(layer.opacity * 100));
    opacity.oninput = () => void controller.dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { opacity: Number(opacity.value) / 100 } } });

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${layer.type} · ${layer.blendMode} · ${Math.round(layer.opacity * 100)}%`;

    card.append(row, opacity, meta);
    layersEl.append(card);
  }
}

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await controller.createFrom(new Uint8Array(await f.arrayBuffer()), f.name);
};

saveBtn.onclick = () => {
  const docId = controller.docId;
  if (!docId) return;
  // Server export (GET) — same-origin via proxy, so the browser downloads it.
  const a = document.createElement("a");
  a.href = `${GW}/tenants/${USER}/docs/${TYPE}/${docId}/export`;
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
 *  doc/Worker state, so on success we `controller.reconcile()`: it fetches
 *  the server's new snapshot, replays any still-pending local ops on top,
 *  warm-resets the render onto the rebased doc (keeping the Worker's pixel
 *  cache instead of a cold re-init / full-page reload), and resyncs the
 *  canvas size (in case the agent cropped/resized) before repainting. */
async function sendChat(text: string): Promise<void> {
  const docId = controller.docId;
  if (!docId || chatBusy) return;
  chatBusy = true;
  chatSend.disabled = true;
  addMsg("user", text);
  const thinking = addMsg("agent", "thinking…", true);
  try {
    const r = await fetch(`${GW}/tenants/${USER}/docs/${TYPE}/${docId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: text }),
    });
    const body = await r.json();
    thinking.remove();
    if (!body.success) throw new Error(body.error ?? "agent run failed");
    const reply = body.data?.response;
    addMsg("agent", typeof reply === "string" && reply.trim() ? reply : "(done)");

    await controller.reconcile();
    setStatus(`v${controller.version} · ${docId.slice(0, 8)}`);
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
  .then((b) => controller.createFrom(new Uint8Array(b), "sample.psd"))
  .catch((e) => setStatus(`no sample: ${(e as Error).message}`));
