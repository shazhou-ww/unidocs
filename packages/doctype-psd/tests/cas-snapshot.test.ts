import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { collectSBlobRefs, createSBlob } from "@unidocs/doctype-server-common";
import type { DocumentTypeContext, SBlob, SBlobData } from "@unidocs/protocol";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { isRef, resolvePixels, PixelCache } from "../src/render/pixel-source.js";
import { render } from "../src/render/index.js";
import { casBlobStore } from "../src/psd/cas-blobstore.js";
import { saveSnapshot, loadSnapshot, refsFromSnapshot } from "../src/psd/snapshot.js";

/**
 * Minimal content-addressed CAS matching DocumentTypeContext's editor surface:
 * `makeSBlob` hashes the bytes and keeps them; `readSBlob` returns them verbatim.
 */
function memCas(): { ctx: DocumentTypeContext; nodes: Map<string, Uint8Array> } {
  const nodes = new Map<string, Uint8Array>();
  const ctx: DocumentTypeContext = {
    async makeSBlob(dataOrHash: SBlobData | string, loadData?: () => Promise<SBlobData>): Promise<SBlob> {
      if (typeof dataOrHash === "string") {
        if (nodes.has(dataOrHash)) return createSBlob(dataOrHash);
        if (!loadData) throw new Error(`CAS node ${dataOrHash} not found`);
        const loaded = await loadData();
        nodes.set(dataOrHash, loaded.data);
        return createSBlob(dataOrHash);
      }
      const hash = createHash("sha256").update(dataOrHash.data).digest("hex");
      if (!nodes.has(hash)) nodes.set(hash, dataOrHash.data);
      return createSBlob(hash);
    },
    async readSBlob(blob: SBlob): Promise<SBlobData> {
      const data = nodes.get(blob.hash);
      if (!data) throw new Error(`CAS node ${blob.hash} not found`);
      return { data, contentType: "image/png" };
    },
  };
  return { ctx, nodes };
}

/** A read-only context (no usable makeSBlob) — save must fall back to full PSD. */
function readOnlyCtx(_nodes: Map<string, Uint8Array>): DocumentTypeContext {
  return {
    makeSBlob: undefined as unknown as DocumentTypeContext["makeSBlob"],
    async readSBlob() {
      throw new Error("read-only");
    },
  };
}

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = a;
  }
  return d;
}

const canvas = { width: 4, height: 4, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

/** Resident doc (as produced by an 8BPS import) with a group + child + mask. */
function residentDoc(): PsdDoc {
  const child: Layer = {
    id: "child-1",
    type: "raster",
    name: "Child",
    bounds: [0, 0, 2, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 2, data: fill(2, 2, [10, 20, 30, 255]) },
    mask: {
      pixels: {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
      },
      bounds: [0, 0, 2, 2],
      defaultColor: 255,
      inverted: false,
    },
  };
  const group: Layer = {
    id: "group-1",
    type: "group",
    name: "Group",
    bounds: [0, 0, 2, 2],
    opacity: 1,
    blendMode: "pass-through",
    visible: true,
    locked: false,
    clipping: false,
    children: [child],
  };
  const top: Layer = {
    id: "top-1",
    type: "raster",
    name: "Top",
    bounds: [0, 0, 4, 4],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 4, height: 4, data: fill(4, 4, [200, 100, 50, 128]) },
  };
  return { canvas, layers: [group, top] };
}

function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const f = findLayer(l.children, id);
      if (f) return f;
    }
  }
  return undefined;
}

describe("PSD CAS snapshot save/load", () => {
  it("saveSnapshot with a write CAS ctx produces IR JSON and uploads every layer blob", async () => {
    const { ctx, nodes } = memCas();
    const doc = residentDoc();
    const bytes = await saveSnapshot(doc, ctx);

    // JSON, not PSD.
    expect(bytes[0]).toBe(0x7b); // "{"
    const ir = JSON.parse(new TextDecoder().decode(bytes));
    expect(new TextDecoder().decode(bytes)).not.toMatch(/"data"\s*:/);

    // child pixels + child mask + top pixels = 3 blobs, all readable.
    expect(nodes.size).toBe(3);
    const childHash = ir.layers[0].children[0].pixels.hash;
    const maskHash = ir.layers[0].children[0].mask.pixels.hash;
    const topHash = ir.layers[1].pixels.hash;
    for (const h of [childHash, maskHash, topHash]) {
      expect(typeof h).toBe("string");
      expect(nodes.get(h)).toBeInstanceOf(Uint8Array);
    }
    expect(collectSBlobRefs(doc)).toEqual({
      [childHash]: 1,
      [maskHash]: 1,
      [topHash]: 1,
    });
  });

  it("refsFromSnapshot returns every layer + mask hash (sync, no store)", async () => {
    const { ctx } = memCas();
    const bytes = await saveSnapshot(residentDoc(), ctx);
    const ir = JSON.parse(new TextDecoder().decode(bytes));

    const refs = refsFromSnapshot(bytes);
    const expected = {
      [ir.layers[0].children[0].pixels.hash]: 1,
      [ir.layers[0].children[0].mask.pixels.hash]: 1,
      [ir.layers[1].pixels.hash]: 1,
    };
    expect(refs).toEqual(expected);
  });

  it("loadSnapshot yields lazy PixelRef layers whose pixels resolve byte-identical", async () => {
    const { ctx } = memCas();
    const original = residentDoc();
    const bytes = await saveSnapshot(original, ctx);
    const doc = await loadSnapshot(bytes, ctx);

    const child = findLayer(doc.layers, "child-1")!;
    const top = findLayer(doc.layers, "top-1")!;
    expect(isRef(child.pixels!)).toBe(true);
    expect(isRef(top.pixels!)).toBe(true);

    const store = casBlobStore(ctx);
    const cache = new PixelCache(1 << 20);
    const rc = await resolvePixels(child.pixels!, store, cache);
    const rt = await resolvePixels(top.pixels!, store, cache);
    expect([...rc.data]).toEqual([...fill(2, 2, [10, 20, 30, 255])]);
    expect([...rt.data]).toEqual([...fill(4, 4, [200, 100, 50, 128])]);

    // Mask restored to resident bytes.
    expect([...child.mask!.pixels.data]).toEqual([
      0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]);
  });

  it("round-trip render of the lazy doc equals the resident render", async () => {
    const { ctx } = memCas();
    const original = residentDoc();

    const residentPixels = await render(structuredClone(original));

    const bytes = await saveSnapshot(original, ctx);
    const lazy = await loadSnapshot(bytes, ctx);
    const store = casBlobStore(ctx);
    const lazyPixels = await render(lazy, { store, cache: new PixelCache(1 << 20) });

    expect(lazyPixels.width).toBe(residentPixels.width);
    expect(lazyPixels.height).toBe(residentPixels.height);
    expect([...lazyPixels.data]).toEqual([...residentPixels.data]);
  });

  it("back-compat: no-ctx saveSnapshot writes 8BPS PSD bytes and loadSnapshot routes them to full load", async () => {
    const bytes = await saveSnapshot(residentDoc());
    // 8BPS magic.
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x38, 0x42, 0x50, 0x53]);

    const doc = await loadSnapshot(bytes);
    const top = findLayer(doc.layers, "top-1") ?? doc.layers.find((l) => l.type === "raster");
    // Full load → resident pixels, not refs.
    expect(top).toBeDefined();
    expect(top!.pixels && isRef(top!.pixels)).toBe(false);
  });

  it("back-compat: a read-only ctx (no cas.store) still falls back to full PSD on save", async () => {
    const { nodes } = memCas();
    const bytes = await saveSnapshot(residentDoc(), readOnlyCtx(nodes));
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x38, 0x42, 0x50, 0x53]);
    expect(nodes.size).toBe(0);
  });

  it("loadSnapshot throws a clear error for an IR snapshot with no CAS context", async () => {
    const { ctx } = memCas();
    const bytes = await saveSnapshot(residentDoc(), ctx);
    await expect(loadSnapshot(bytes)).rejects.toThrow(/CAS context/);
  });
});
