import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocumentTypeContext } from "@unidocs/core";
import { createPsdDocumentType } from "../src/doctype.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

const dummyCtx: DocumentTypeContext = {
  async makeSBlob() {
    throw new Error("dummy ctx: makeSBlob not used by these tests");
  },
  async readSBlob() {
    throw new Error("dummy ctx: readSBlob not used by these tests");
  },
};

describe("createPsdDocumentType", () => {
  const dt = createPsdDocumentType(dummyCtx);

  it("init makes an empty doc", async () => {
    const d = await dt.init();
    expect(d.layers).toEqual([]);
    expect(d.canvas.colorMode).toBe("RGB");
  });

  it("load → apply → query flows through", async () => {
    const doc = await dt.formats.psd.load(new Uint8Array(readFileSync(fixture)));
    const doc2 = await dt.apply([{ kind: "set_props", payload: { layerId: doc.layers[1].id, props: { opacity: 0.5 } } }], doc);
    const layers = await dt.query({ kind: "getLayers" }, doc2) as any[];
    expect(layers.find((l: { name: string }) => l.name === "red-box").opacity).toBe(0.5);
  });

  it("exposes prefixed tool names for name-prefix routing + contentType", () => {
    expect(dt.contentType).toBe("image/vnd.adobe.photoshop");
    expect(dt.tools.add_layer.name).toBe("apply_add_layer");
    expect((dt.tools.add_layer as any).op).toBeUndefined();
    expect(dt.tools.getLayers.name).toBe("query_getLayers");
    expect((dt.tools.getLayers as any).op).toBeUndefined();
  });

  it("has no resolve, serialize/deserialize, or refsFrom* hooks", () => {
    expect((dt as any).refsFromSnapshot).toBeUndefined();
    expect((dt as any).refsFromOp).toBeUndefined();
    expect((dt as any).serialize).toBeUndefined();
    expect((dt as any).deserialize).toBeUndefined();
    expect((dt as any).resolve).toBeUndefined();
  });
});
