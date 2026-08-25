/**
 * Memory probe for the PSD Editor DO's resident render state.
 *
 * `DocRenderState` keeps a PixelCache, an incremental compositor and a frame
 * cache alive for the lifetime of an Editor DO instance. The budgets were
 * chosen on paper against a Durable Object's 128 MB isolate; this drives a
 * REAL workerd (via Miniflare, the same runtime `pnpm dev` uses) through an
 * agent-shaped request sequence on a real PSD and samples the workerd
 * process's RSS at each step.
 *
 * Caveat, stated up front: workerd exposes no in-isolate memory API, and
 * Miniflare does not enforce the production 128 MB per-isolate cap. So this
 * measures the RSS of the whole workerd process — gateway + CAS + PSD workers
 * together — not one isolate's accounted heap. What it can show is the DELTA
 * a document's render state adds and whether it plateaus or grows without
 * bound; compare runs across a code change rather than reading any single
 * absolute number as "the isolate's usage".
 *
 * Usage:
 *   node scripts/psd-do-memory-probe.mjs [path/to/file.psd] [--previews N]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { startLocalRuntime } from "./local-runtime.mjs";

const DEFAULT_PSD = "/Users/yanjiayi/Downloads/landing-page-capture-yourself-theme/4414025.psd";

const args = process.argv.slice(2);
const previewsIdx = args.indexOf("--previews");
const PREVIEWS = previewsIdx >= 0 ? Number(args[previewsIdx + 1]) : 12;
const psdPath = args.find((a) => !a.startsWith("--") && a !== String(PREVIEWS)) ?? DEFAULT_PSD;

if (!existsSync(psdPath)) {
  console.error(`no such PSD: ${psdPath}`);
  process.exit(1);
}

/** RSS in MB of every live workerd process, keyed by pid. */
function workerdProcs() {
  const out = execFileSync("ps", ["-Ao", "pid=,rss=,comm="], { encoding: "utf8" });
  const procs = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    if (!m[3].includes("workerd")) continue;
    procs.set(Number(m[1]), Number(m[2]) / 1024);
  }
  return procs;
}

const before = new Set(workerdProcs().keys());

const USER = "u1";
const TYPE = "psd";
const PORTS = { gateway: 18987, psd: 18988, cas: 18990 };

const runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
const GW = runtime.urls.gateway;

// The workerd process Miniflare just spawned (whichever pid is new).
await new Promise((r) => setTimeout(r, 500));
let pid = [...workerdProcs().keys()].find((p) => !before.has(p));
if (pid === undefined) {
  // Only one workerd around: assume it is ours.
  const all = [...workerdProcs().keys()];
  pid = all.length === 1 ? all[0] : undefined;
}
if (pid === undefined) {
  console.error("could not identify the workerd process — is another one running?");
  await runtime.dispose();
  process.exit(1);
}

const samples = [];
function sample(label) {
  const rss = workerdProcs().get(pid);
  if (rss === undefined) throw new Error("workerd went away mid-probe");
  samples.push({ label, rss });
  console.log(`  ${label.padEnd(46)} RSS ${rss.toFixed(1)} MB`);
  return rss;
}

async function query(docId, payload) {
  const res = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`query ${JSON.stringify(payload)} -> ${res.status} ${await res.text()}`);
  return res.json();
}

let version = 0;
async function applyOp(docId, op) {
  const res = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations: [op], description: `probe ${op.kind}`, baseVersion: version }),
  });
  if (!res.ok) throw new Error(`apply -> ${res.status} ${await res.text()}`);
  const body = await res.json();
  version = body.version ?? body.data?.version ?? version + 1;
  return body;
}

try {
  console.log(`\nPSD: ${psdPath}`);
  console.log(`workerd pid ${pid}\n`);

  sample("runtime up, no document");

  const bytes = readFileSync(psdPath);
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), "probe.psd");
  const created = await fetch(`${GW}/users/${USER}/docs/${TYPE}/`, { method: "POST", body: fd });
  const createdBody = await created.json();
  if (!createdBody.success) throw new Error(`create failed: ${JSON.stringify(createdBody)}`);
  const docId = createdBody.docId;
  console.log(`doc ${docId} (${(bytes.length / 1024 / 1024).toFixed(1)} MB PSD)\n`);
  sample("after import (load + store to CAS)");

  // Import already produced version 1; start the op loop from wherever we are.
  const irRes = await fetch(`${GW}/users/${USER}/docs/${TYPE}/${docId}/ir`);
  version = Number(irRes.headers.get("X-Doc-Version") ?? "0");
  await irRes.arrayBuffer();

  const layersRes = await query(docId, { kind: "getLayers" });
  const layers = layersRes.data ?? layersRes;
  const ids = (Array.isArray(layers) ? layers : []).map((l) => l.id);
  console.log(`  ${ids.length} top-level layers\n`);

  // Deliberately the DEFAULTS, with no maxSize: that combination used to 500
  // with `string exceeds 1048576 UTF-8 bytes`, so exercising it here is also
  // the end-to-end regression check for the preview byte cap.
  const FULL = { kind: "getPreview", payload: {} };

  await query(docId, FULL);
  sample("first full getPreview (cold)");

  await query(docId, FULL);
  sample("repeat full getPreview (unchanged doc)");

  // Agent-shaped loop: preview a region, edit a layer, preview again.
  // Elapsed time is recorded alongside RSS because it is a far less noisy
  // signal of WHICH render path ran — a rect preview that composites the whole
  // canvas and crops takes ~3x one that composites straight into the rect.
  const rectMs = [];
  for (let i = 0; i < PREVIEWS; i++) {
    const id = ids[i % ids.length];
    let s = performance.now();
    await query(docId, { kind: "getPreview", payload: { rect: [0, 0, 512, 512] } });
    rectMs.push(performance.now() - s);
    await applyOp(docId, { kind: "set_props", payload: { layerId: id, props: { visible: i % 2 === 0 ? false : true } } });
    s = performance.now();
    await query(docId, { kind: "getPreview", payload: { rect: [200, 200, 900, 900] } });
    rectMs.push(performance.now() - s);
    if (i % 4 === 3) sample(`after ${i + 1} edit+preview rounds`);
  }
  const sortedMs = [...rectMs].sort((a, b) => a - b);
  console.log(`\n  rect previews: n=${rectMs.length} median=${sortedMs[sortedMs.length >> 1].toFixed(0)}ms total=${rectMs.reduce((a, b) => a + b, 0).toFixed(0)}ms\n`);

  await query(docId, FULL);
  sample("full getPreview after the edit loop");

  const base = samples[0].rss;
  const peak = Math.max(...samples.map((s) => s.rss));
  const last = samples[samples.length - 1].rss;
  const steady = samples.filter((s) => s.label.startsWith("after ") && s.label.includes("rounds")).map((s) => s.rss);
  console.log(`
  baseline (no doc)      ${base.toFixed(1)} MB
  peak                   ${peak.toFixed(1)} MB   (+${(peak - base).toFixed(1)} MB over baseline)
  final                  ${last.toFixed(1)} MB
  steady-state samples   ${steady.map((n) => n.toFixed(0)).join(" -> ")} MB`);
  if (steady.length >= 2) {
    const drift = steady[steady.length - 1] - steady[0];
    console.log(`  drift across the loop  ${drift >= 0 ? "+" : ""}${drift.toFixed(1)} MB`);
  }
  console.log(`
  Read the RSS numbers as a band, not a value: workerd does not return freed
  pages to the OS promptly and these samples swing by >1 GB between GCs on the
  same code. The rect-preview timings above are the reliable signal of which
  render path ran; use RSS only to compare final/peak across two runs.`);
  console.log("");
} finally {
  await runtime.dispose();
}
