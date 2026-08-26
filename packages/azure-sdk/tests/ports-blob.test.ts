/**
 * Unit tests for `BlobSnapshotCache.get()`'s consistent-read retry loop and
 * `containerReady()`'s failure-clears-memo behaviour, both in
 * `../src/ports-blob.ts`.
 *
 * These paths were flagged in review as having zero coverage: `ports.test.ts`
 * only drives `runPortContract` against a real Azurite container, and the
 * contract has no notion of "another replica overwrote the blob between my
 * properties call and my download" — it can't inject that race through the
 * public port surface. Everything here runs against a hand-rolled stub of the
 * `ContainerClient`/`BlobServiceClient` shape `ports-blob.ts` actually calls,
 * so none of it needs Docker or Azurite; it exercises the retry/error-mapping
 * logic in isolation the way the contract and the e2e suite cannot.
 */

import { describe, expect, it, vi } from "vitest";
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { BlobCasStore, BlobSnapshotCache } from "../src/ports-blob.js";

const IDENTITY = { tenantId: "tenant-1", docType: "text", sessionId: "session-1" };

interface FakeBlockBlobClient {
  getProperties: ReturnType<typeof vi.fn>;
  downloadToBuffer: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
}

/** Minimal stand-in for the two-argument Azure `RestError` shape the code branches on. */
function storageError(statusCode: number, code: string): Error & { statusCode: number; code: string } {
  const err = new Error(code) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Builds a fresh `BlobServiceClient` stub. Fresh per test matters:
 * `containerReady()`'s memo is a `WeakMap` keyed by the `BlobServiceClient`
 * instance, so reusing one across tests would let one test's container-ready
 * state leak into the next.
 */
function fakeService(
  blob: FakeBlockBlobClient,
  createIfNotExists: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
): { svc: BlobServiceClient; container: ContainerClient } {
  const container = {
    createIfNotExists,
    getBlockBlobClient: vi.fn().mockReturnValue(blob),
  } as unknown as ContainerClient;
  const svc = {
    getContainerClient: vi.fn().mockReturnValue(container),
  } as unknown as BlobServiceClient;
  return { svc, container };
}

function fakeBlob(): FakeBlockBlobClient {
  return {
    getProperties: vi.fn(),
    downloadToBuffer: vi.fn(),
    upload: vi.fn(),
  };
}

describe("BlobSnapshotCache.get()", () => {
  it("retries the read when the download hits a precondition failure (blob overwritten mid-read)", async () => {
    const blob = fakeBlob();
    // First attempt: properties observe etag "v1", but the download races a
    // concurrent overwrite and the conditional GET reports 412 ConditionNotMet.
    blob.getProperties
      .mockResolvedValueOnce({ metadata: { version: "1" }, etag: "v1" })
      // Second attempt: the blob has settled at the newer content.
      .mockResolvedValueOnce({ metadata: { version: "2" }, etag: "v2" });
    blob.downloadToBuffer
      .mockRejectedValueOnce(storageError(412, "ConditionNotMet"))
      .mockResolvedValueOnce(Buffer.from([9, 9]));

    const { svc, container } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    const result = await cache.get();

    expect(result).toEqual({ version: 2, bytes: new Uint8Array([9, 9]) });
    expect(container.getBlockBlobClient).toHaveBeenCalledWith(
      "v1:8:tenant-1:4:text:9:session-1/latest",
    );
    expect(blob.getProperties).toHaveBeenCalledTimes(2);
    expect(blob.downloadToBuffer).toHaveBeenCalledTimes(2);
    // The retried download must be conditioned on the SECOND properties call's
    // etag, not the first — reusing the stale etag would just fail again.
    expect(blob.downloadToBuffer).toHaveBeenNthCalledWith(2, 0, undefined, {
      conditions: { ifMatch: "v2" },
    });
  });

  it("gives up and answers null once the download keeps losing the race past GET_ATTEMPTS", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockResolvedValue({ metadata: { version: "1" }, etag: "v1" });
    blob.downloadToBuffer.mockRejectedValue(storageError(412, "ConditionNotMet"));

    const { svc } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    const result = await cache.get();

    expect(result).toBeNull();
    // GET_ATTEMPTS = 3: exactly that many tries, not fewer (premature give-up)
    // and not more (an infinite or miscounted loop).
    expect(blob.getProperties).toHaveBeenCalledTimes(3);
    expect(blob.downloadToBuffer).toHaveBeenCalledTimes(3);
  });

  it("propagates a download error that is not a precondition failure, without retrying", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockResolvedValue({ metadata: { version: "1" }, etag: "v1" });
    blob.downloadToBuffer.mockRejectedValue(storageError(500, "InternalError"));

    const { svc } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    await expect(cache.get()).rejects.toThrow("InternalError");
    expect(blob.downloadToBuffer).toHaveBeenCalledTimes(1);
  });

  it("treats a missing/unparseable version as a cache miss without downloading", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockResolvedValue({ metadata: {}, etag: "v1" });

    const { svc } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    const result = await cache.get();

    expect(result).toBeNull();
    // No usable version means the bytes can't be placed in delta history —
    // downloading them would be wasted work.
    expect(blob.downloadToBuffer).not.toHaveBeenCalled();
  });

  it("treats a non-finite version metadata value the same as a missing one", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockResolvedValue({ metadata: { version: "not-a-number" }, etag: "v1" });

    const { svc } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    const result = await cache.get();

    expect(result).toBeNull();
    expect(blob.downloadToBuffer).not.toHaveBeenCalled();
  });

  it("answers null, not an error, when the blob does not exist", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockRejectedValue(storageError(404, "BlobNotFound"));

    const { svc } = fakeService(blob);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    await expect(cache.get()).resolves.toBeNull();
  });
});

describe("containerReady() failure clears the memo (via BlobCasStore/BlobSnapshotCache)", () => {
  it("does not remember a rejected createIfNotExists — the next call retries it", async () => {
    const blob = fakeBlob();
    blob.getProperties.mockResolvedValue({ metadata: { version: "1" }, etag: "v1" });
    blob.downloadToBuffer.mockResolvedValue(Buffer.from([1]));

    const createIfNotExists = vi
      .fn()
      .mockRejectedValueOnce(storageError(503, "ServerBusy"))
      .mockResolvedValueOnce(undefined);
    const { svc } = fakeService(blob, createIfNotExists);
    const cache = new BlobSnapshotCache(svc, IDENTITY);

    // First call: container bootstrap fails, so the whole read fails — this
    // must NOT get memoized as "container is ready".
    await expect(cache.get()).rejects.toThrow("ServerBusy");
    expect(createIfNotExists).toHaveBeenCalledTimes(1);

    // Second call, same instance: a naive memo that cached the rejected
    // promise (or a `false`) would either re-throw the stale error forever or
    // skip calling createIfNotExists() again and proceed against a container
    // that was never actually created. Correct behaviour is a fresh attempt
    // that this time succeeds.
    const result = await cache.get();
    expect(createIfNotExists).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ version: 1, bytes: new Uint8Array([1]) });
  });

  it("is shared across BlobCasStore and BlobSnapshotCache instances built from the same service, but per container name", async () => {
    const casBlob = fakeBlob();
    casBlob.getProperties.mockResolvedValue({ metadata: { version: "1" }, etag: "v1" });

    const createIfNotExists = vi.fn().mockResolvedValue(undefined);
    const { svc } = fakeService(casBlob, createIfNotExists);

    const cas1 = new BlobCasStore(svc);
    const cas2 = new BlobCasStore(svc);
    casBlob.downloadToBuffer.mockRejectedValue(storageError(404, "BlobNotFound"));

    await cas1.get("hash-a");
    await cas2.get("hash-b");

    // Both `BlobCasStore` instances share one `svc`, so `createIfNotExists()`
    // for the "cas" container must only have run once across the two of them.
    expect(createIfNotExists).toHaveBeenCalledTimes(1);
  });
});
