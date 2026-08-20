import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPsdDocumentType } from "../src/doctype.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

describe("createPsdDocumentType", () => {
  const dt = createPsdDocumentType();

  it("init makes an empty doc", async () => {
    const d = await dt.init();
    expect(d.layers).toEqual([]);
    expect(d.canvas.colorMode).toBe("RGB");
  });

  it("load → apply → query flows through", async () => {
    const doc = await dt.load(new Uint8Array(readFileSync(fixture)));
    const doc2 = await dt.apply([{ kind: "set_props", payload: { layerId: doc.layers[1].id, props: { opacity: 0.5 } } }], doc);
    const layers = await dt.query({ kind: "getLayers" }, doc2) as any[];
    expect(layers.find(l => l.name === "red-box").opacity).toBe(0.5);
  });

  it("exposes clean tool names with op routing metadata + contentType", () => {
    expect(dt.contentType).toBe("image/vnd.adobe.photoshop");
    expect(dt.tools.add_layer.name).toBe("addLayer");
    expect(dt.tools.add_layer.op).toEqual({ mode: "apply", kind: "add_layer" });
    expect(dt.tools.getLayers.name).toBe("getLayers");
    expect(dt.tools.getLayers.op).toEqual({ mode: "query", kind: "getLayers" });
  });
});
