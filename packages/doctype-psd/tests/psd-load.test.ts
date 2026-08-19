import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("load", () => {
  it("reads sample.psd into PsdDoc", async () => {
    const doc = await load(new Uint8Array(readFileSync(fixture)));
    expect(doc.canvas).toMatchObject({ width: 256, height: 256, colorMode: "RGB", depth: 8 });
    expect(doc.layers.map(l => l.name)).toEqual(["background", "red-box"]);
    const red = doc.layers.find(l => l.name === "red-box")!;
    expect(red.blendMode).toBe("multiply");
    expect(red.type).toBe("raster");
    expect(red.pixels?.width).toBe(128);
  });
});
