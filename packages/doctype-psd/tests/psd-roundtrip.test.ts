import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";
import { save } from "../src/psd/save.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("save round-trip", () => {
  it("load → save → load preserves structure", async () => {
    const doc1 = await load(new Uint8Array(readFileSync(fixture)));
    const bytes = await save(doc1);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const doc2 = await load(bytes);
    expect(doc2.canvas).toMatchObject({ width: 256, height: 256 });
    expect(doc2.layers.map(l => l.name)).toEqual(doc1.layers.map(l => l.name));
    expect(doc2.layers.map(l => l.blendMode)).toEqual(doc1.layers.map(l => l.blendMode));
  });
});
