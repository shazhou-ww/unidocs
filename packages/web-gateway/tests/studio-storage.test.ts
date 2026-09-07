import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { StudioStorage, type StudioSnapshot } from "../src/ui/studio/storage.js";

function snapshot(): StudioSnapshot {
  const doc = { canvas: { width: 1, height: 1, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" }, layers: [] };
  return { schema: 1, versions: [{ version: 1, doc }], draft: { schema: 1, doc, baseVersion: 1, sequence: 0, operations: [], candidate: null }, editing: false, viewVersion: 1 };
}

describe("StudioStorage", () => {
  it("commits a snapshot and reads it from a fresh connection", async () => {
    const factory = new IDBFactory();
    const store = new StudioStorage(factory);
    expect(await store.load()).toBeNull();
    const value = snapshot();
    expect(await store.save(value, 0)).toBe(1);
    expect(await new StudioStorage(factory).load()).toEqual({ revision: 1, snapshot: value });
    value.viewVersion = 99;
    expect((await store.load())!.snapshot.viewVersion).toBe(1);
  });

  it("rejects stale tab writes and preserves the winning revision", async () => {
    const factory = new IDBFactory();
    const first = new StudioStorage(factory); const second = new StudioStorage(factory);
    const writes = await Promise.allSettled([first.save(snapshot(), 0), second.save(snapshot(), 0)]);
    expect(writes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await first.load())!.revision).toBe(1);
    await expect(second.save(snapshot(), 0)).rejects.toThrow("另一页面");
    expect(await second.save(snapshot(), 1)).toBe(2);
  });

  it("does not claim success when IndexedDB cannot open", async () => {
    const factory = { open: () => { throw new DOMException("Storage denied", "SecurityError"); } } as unknown as IDBFactory;
    await expect(new StudioStorage(factory).save(snapshot(), 0)).rejects.toThrow("Storage denied");
  });

  it("retains the previous snapshot after a quota failure aborts the write", async () => {
    const store = new StudioStorage(new IDBFactory());
    await store.save(snapshot(), 0);
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try { await expect(store.save(snapshot(), 1)).rejects.toThrow("Quota exceeded"); }
    finally { failure.mockRestore(); }
    expect((await store.load())!.revision).toBe(1);
    expect(await store.save(snapshot(), 1)).toBe(2);
  });
});