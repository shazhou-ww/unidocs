import { DocController, GW, TYPE, USER, type Op } from "../doc-controller.js";
import { getState, setState } from "./store.js";
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
    onDoc: (doc, version) => {
      // A doc whose id differs from the one that last fixed the boundary is
      // a NEWLY OPENED document (cold start, or a later `openFile`) — reset
      // "this session" to start here. DocController sets its own `docId`
      // field before this callback ever fires (see doc-controller.ts's
      // createFrom -> initRender), so it is already current by this point.
      const docId = controller?.docId ?? null;
      const fresh = docId !== sessionDocId;
      sessionDocId = docId;
      setState({
        doc: doc as never,
        version,
        ...(fresh ? { sessionBaseVersion: version } : {}),
      });
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
  void bootstrap();
}

/** Uploads the bundled sample and opens it — same cold start as before the
 *  redesign (creation is server-side; rendering is local from then on). */
async function bootstrap(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}sample.psd`);
    await createFrom(new Uint8Array(await r.arrayBuffer()), "sample.psd");
  } catch (e) {
    setState({ status: `no sample: ${(e as Error).message}` });
  }
}

async function createFrom(bytes: Uint8Array, label: string): Promise<void> {
  if (!controller) return;
  const before = controller.docId;
  await controller.createFrom(bytes, label);
  // `DocController.createFrom` never rejects — it reports failure only via
  // `onStatus`. Comparing to `before` is what keeps a failed create from
  // adopting the new label: on the very first (never-yet-successful) call
  // `docId` is still `null`; when the POST itself fails it is still the
  // previous document's id, unchanged.
  //
  // The gate is deliberately coarse, and cannot be tightened from here.
  // `createFrom` assigns `docIdField` BEFORE awaiting `initRender()` (see
  // doc-controller.ts), so a create whose POST succeeded but whose render
  // then threw leaves the new docId in place and is indistinguishable, from
  // out here, from a fully successful one — the store adopts the new
  // docId/label while the canvas shows nothing, with `onStatus` carrying the
  // only account of what went wrong. That is the correct trade: the document
  // does exist server-side, so pretending the previous one is still open
  // would be the bigger lie.
  if (controller.docId && controller.docId !== before) {
    setState({ docId: controller.docId, docName: label, history: [], chat: [] });
  }
}

export async function openFile(file: File): Promise<void> {
  await createFrom(new Uint8Array(await file.arrayBuffer()), file.name);
}

export async function dispatch(op: Op): Promise<void> {
  await controller?.dispatch(op);
}

export function exportUrl(): string | null {
  const id = controller?.docId;
  return id ? `${GW}/tenants/${USER}/docs/${TYPE}/${id}/export` : null;
}
