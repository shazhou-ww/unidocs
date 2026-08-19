import { initializeCanvas } from "ag-psd";

let installed = false;

/** Idempotent. Gives ag-psd a pure-JS `createImageData` so read/write needs no real canvas. */
export function installCanvasShim(): void {
  if (installed) return;
  initializeCanvas(
    () => { throw new Error("ag-psd createCanvas invoked — unexpected with useImageData reads"); },
    (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as any,
  );
  installed = true;
}
