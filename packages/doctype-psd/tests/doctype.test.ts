import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectSBlobRefs, decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import type { DocumentTypeContext, SValue } from "@unidocs/protocol";
import { createPsdDocumentType, type PsdStoredDoc } from "../src/doctype.js";
import { psdAgent } from "../src/agent.js";
import { createMemorySBlobContext } from "./sblob-test-context.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

function createMemoryContext(): DocumentTypeContext {
  return createMemorySBlobContext().ctx;
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

  it("exposes the un-prefixed tool table + contentType", () => {
    expect(dt.contentType).toBe("image/vnd.adobe.photoshop");
    // 工具表挂在 DocumentAgent 上，不在 DocumentType 上 —— DocumentType.tools
    // 是有意删掉的旧契约。这条守的还是原来那三件事：两个代表性工具名在，
    // 且没有任何 query_ / apply_ 前缀。
    const names = psdAgent.tools.map(t => t.name);
    expect(names).toContain("addLayer");
    expect(names).toContain("getLayers");
    expect(names.some(n => n.startsWith("query_") || n.startsWith("apply_"))).toBe(false);
  });

  it("has no resolve, serialize/deserialize, or refsFrom* hooks", () => {
    expect((dt as any).refsFromSnapshot).toBeUndefined();
    expect((dt as any).refsFromOp).toBeUndefined();
    expect((dt as any).serialize).toBeUndefined();
    expect((dt as any).deserialize).toBeUndefined();
    expect((dt as any).resolve).toBeUndefined();
  });
});
