import { DocController, GW, TYPE, USER, type Op } from "../doc-controller.js";
import { getState, setState } from "./store.js";

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
  // `onStatus` — and on failure it leaves `docId` exactly as it found it: on
  // the very first (never-yet-successful) call that's `null`; on a LATER
  // failed call it's the previous document's id, unchanged (`docIdField` is
  // only ever assigned on success — see doc-controller.ts's createFrom).
  // Comparing to `before` catches both: a failed create must not adopt the
  // new label onto a docId that didn't actually change.
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
