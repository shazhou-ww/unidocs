import { describe, expect, it } from "vitest";
import type { BlobStore } from "@unidocs/core";
import { isPsdBytes, encodeSnapshot, decodeSnapshot } from "../src/snapshot-codec.js";

// A no-op store; the codec never touches it directly (the config helpers do).
const store: BlobStore = {
  put: async () => "0000000000000000",
  get: async () => null,
};

// '8BPS' magic bytes (PSD), plus a trailing byte.
const psdBytes = new Uint8Array([0x38, 0x42, 0x50, 0x53, 0x00]);
// '{' — the start of IR JSON.
const irBytes = new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x7d]); // {"v"}

describe("isPsdBytes", () => {
  it("returns true for '8BPS'-prefixed bytes", () => {
    expect(isPsdBytes(psdBytes)).toBe(true);
  });

  it("returns false for '{'-prefixed (IR JSON) bytes", () => {
    expect(isPsdBytes(irBytes)).toBe(false);
  });
});

describe("encodeSnapshot", () => {
  it("uses serialize (not save) when the config provides serialize", async () => {
    let serializeCalls = 0;
    let saveCalls = 0;
    const config = {
      serialize: async () => {
        serializeCalls++;
        return irBytes;
      },
      save: async () => {
        saveCalls++;
        return psdBytes;
      },
    };
    const out = await encodeSnapshot({}, store, config);
    expect(serializeCalls).toBe(1);
    expect(saveCalls).toBe(0);
    expect(out).toBe(irBytes);
  });

  it("falls back to save when the config has no serialize", async () => {
    let saveCalls = 0;
    const config = {
      save: async () => {
        saveCalls++;
        return psdBytes;
      },
    };
    const out = await encodeSnapshot({}, store, config);
    expect(saveCalls).toBe(1);
    expect(out).toBe(psdBytes);
  });
});

describe("decodeSnapshot", () => {
  it("routes '8BPS' bytes to load even when deserialize is present (back-compat)", async () => {
    let loadCalls = 0;
    let deserializeCalls = 0;
    const config = {
      deserialize: async () => {
        deserializeCalls++;
        return { via: "deserialize" };
      },
      load: async () => {
        loadCalls++;
        return { via: "load" };
      },
    };
    const doc = await decodeSnapshot(psdBytes, store, config);
    expect(loadCalls).toBe(1);
    expect(deserializeCalls).toBe(0);
    expect(doc).toEqual({ via: "load" });
  });

  it("routes '{' bytes to deserialize when it is present", async () => {
    let loadCalls = 0;
    let deserializeCalls = 0;
    const config = {
      deserialize: async () => {
        deserializeCalls++;
        return { via: "deserialize" };
      },
      load: async () => {
        loadCalls++;
        return { via: "load" };
      },
    };
    const doc = await decodeSnapshot(irBytes, store, config);
    expect(deserializeCalls).toBe(1);
    expect(loadCalls).toBe(0);
    expect(doc).toEqual({ via: "deserialize" });
  });

  it("routes '{' bytes to load when no deserialize is present", async () => {
    let loadCalls = 0;
    const config = {
      load: async () => {
        loadCalls++;
        return { via: "load" };
      },
    };
    const doc = await decodeSnapshot(irBytes, store, config);
    expect(loadCalls).toBe(1);
    expect(doc).toEqual({ via: "load" });
  });
});
