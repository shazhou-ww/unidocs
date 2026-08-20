import { writePsd, readPsd, initializeCanvas } from "ag-psd";
import { writeFileSync, readFileSync } from "node:fs";

// ag-psd read needs only a pure-JS data container, no real canvas.
initializeCanvas(
  (w = 1, h = 1) => {
    throw new Error(`createCanvas(${w},${h}) invoked — NOT expected for useImageData read`);
  },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
);

/** Build a solid-color RGBA image buffer usable as ag-psd imageData. */
function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

const W = 256, H = 256;
const BG = [40, 80, 160];
const RED = [220, 40, 40];
const RED_BOX = { top: 64, left: 64, bottom: 192, right: 192 };
// ag-psd opacity is a 0..1 float (NOT 0..255). Use the same value for the
// layer and the hand-computed oracle so they agree.
const REDA = 200 / 255; // red-box layer opacity ≈ 0.784

// Layers exercising the format features most prone to silent loss:
//  - a blend mode (multiply) with reduced opacity + its own offset bounds
//  - fillOpacity:0 (the "invisible fill" that must contribute NOTHING)
const psd = {
  width: W, height: H,
  children: [
    { name: "background", opacity: 1, blendMode: "normal", imageData: solid(W, H, BG) },
    {
      name: "red-box", opacity: REDA, blendMode: "multiply",
      ...RED_BOX, imageData: solid(128, 128, RED),
    },
    {
      // fill:0 → Photoshop draws nothing (no effects here). If the renderer
      // ignores fillOpacity, this opaque white slab reappears and the fidelity
      // diff spikes — catching exactly the regression class we hit before.
      name: "ghost-fill", opacity: 1, blendMode: "normal", fillOpacity: 0,
      top: 0, left: 0, bottom: 256, right: 32, imageData: solid(32, 256, [255, 255, 255]),
    },
  ],
  // INDEPENDENT ground-truth composite: hand-computed flatten (NOT our renderer,
  // so the fixture is a real oracle). bg everywhere; multiply+opacity in the red
  // box; the fill:0 slab contributes nothing.
  imageData: (() => {
    const out = solid(W, H, BG);
    for (let y = RED_BOX.top; y < RED_BOX.bottom; y++) {
      for (let x = RED_BOX.left; x < RED_BOX.right; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const m = (BG[c] * RED[c]) / 255;            // multiply blend
          out.data[i + c] = Math.round(BG[c] * (1 - REDA) + m * REDA); // opacity as normal-over
        }
      }
    }
    return out;
  })(),
};

const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
writeFileSync(new URL("./sample.psd", import.meta.url), Buffer.from(buffer));
console.log(`✓ wrote sample.psd (${buffer.byteLength} bytes)`);

const back = readPsd(readFileSync(new URL("./sample.psd", import.meta.url)), { useImageData: true, skipThumbnail: true });
console.log("✓ read back:", back.width + "x" + back.height,
  "layers:", back.children?.map((c) => `${c.name}(op=${c.opacity},blend=${c.blendMode},fill=${c.fillOpacity})`).join(", "));
