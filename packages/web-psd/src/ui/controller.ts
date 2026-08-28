import { DocController, GW, TYPE, USER, type Op } from "../doc-controller.js";
import { getState, setState } from "./store.js";

let controller: DocController | null = null;

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
      // The FIRST doc we ever see fixes "this session"'s baseline: everything
      // above it is what the user did in this tab (see opsSinceSession).
      const fresh = getState().doc === null;
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
  await controller.createFrom(bytes, label);
  setState({ docId: controller.docId, docName: label, history: [], chat: [] });
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
