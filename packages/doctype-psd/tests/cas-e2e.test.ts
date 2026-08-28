/**
 * End-to-end verification of SValue snapshots through the real
 * `DocumentSession` — not doctype-level units. This proves the whole chain:
 *
 *   1. import a PSD -> the durable/cached snapshot becomes a compact
 *      serialized PsdStoredDoc
 *      referencing per-layer pixel blobs in the CAS (not another 8BPS copy)
 *   2. a structural edit that touches no pixels does not re-upload any
 *      layer blob (content addressing dedupes the unchanged pixels)
 *   3. a brand-new session, sharing only the storage ports (no warm
 *      in-memory document), cold-loads the SValue snapshot and renders a
 *      byte-identical composite by lazily faulting pixels in from the CAS
 *   4. exportBytes() still hands back a real PSD, never snapshot bytes
 *
 * Every doctype-level piece this exercises already has focused unit
 * coverage (cas-snapshot.test.ts, lazy-render-verification.test.ts,
 * cas-render.test.ts). What's new here is driving them through the actual
 * `DocumentSession` write/read paths (`create` / `apply` / `query` /
 * `exportBytes`) with memory ports, exactly as a real deployment would.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decode as decodePng } from "fast-png";
import { collectSBlobRefs, createSBlob, decodeSValue, isSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeContext, SBlob, SBlobSource, SValue } from "@unidocs/protocol";
import type { SessionDeps } from "@unidocs/doctype-server-common";
import { DocumentSession } from "@unidocs/doctype-server-common";
import { createMemoryPorts, MemoryCas } from "@unidocs/doctype-server-common/memory-ports";
import { createPsdDocumentType } from "../src/doctype.js";
import { render } from "../src/render/index.js";
import { load as loadPsd } from "../src/psd/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Pull the SBlob PNG out of a getPreview query result and decode it to raw
 *  RGBA pixels, so two previews can be compared byte-for-byte. */
async function decodePreviewImage(
  data: SValue,
  ctx: DocumentTypeContext,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = (data as { image?: unknown }).image;
  expect(isSBlob(image)).toBe(true);
  const { data: bytes, contentType } = await ctx.readSBlob(image as SBlob);
  expect(contentType).toBe("image/png");
  const decoded = decodePng(bytes);
  const arr =
    decoded.data instanceof Uint8ClampedArray
      ? decoded.data
      : new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length);
  return { width: decoded.width, height: decoded.height, data: arr };
}

function compareBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  return Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.length),
    Buffer.from(b.buffer, b.byteOffset, b.length),
  );
}

describe("PSD SValue snapshots through DocumentSession", () => {
  it("import -> TDoc snapshot; edit dedups unchanged pixels; cold reload renders byte-identically; export stays a real PSD", async () => {
    const psdBytes = new Uint8Array(readFileSync(fixture));

    // Independent oracle: what our own renderer produces straight off the raw
    // PSD, with no session/CAS machinery involved at all.
    const rawDoc = await loadPsd(psdBytes);
    const rawRender = await render(rawDoc);

    const ports = createMemoryPorts();
    const cas: MemoryCas = ports.cas;
    const ctx: DocumentTypeContext = {
      async makeSBlob(dataOrHash: SBlobSource | string, loadData?: () => Promise<SBlobSource>): Promise<SBlob> {
        if (typeof dataOrHash === "string") {
          try {
            await cas.read({ kind: "cas", hash: dataOrHash });
            return createSBlob(dataOrHash);
          } catch {
            if (!loadData) throw new Error(`CAS node ${dataOrHash} not found`);
            const loaded = await loadData();
            await cas.store(await sourceBytes(loaded), loaded.contentType);
            return createSBlob(dataOrHash);
          }
        }
        const hash = await cas.store(await sourceBytes(dataOrHash), dataOrHash.contentType);
        return createSBlob(hash);
      },
      async openSBlob(blob: SBlob) {
        const data = await cas.read({ kind: "cas", hash: blob.hash });
        return {
          size: data.length,
          contentType: "image/png",
          read: (range?: { offset: number; length?: number }) => ({
            async *[Symbol.asyncIterator]() {
              const start = range?.offset ?? 0;
              const end = range?.length === undefined ? data.length : start + range.length;
              yield data.slice(start, end);
            },
          }),
          readBytes: async (range: { offset: number; length: number }) =>
            data.slice(range.offset, range.offset + range.length),
        };
      },
    };
    const config = createPsdDocumentType(ctx);
    const deps: SessionDeps = {
      deltas: ports.deltas,
      snapshots: ports.snapshots,
      blobs: ports.blobs,
      unitOfWork: ports.unitOfWork,
      cas: ports.cas,
      identity: { docType: "psd", sessionId: "session-1", tenantId: "tenant-1" },
      now: () => Date.now(),
    };
    const session = new DocumentSession(config, deps);

    // ----------------------------------------------------------------
    // 1. Import -> serialized PsdStoredDoc snapshot
    // ----------------------------------------------------------------
    const created = await session.create({ bytes: psdBytes });
    expect(created).toEqual({ sessionId: "session-1", version: 1 });

    // The durable, content-addressed snapshot: read what was actually
    // persisted, not what save() merely returns in memory.
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(1);
    const durableSnapshot = await deps.blobs.get(ref!.hash);
    expect(durableSnapshot).not.toBeNull();

    // The fast (non-durable) snapshot cache agrees.
    const cachedSnapshot = await deps.snapshots.get();
    expect(cachedSnapshot?.version).toBe(1);

    const durableState = decodeSValue(durableSnapshot!);
    expect(decodeSValue(cachedSnapshot!.bytes)).toEqual(durableState);

    for (const snapBytes of [durableSnapshot!, cachedSnapshot!.bytes]) {
      // Snapshot is valid SValue, not the "8BPS" external PSD format.
      expect(decodeSValue(snapBytes)).toMatchObject({
        canvas: { colorMode: "RGB", depth: 8 },
      });
      expect(String.fromCharCode(snapBytes[0], snapBytes[1], snapBytes[2], snapBytes[3])).not.toBe("8BPS");
      // Pixel bytes are externalized, so only SBlob handles remain inline.
      expect(snapBytes.length).toBeLessThan(psdBytes.length);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[cas-e2e] input PSD=${psdBytes.length}B, durable SValue snapshot=${durableSnapshot!.length}B ` +
      `(${((durableSnapshot!.length / psdBytes.length) * 100).toFixed(1)}% of input)`,
    );

    // Every SBlob reachable from TDoc is actually readable from the CAS.
    const refsAfterImport = collectSBlobRefs(durableState);
    const hashesAfterImport = Object.keys(refsAfterImport);
    expect(hashesAfterImport.length).toBeGreaterThan(0);
    expect(cas.rootRefUpdates).toContainEqual({
      requestId: "snapshot:session-1:1",
      changes: refsAfterImport,
    });
    for (const hash of hashesAfterImport) {
      const blob = await deps.cas.read({ kind: "cas", hash });
      expect(blob).toBeInstanceOf(Uint8Array);
      expect(blob.length).toBeGreaterThan(0);
    }

    const casSizeAfterImport = cas.size;
    // eslint-disable-next-line no-console
    console.log(`[cas-e2e] distinct CAS blobs after import=${casSizeAfterImport}`);
    expect(casSizeAfterImport).toBe(hashesAfterImport.length);

    // Sanity: the session's own preview of the freshly-imported doc already
    // matches the independent raw-PSD render (state materialization is lossless).
    const previewAfterImport = await session.query({ kind: "getPreview" });
    const imgAfterImport = await decodePreviewImage(previewAfterImport.data, ctx);
    expect(imgAfterImport.width).toBe(rawRender.width);
    expect(imgAfterImport.height).toBe(rawRender.height);
    expect(compareBytes(imgAfterImport.data, rawRender.data)).toBe(0);

    // ----------------------------------------------------------------
    // 2. Edit dedup: a structural edit touching no pixels
    // ----------------------------------------------------------------
    const layerId = rawDoc.layers[0].id; // the background raster layer
    expect(layerId).toBeTruthy();

    const casSizeBeforeEdit = cas.size;
    const edited = await session.apply(
      [{ kind: "set_props", payload: { layerId, props: { opacity: 0.5 } } }],
      "lower background opacity",
      created.version,
    );
    expect(edited.version).toBe(2);
    const casSizeAfterEdit = cas.size;

    // eslint-disable-next-line no-console
    console.log(`[cas-e2e] distinct CAS blobs before edit=${casSizeBeforeEdit}, after edit=${casSizeAfterEdit}`);

    // The edit changed no pixels, so no layer blob was re-uploaded: the fast
    // operation result externalization re-serializes every layer (PNG-encodes
    // the SAME unchanged pixel bytes again), but MemoryCas.store
    // hashes to the identical existing node and skips the insert.
    expect(casSizeAfterEdit).toBe(casSizeBeforeEdit);

    // Baseline for the cold-reload comparison below: the resident session's
    // own preview of the current (post-edit) state. getPreview now stores its
    // PNG as a CAS blob (spec 5.3/2.4), so this call itself grows the CAS by
    // one node — that's the baseline the cold reload below must not exceed.
    const residentPreview = await session.query({ kind: "getPreview" });
    expect(residentPreview.version).toBe(2);
    const residentImg = await decodePreviewImage(residentPreview.data, ctx);
    const casSizeAfterResidentPreview = cas.size;

    // ----------------------------------------------------------------
    // 3. Cold reload -> lazy render, byte-identical
    // ----------------------------------------------------------------
    // A brand-new DocumentSession instance: zero warm in-memory document,
    // sharing ONLY the storage ports (same deltas/snapshots/blobs/cas/index)
    // with session 1. Its first query() forces load() end to end: read the
    // persisted snapshot, materialize TDoc into a lazy PixelRef document,
    // and fault every visible layer's pixels in from the CAS on render.
    const session2 = new DocumentSession(config, deps);
    const coldPreview = await session2.query({ kind: "getPreview" });
    expect(coldPreview.version).toBe(2);
    expect(isSBlob((coldPreview.data as { image?: unknown }).image)).toBe(true);

    const coldImg = await decodePreviewImage(coldPreview.data, ctx);
    expect(coldImg.width).toBe(residentImg.width);
    expect(coldImg.height).toBe(residentImg.height);
    expect(compareBytes(coldImg.data, residentImg.data)).toBe(0);

    // Cold reload renders the identical composite, so its PNG hashes to the
    // same CAS node as the resident preview above — no further growth.
    expect(cas.size).toBe(casSizeAfterResidentPreview);

    // ----------------------------------------------------------------
    // 4. exportBytes() still returns a real PSD, never snapshot bytes
    // ----------------------------------------------------------------
    const exported = await session.exportBytes();
    expect(exported.contentType).toBe("image/vnd.adobe.photoshop");
    expect([exported.bytes[0], exported.bytes[1], exported.bytes[2], exported.bytes[3]]).toEqual([
      0x38, 0x42, 0x50, 0x53, // "8BPS"
    ]);

    // ----------------------------------------------------------------
    // 5. exportBytes() on the COLD-RELOADED (lazy) session must also
    //    produce a real PSD — not throw, and not snapshot bytes.
    // ----------------------------------------------------------------
    // session2's document is lazy (PixelRef layers). formats.psd.save
    // materializes them via resolveDoc before writing 8BPS.
    const coldExport = await session2.exportBytes();
    expect(coldExport.contentType).toBe("image/vnd.adobe.photoshop");
    // Real PSD magic "8BPS".
    expect(String.fromCharCode(
      coldExport.bytes[0], coldExport.bytes[1], coldExport.bytes[2], coldExport.bytes[3],
    )).toBe("8BPS");

    // Decode it back and confirm it's a valid PSD of the right dimensions.
    const roundTripped = await loadPsd(coldExport.bytes);
    expect(roundTripped.canvas.width).toBe(rawDoc.canvas.width);
    expect(roundTripped.canvas.height).toBe(rawDoc.canvas.height);
  });
});

async function sourceBytes(source: SBlobSource): Promise<Uint8Array> {
  if ("data" in source) return source.data;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source.body) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
