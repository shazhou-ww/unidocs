import { writePsd, readPsd, initializeCanvas } from "ag-psd";
import { writeFileSync, readFileSync } from "node:fs";

// SPIKE: prove ag-psd read needs only a pure-JS data container, no real canvas.
// createCanvas is deliberately a throwing stub — if read trips it, we need a real canvas.
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
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

const W = 256;
const H = 256;

// A minimal but representative doc: 8-bit RGB, two named layers,
// distinct opacity + blend mode, second layer offset with its own bounds.
const psd = {
  width: W,
  height: H,
  children: [
    {
      name: "background",
      opacity: 255,
      blendMode: "normal",
      imageData: solid(W, H, [40, 80, 160]),
    },
    {
      name: "red-box",
      opacity: 200,
      blendMode: "multiply",
      left: 64,
      top: 64,
      right: 192,
      bottom: 192,
      imageData: solid(128, 128, [220, 40, 40, 255]),
    },
  ],
  // Provide the composite so writing never needs a canvas to flatten layers.
  imageData: solid(W, H, [40, 80, 160]),
};

const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
writeFileSync("sample.psd", Buffer.from(buffer));
console.log(`✓ wrote sample.psd (${buffer.byteLength} bytes)`);

// Round-trip verify: read it back the way the DO spike will (useImageData, no canvas).
const back = readPsd(readFileSync("sample.psd"), {
  useImageData: true,
  skipThumbnail: true,
});
console.log("✓ read back:", back.width + "x" + back.height, "bit-depth-ok");
console.log(
  "  layers:",
  back.children?.map((c) => `${c.name}(op=${c.opacity},blend=${c.blendMode})`).join(", ")
);
