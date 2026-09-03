import { DocController, GW, TYPE, USER, type Op } from "../doc-controller.js";
import type { Rect } from "../doc-model.js";
import { invalidateTarget } from "./invalidate.js";
import { getState, reportError, setRegion, setState } from "./store.js";
import { putMask } from "./region.js";
import { initialZoom } from "./zoom.js";

let controller: DocController | null = null;

/** The docId that last fixed `sessionBaseVersion`. Lets `onDoc` tell "a new
 *  document was just loaded" (reset the session boundary) apart from "the
 *  same document changed under us" — a 409 rebase, an agent run, another tab
 *  — which must NOT move the boundary. `getState().doc === null` cannot make
 *  that distinction past the very first document of the page's lifetime. */
let sessionDocId: string | null = null;

export function getController(): DocController | null {
  return controller;
}

/**
 * Constructs the one DocController for this page, wiring its two callbacks
 * into the store. Idempotent: <CanvasStage> calls it from an effect, and React
 * StrictMode double-invokes effects in development.
 */
export function initController(view: HTMLCanvasElement, stage: HTMLElement): void {
  if (controller) return;
  controller = new DocController(view, stage, {
    onStatus: (status) => setState({ status }),
    // 只改阶段,不碰同一个字段里的文件名和字节数——它们是 createFrom 播下的。
    onOpenPhase: (phase) => {
      const opening = getState().opening;
      if (opening) setState({ opening: { ...opening, phase } });
    },
    onOpenFailed: (err) => reportError("打开文件失败", err),
    onDoc: (doc, version) => {
      // A doc whose id differs from the one that last fixed the boundary is
      // a NEWLY OPENED document (cold start, or a later `openFile`) — reset
      // "this session" to start here. DocController sets its own `docId`
      // field before this callback ever fires (see doc-controller.ts's
      // createFrom -> initRender), so it is already current by this point.
      const docId = controller?.docId ?? null;
      const fresh = docId !== sessionDocId;
      sessionDocId = docId;
      // Both selection axes are long-lived state and the document just moved
      // under them — see invalidate.ts. Computed from the PREVIOUS state, so
      // it has to be read before `setState` replaces it.
      const invalidation = invalidateTarget(getState(), doc as never, fresh);
      // `invalidateTarget` only ever WRITES `region: null` into this patch
      // (never a real region), so its region half is routed through
      // `setRegion` — the mask sweep lives there, and a raw `setState` would
      // silently skip it (see setRegion's docstring). The rest of the patch
      // still lands in one `setState` alongside `doc`/`version`; splitting
      // costs one extra store notification on a fresh open or a resize, not
      // on every edit.
      const { region: clearedRegion, ...restInvalidation } = invalidation;
      setState({
        doc: doc as never,
        version,
        ...(fresh ? { sessionBaseVersion: version } : {}),
        ...restInvalidation,
      });
      if ("region" in invalidation) setRegion(clearedRegion ?? null);
      // A newly opened document picks its own zoom (1:1, or shrunk if it
      // overflows the stage). Deliberately only on `fresh`: a rebase or an
      // agent edit must NOT yank the zoom out from under the user, and a
      // crop that changes the canvas size is still the same document.
      //
      // Computed here from the pure helper rather than delegated to
      // zoom-controller: that module imports THIS one for `getController`,
      // and importing it back would close a cycle. Circular ES modules
      // resolve, but they are a known way to get an `undefined` binding out
      // of a hot update — the module keeps running in a half-initialised
      // state until a full reload. There is nothing to gain from the round
      // trip anyway, since the controller is right here.
      const stage = controller?.stage;
      if (fresh && stage) {
        const zoom = initialZoom(doc.canvas, { width: stage.clientWidth, height: stage.clientHeight });
        if (zoom !== getState().zoom) setState({ zoom });
      }
    },
  });
  // No document is opened on startup. Auto-loading a bundled sample meant the
  // editor was never in its own empty state, and the first real document the
  // user opened was always a REPLACEMENT of something — which is both a
  // needless upload on every page load and the only way to see one document
  // hand over to another.
  setState({ status: "打开一个文件开始" });
}

async function createFrom(bytes: Uint8Array, label: string, mimeType?: string): Promise<void> {
  if (!controller) return;
  const before = controller.docId;
  // How many chat bubbles existed before this open. The open itself may have
  // already appended one — see the `chat` line below.
  const chatBefore = getState().chat.length;
  // `opening` 的生死归 `openFile`,不归这里、也不归 DocController:两者都在
  // `openFile` 里一并解释。
  await controller.createFrom(bytes, label, mimeType);
  // `DocController.createFrom` never rejects — it reports failure via
  // `onOpenFailed` (wired to `reportError` in `initController` below), which
  // appends a `{role:"err"}` bubble to `chat` before control ever returns
  // here. Comparing to `before` is what keeps a failed create from adopting
  // the new label: on the very first (never-yet-successful) call `docId` is
  // still `null`; when the POST itself fails it is still the previous
  // document's id, unchanged.
  //
  // The gate is deliberately coarse, and cannot be tightened from here.
  // `createFrom` assigns `docIdField` BEFORE awaiting `initRender()` (see
  // doc-controller.ts), so a create whose POST succeeded but whose render
  // then threw leaves the new docId in place and is indistinguishable, from
  // out here, from a fully successful one — the store adopts the new
  // docId/label while the canvas shows nothing, with `onOpenFailed` carrying
  // the only account of what went wrong. That is the correct trade: the
  // document does exist server-side, so pretending the previous one is still
  // open would be the bigger lie.
  if (controller.docId && controller.docId !== before) {
    // `selection`/`region` are normally cleared by `onDoc`'s fresh branch.
    // They are cleared again here for the path where `initRender` threw
    // BEFORE reaching that callback: the new docId is adopted (see the
    // comment above) while the previous document's target is still in the
    // store, pointing at layer ids that are not in any open document.
    //
    // `region` is cleared through `setRegion`, not folded into the `setState`
    // below, so its mask sweep still runs — a raw `setState({ region: null })`
    // would leave the stale mask's bytes in the module-level table forever.
    //
    // `chat` is sliced from `chatBefore`, NOT reset to `[]`: if the render
    // threw (the paragraph above), `onOpenFailed` already appended THIS
    // open's own error bubble before we got here, and a plain wipe would
    // erase it microseconds after it was written — leaving the user with
    // only the top-bar status line, the surface this project has explicitly
    // deprecated for error reporting. Slicing keeps "new document, fresh
    // transcript" for everything that predates this open while keeping
    // whatever this open itself just appended.
    setState({ docId: controller.docId, docName: label, history: [], chat: getState().chat.slice(chatBefore), selection: [] });
    setRegion(null);
  }
}

export async function openFile(file: File): Promise<void> {
  // `opening` 的生死归这里,不归 `createFrom`:如果种在 `createFrom` 里,种
  // 下去之前还要先 `await file.arrayBuffer()` —— 对这个功能存在的理由(大
  // PSD)那是秒级的分配 + 拷贝,期间没有遮罩、没有状态变化,「打开」按钮
  // 也还亮着,能在第一次打开跑到一半时再点开第二次。改成从 `File` 本身取
  // name/size(`file.size === bytes.length`,遮罩内容不变),在读之前就把
  // `opening` 种下去,再把 try/finally 一起搬上来,让它在任何路径下都清得
  // 干净——包括 `controller` 是 `null`、`createFrom` 整个是空操作的情况。
  setState({ opening: { phase: "upload", name: file.name, bytes: file.size } });
  try {
    // `file.type` 一路带下去,让服务端的 selectFormat 能用 MIME 做判断,不
    // 是只靠文件名扩展名——见 doc-controller.ts 的 createFrom 上的注释。
    await createFrom(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
  } finally {
    setState({ opening: null });
  }
}

export async function dispatch(op: Op): Promise<void> {
  await controller?.dispatch(op);
}

/** The layer → region conversion, wired into the context bar (spec §6.1).
 *  A true CONVERSION: the axes are mutually exclusive (spec §3.3), so
 *  `setRegion` takes the layer selection down as it writes the region.
 *
 *  `layerAlphaRegion` returns `null` for a layer with no extent — an
 *  adjustment layer, most notably, cannot be pointed at (spec's own framing
 *  for why this task exists in the first place). The button is not disabled
 *  for those ahead of time, so a silent no-op here would look like the click
 *  did nothing; report it the same way the other action sites do. */
export async function loadLayerAsRegion(layerId: string): Promise<void> {
  // Reports rather than rejects, so the one caller (the context bar's
  // 载入为选区 button) can clear its in-flight flag with a plain `.finally`
  // and never leave an unhandled rejection behind. A Worker-side throw comes
  // back as a rejection here exactly the way `hitTest`'s does.
  let r: { bounds: Rect; data: Uint8ClampedArray } | null | undefined;
  try {
    r = await controller?.layerAlphaRegion(layerId);
  } catch (e) {
    reportError("载入选区失败", e);
    return;
  }
  if (!r) {
    reportError("载入选区失败", "该图层没有可用于选区的像素（例如调整图层）");
    return;
  }
  // The mask BYTES have no production consumer yet: nothing outside the tests
  // calls `getMask`. They are produced now because the lasso/wand phase is
  // what reads them, and because `sweepMasks` has to have something to sweep
  // for its lifecycle to be exercised at all. Do not assume this buffer is
  // load-bearing on any current path.
  setRegion({ bounds: r.bounds, source: "layerAlpha", maskId: putMask(r.data) });
}

/** The download's filename. The server sends `Content-Disposition:
 *  attachment; filename="document.psd"`, which is the same for every
 *  document — name the file after the one on screen, with the extension
 *  swapped to whatever format was actually requested. */
export function exportFileName(docName: string | null, format: "psd" | "png"): string {
  if (!docName) return `export.${format}`;
  // `\.[^.]+$` 只在**确实有**扩展名时才替换。没有点的名字直接追加,否则
  // 「summer sale」这种名字会被当成扩展名切掉一半。
  return /\.[^.]+$/.test(docName)
    ? docName.replace(/\.[^.]+$/, `.${format}`)
    : `${docName}.${format}`;
}

/**
 * Downloads the document as a PSD.
 *
 * Deliberately NOT an `<a href>` pointing at `/export`, which is what this
 * used to be. Export is served from the SERVER's copy of the document, while
 * edits are applied locally first and submitted by a background drain
 * (`DocSession`) — so at any moment the browser's document is "the server's
 * version plus a queue of ops it hasn't accepted yet". A plain link navigates
 * without running a line of JS, giving the app no chance to close that gap:
 * clicking 导出 right after an edit downloaded a file missing it.
 *
 * So: flush the queue first, then fetch the bytes and hand them to a
 * synthesized download. A failed flush aborts the export outright — a file
 * silently missing the edit that just failed to submit is worse than no file.
 */
export async function exportDoc(format: "psd" | "png" = "psd"): Promise<void> {
  const c = controller;
  const id = c?.docId;
  if (!c || !id) return;
  setState({ exporting: true });
  try {
    await c.flush();
    // psd 走**不带查询串**的老 URL,与改动前逐字节一致——服务端不传 format
    // 时回落 defaultFormat,两条路等价,但保持 URL 不变让这次改动在网络层面
    // 对既有行为零影响。
    const query = format === "psd" ? "" : `?format=${format}`;
    const res = await fetch(`${GW}/tenants/${USER}/docs/${TYPE}/${id}/export${query}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(getState().docName, format);
    // Firefox only acts on `click()` for an anchor that is in the document.
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked a task later, not synchronously: `click()` only QUEUES the
    // navigation to the blob URL, so revoking on this tick can cancel the
    // download it just started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) {
    reportError("导出失败", e);
  } finally {
    setState({ exporting: false });
  }
}
