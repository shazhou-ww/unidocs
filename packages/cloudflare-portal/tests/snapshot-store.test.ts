import { describe, expect, it, vi } from "vitest";
import type { CasBlobClient } from "@unicas/tenant-blob-client";
import { createSnapshotStore } from "../src/snapshot-store.js";

const ref = { blobHash: "abc", size: 3, contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1" };

function blobClientDouble() {
  const read = vi.fn(() => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  }));
  const openBlob = vi.fn(async () => ({ ref: { hash: "abc", size: 3, contentType: ref.contentType }, read, readBytes: vi.fn() }));
  const retain = vi.fn(async () => ({}));
  const release = vi.fn(async () => ({}));
  return { openBlob, retain, release, read, client: { openBlob, retain, release } as unknown as CasBlobClient };
}

describe("snapshot store", () => {
  it("opens the blob by its contract-side hash field", async () => {
    const double = blobClientDouble();
    const store = createSnapshotStore(double.client);
    const stream = await store.read(ref);
    expect(double.openBlob).toHaveBeenCalledWith("abc", undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(chunks[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("retains one root reference per blob", async () => {
    const double = blobClientDouble();
    await createSnapshotStore(double.client).retain(ref, "req-1");
    expect(double.retain).toHaveBeenCalledWith({ requestId: "req-1", references: { abc: 1 } });
  });

  it("releases with the same shape, so archival can reuse it", async () => {
    const double = blobClientDouble();
    await createSnapshotStore(double.client).release(ref, "req-2");
    expect(double.release).toHaveBeenCalledWith({ requestId: "req-2", references: { abc: 1 } });
  });

  it("refuses a reference whose declared size disagrees with the stored blob", async () => {
    const double = blobClientDouble();
    const store = createSnapshotStore(double.client);
    await expect(store.read({ ...ref, size: 99 })).rejects.toThrow();
  });
});
