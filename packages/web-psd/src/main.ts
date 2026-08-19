import { createPsdDocumentType, render } from "@unidocs/doctype-psd";
import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd";

const dt = createPsdDocumentType({});
let doc: PsdDoc | null = null;

const view = document.getElementById("view") as HTMLCanvasElement;
const layersEl = document.getElementById("layers") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function draw(): void {
  if (!doc) return;
  const px = render(doc);
  view.width = px.width;
  view.height = px.height;
  const ctx = view.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
}

async function dispatch(op: PsdOp): Promise<void> {
  if (!doc) return;
  doc = await dt.apply([op], doc);
  draw();
  renderLayerPanel();
}

function renderLayerPanel(): void {
  if (!doc) return;
  layersEl.innerHTML = "";
  // Top of stack first (visually top = last in array).
  for (const layer of [...doc.layers].reverse()) {
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

async function loadBytes(bytes: Uint8Array, label: string): Promise<void> {
  setStatus(`loading ${label}…`);
  try {
    doc = await dt.load(bytes);
    draw();
    renderLayerPanel();
    setStatus(`${label} · ${doc.canvas.width}×${doc.canvas.height} · ${doc.layers.length} layers`);
  } catch (e) {
    setStatus(`failed to load ${label}: ${(e as Error).message}`);
    throw e;
  }
}

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name);
};

saveBtn.onclick = async () => {
  if (!doc) return;
  const bytes = await dt.save(doc);
  const blob = new Blob([bytes as BlobPart], { type: dt.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "export.psd";
  a.click();
  URL.revokeObjectURL(url);
};

// Auto-load the bundled sample on start.
fetch(`${import.meta.env.BASE_URL}sample.psd`)
  .then((r) => r.arrayBuffer())
  .then((b) => loadBytes(new Uint8Array(b), "sample.psd"))
  .catch((e) => setStatus(`no sample: ${(e as Error).message}`));
