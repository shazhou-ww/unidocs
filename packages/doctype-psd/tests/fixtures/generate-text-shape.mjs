// Separate from generate.mjs on purpose: sample.psd's layer names and its
// hand-computed composite oracle are asserted verbatim by psd-load.test.ts,
// fidelity.test.ts and psd-roundtrip.test.ts. Adding a layer there would
// break all three, so text/shape fidelity gets its own fixture.
import { writePsd, readPsd, initializeCanvas } from "ag-psd";
import { writeFileSync, readFileSync } from "node:fs";

initializeCanvas(
  (w = 1, h = 1) => { throw new Error(`createCanvas(${w},${h}) invoked — NOT expected for useImageData read`); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

const W = 256, H = 256;
const psd = {
  width: W, height: H,
  children: [
    { name: "bg", opacity: 1, blendMode: "normal", imageData: solid(W, H, [238, 236, 231]) },
    {
      name: "headline", opacity: 1, blendMode: "normal",
      top: 20, left: 20, bottom: 60, right: 220,
      imageData: solid(200, 40, [28, 29, 26]),
      text: {
        text: "Midsummer Sale",
        transform: [1, 0, 0, 1, 20, 52],
        style: { font: { name: "Barlow-Bold" }, fontSize: 32, fillColor: { r: 28, g: 29, b: 26 } },
      },
    },
  ],
  imageData: solid(W, H, [238, 236, 231]),
};

const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
writeFileSync(new URL("./text-shape.psd", import.meta.url), Buffer.from(buffer));
console.log(`✓ wrote text-shape.psd (${buffer.byteLength} bytes)`);

const back = readPsd(readFileSync(new URL("./text-shape.psd", import.meta.url)), { useImageData: true, skipThumbnail: true });
console.log("✓ read back layers:", back.children?.map((c) => `${c.name}(text=${JSON.stringify(c.text?.text)})`).join(", "));
