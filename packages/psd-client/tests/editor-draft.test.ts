import { describe, expect, it, vi } from "vitest";
import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import { EditorDraft } from "../src/editor-draft.js";
import { RenderCore } from "../src/render-core.js";
import type { RenderLike } from "../src/doc-session.js";

function fixture() {
  const doc: PsdDoc = {
    canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [{
      id: "layer", type: "raster", name: "Layer", bounds: [0, 0, 1, 1], opacity: 1,
      blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 1, height: 1, hash: "a".repeat(64) }
    }],
  };
  const render = { applyOp: vi.fn<RenderLike["applyOp"]>().mockResolvedValue([0, 0, 1, 1]), reset: vi.fn<RenderLike["reset"]>().mockResolvedValue() };
  let identifier = 0;
  const draft = new EditorDraft({ doc, baseVersion: 5, render, generateId: () => `candidate-${++identifier}` });
  return { doc, draft, render };
}

const opacity = (value: number): PsdOp => ({ kind: "set_props", payload: { layerId: "layer", props: { opacity: value } } });

describe("EditorDraft", () => {
  it("restores edited pixels, basis and operations from an isolated checkpoint", async () => {
    const { draft, render } = fixture();
    await draft.applyLocal(opacity(0.4));
    const checkpoint = await draft.checkpoint();
    const restored = EditorDraft.restore(checkpoint, render);
    checkpoint.doc.layers[0]!.opacity = 0.9;
    expect(restored.doc.layers[0]!.opacity).toBe(0.4);
    expect(draft.doc.layers[0]!.opacity).toBe(0.4);
    expect(restored.baseVersion).toBe(5);
    expect(restored.dirty).toBe(true);
    expect(restored.frozen).toBe(false);
    expect((await restored.prepareCommit()).operations).toEqual([opacity(0.4)]);
  });

  it("restores an unknown candidate with the same ID and keeps edits frozen", async () => {
    const { draft, render } = fixture();
    await draft.applyLocal(opacity(0.4));
    const candidate = await draft.prepareCommit();
    await draft.acceptResult(candidate.candidateId, { status: "unknown" });
    const restored = EditorDraft.restore(await draft.checkpoint(), render);
    expect((await restored.prepareCommit()).candidateId).toBe(candidate.candidateId);
    await expect(restored.applyLocal(opacity(0.8))).rejects.toThrow("frozen");
    await restored.acceptResult(candidate.candidateId, { status: "committed", version: 6 });
    expect(restored.baseVersion).toBe(6);
    expect(restored.dirty).toBe(false);
  });

  it("composites actual layer pixels through RenderCore before a local commit is acknowledged", async () => {
    const { doc } = fixture();
    doc.layers[0]!.pixels = { width: 1, height: 1, data: new Uint8ClampedArray([200, 80, 40, 255]) };
    const core = new RenderCore(doc, { get: async () => null, put: async () => { throw new Error("Unexpected blob write"); } });
    const draft = new EditorDraft({
      doc, baseVersion: 1, render: {
        applyOp: operation => core.applyOp(operation), reset: async next => { core.reset(next); },
      }
    });
    const before = await core.composite();
    await draft.applyLocal(opacity(0.5));
    const after = await core.composite();
    expect(after.data[3]).toBeLessThan(before.data[3]!);
    expect(after.data[3]).toBeGreaterThan(0);
    expect(draft.baseVersion).toBe(1);
    const candidate = await draft.prepareCommit();
    await draft.acceptResult(candidate.candidateId, { status: "committed", version: 2 });
    expect(draft.baseVersion).toBe(2);
    expect((await core.composite()).data).toEqual(after.data);
  });

  it("edits locally without fetching and supplies one batch only when explicitly prepared", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
    try {
      const { doc, draft, render } = fixture();
      await draft.applyLocal(opacity(0.5));
      await draft.applyLocal(opacity(0.2));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(doc.layers[0]!.opacity).toBe(1);
      expect(draft.doc.layers[0]!.opacity).toBe(0.2);
      expect(render.applyOp).toHaveBeenCalledTimes(2);
      const candidate = await draft.prepareCommit();
      const hostApply = vi.fn().mockResolvedValue({ status: "committed" as const, version: 6 });
      await draft.acceptResult(candidate.candidateId, await hostApply(candidate));
      expect(hostApply).toHaveBeenCalledTimes(1);
      expect(candidate.operations).toEqual([opacity(0.5), opacity(0.2)]);
      expect(candidate.baseVersion).toBe(5);
      expect(draft.baseVersion).toBe(6);
      expect(draft.dirty).toBe(false);
      expect(draft.frozen).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("freezes new input immediately, waits for in-flight rendering and deduplicates prepare", async () => {
    const { draft, render } = fixture();
    let finish!: (rect: [number, number, number, number]) => void;
    render.applyOp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const edit = draft.applyLocal(opacity(0.5));
    await vi.waitFor(() => expect(render.applyOp).toHaveBeenCalledTimes(1));
    const first = draft.prepareCommit();
    const second = draft.prepareCommit();
    await expect(draft.applyLocal(opacity(0.2))).rejects.toThrow("frozen");
    finish([0, 0, 1, 1]);
    await edit;
    expect(await first).toBe(await second);
    expect((await first).sequence).toBe(1);
  });

  it("keeps the original basis and operations after rejection, and ignores a duplicate old result", async () => {
    const { draft } = fixture();
    await draft.applyLocal(opacity(0.5));
    const first = await draft.prepareCommit();
    await draft.acceptResult(first.candidateId, { status: "rejected" });
    expect(draft.baseVersion).toBe(5);
    expect(draft.dirty).toBe(true);
    await draft.applyLocal(opacity(0.2));
    const second = await draft.prepareCommit();
    await draft.acceptResult(first.candidateId, { status: "rejected" });
    expect(draft.frozen).toBe(true);
    expect(second.operations).toHaveLength(2);
    expect(second.candidateId).not.toBe(first.candidateId);
    await expect(draft.acceptResult(first.candidateId, { status: "committed", version: 6 })).rejects.toThrow("Conflicting result");
  });

  it("keeps an unknown outcome frozen until the same candidate has a confirmed result", async () => {
    const { draft } = fixture();
    await draft.applyLocal(opacity(0.5));
    const candidate = await draft.prepareCommit();
    await draft.acceptResult(candidate.candidateId, { status: "unknown" });
    expect(await draft.prepareCommit()).toBe(candidate);
    expect(draft.dirty).toBe(true);
    await expect(draft.applyLocal(opacity(0.2))).rejects.toThrow("frozen");
    await draft.acceptResult(candidate.candidateId, { status: "committed", version: 6 });
    await draft.applyLocal(opacity(0.8));
    await draft.acceptResult(candidate.candidateId, { status: "committed", version: 6 });
    expect(draft.dirty).toBe(true);
    expect(draft.doc.layers[0]!.opacity).toBe(0.8);
  });

  it("does not advance draft state if rendering fails and repairs the renderer", async () => {
    const { draft, render, doc } = fixture();
    render.applyOp.mockRejectedValueOnce(new Error("Render failed"));
    await expect(draft.applyLocal(opacity(0.5))).rejects.toThrow("Render failed");
    expect(draft.doc).toBe(doc);
    expect(draft.sequence).toBe(0);
    expect(draft.dirty).toBe(false);
    expect(render.reset).toHaveBeenCalledWith(doc);
    await draft.applyLocal(opacity(0.2));
    expect(draft.dirty).toBe(true);
  });

  it("blocks changes after failed renderer repair until explicit recovery succeeds", async () => {
    const { draft, render } = fixture();
    render.applyOp.mockRejectedValueOnce(new Error("Render failed"));
    render.reset.mockRejectedValueOnce(new Error("Reset failed"));
    await expect(draft.applyLocal(opacity(0.5))).rejects.toThrow("Render failed");
    await expect(draft.applyLocal(opacity(0.2))).rejects.toThrow("recovery required");
    await expect(draft.prepareCommit()).rejects.toThrow("recovery required");
    await draft.recoverRenderer();
    await draft.applyLocal(opacity(0.2));
    expect(draft.doc.layers[0]!.opacity).toBe(0.2);
  });

  it("rejects empty candidates and invalid acknowledgements without losing edits", async () => {
    const { draft } = fixture();
    await expect(draft.prepareCommit()).rejects.toThrow("No changes");
    expect(draft.frozen).toBe(false);
    await draft.applyLocal(opacity(0.5));
    const candidate = await draft.prepareCommit();
    await expect(draft.acceptResult("other", { status: "committed", version: 6 })).rejects.toThrow("Unknown candidate");
    await expect(draft.acceptResult(candidate.candidateId, { status: "committed", version: 10 })).rejects.toThrow("Invalid committed version");
    expect(draft.dirty).toBe(true);
    expect(draft.frozen).toBe(true);
  });
});