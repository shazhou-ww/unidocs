import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectSBlobRefs, createSBlob, decodeSValue, encodeSValue } from "@unidocs/protocol";
import type { DocumentTypeContext, SBlob, SBlobData, SValue } from "@unidocs/protocol";
import { createPsdDocumentType, type PsdStoredDoc } from "../src/doctype.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

function createMemoryContext(): DocumentTypeContext {
  const blobs = new Map<string, SBlobData>();
  return {
    async makeSBlob(
      dataOrHash: SBlobData | string,
      loadData?: () => Promise<SBlobData>,
    ): Promise<SBlob> {
      if (typeof dataOrHash === "string") {
        if (!blobs.has(dataOrHash)) {
          if (loadData === undefined) throw new Error(`SBlob ${dataOrHash} not found`);
          const loaded = await loadData();
          blobs.set(dataOrHash, loaded);
        }
        return createSBlob(dataOrHash);
      }
      const hash = createHash("sha256").update(dataOrHash.data).digest("hex");
      blobs.set(hash, dataOrHash);
      return createSBlob(hash);
    },
    async readSBlob(blob: SBlob): Promise<SBlobData> {
      const data = blobs.get(blob.hash);
      if (data === undefined) throw new Error(`SBlob ${blob.hash} not found`);
      return data;
    },
  };
}

describe("createPsdDocumentType", () => {
  const dt = createPsdDocumentType(createMemoryContext());

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

  it("uses a serializable PsdStoredDoc as TDoc", async () => {
    const doc = await dt.formats.psd.load(new Uint8Array(readFileSync(fixture)));
    const bytes = encodeSValue(doc as unknown as SValue);
    const decoded = decodeSValue(bytes) as PsdStoredDoc;

    expect(decoded.canvas).toEqual(doc.canvas);
    expect(Object.keys(collectSBlobRefs(decoded)).length).toBeGreaterThan(0);
    const layers = await dt.query({ kind: "getLayers" }, decoded) as any[];
    expect(layers.map((layer: { name: string }) => layer.name)).toContain("red-box");
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
