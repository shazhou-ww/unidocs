import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, test, vi } from "vitest";
import { createViewBundleService, type BundleObjectWrite, type ViewBundleRepository } from "../src/index.js";

const context = { memberId: "adm_1", identity: { issuer: "issuer", subject: "subject", email: "admin@example.com", authenticatedAt: 1 }, transport: "bearer" as const };

async function archive() {
  const manifest = {
    protocol: "unidocs-view-bundle/v1", documentType: "markdown",
    entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: [0],
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-view.json", new TextReader(JSON.stringify(manifest, null, 2)));
  await writer.add("view.html", new TextReader("<!doctype html><script type=module src=app.js></script>"));
  await writer.add("thumbnail.html", new TextReader("<!doctype html><main>Preview</main>"));
  await writer.add("app.js", new TextReader("export {};"));
  const bytes = await writer.close();
  return { bytes, source: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

function fixture() {
  const records = new Map<string, any>();
  const repository: ViewBundleRepository = {
    listDocumentContractIdxs: vi.fn(async (_context, documentType) => documentType === "markdown" ? [0] : null),
    reserveUpload: vi.fn<ViewBundleRepository["reserveUpload"]>(async () => ({ kind: "reserved" })),
    publishUpload: vi.fn(async command => { records.set(command.viewBundleId, command.record); return { viewBundleId: command.viewBundleId, etag: command.record.etag }; }),
    updateMetadata: vi.fn(async command => {
      const record = await command.buildRecord(records.get(command.viewBundleId));
      records.set(command.viewBundleId, record);
      return { viewBundleId: command.viewBundleId, etag: record.etag };
    }),
    get: vi.fn(async (_context, bundleId) => records.get(bundleId) ?? null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const writes: BundleObjectWrite[] = [];
  const service = createViewBundleService(repository, { async put(object) { writes.push(object); } }, {
    bundleOrigin: "https://bundles.unidocs.test", now: () => new Date("2027-01-15T08:00:00.987Z"), id: () => "audit-1",
  });
  return { repository, records, writes, service };
}

describe("View bundle service", () => {
  test("validates registered revisions, stores every resource, and publishes the record", async () => {
    const input = await archive();
    const { repository, records, writes, service } = fixture();
    const result = await service.upload(context, { name: "Primary view", description: "Candidate" }, input.source(), "upload-1", "request-1");
    expect(result.viewBundleId).toMatch(/^vb_[0-9a-f]{64}$/);
    expect(repository.listDocumentContractIdxs).toHaveBeenCalledWith(context, "markdown");
    expect(repository.reserveUpload).toHaveBeenCalledOnce();
    expect(repository.publishUpload).toHaveBeenCalledOnce();
    expect(writes.map(({ key, contentType }) => ({ key, contentType }))).toEqual([
      { key: `view-bundles/${result.viewBundleId}/unidocs-view.json`, contentType: "application/json" },
      { key: `view-bundles/${result.viewBundleId}/app.js`, contentType: "text/javascript" },
      { key: `view-bundles/${result.viewBundleId}/thumbnail.html`, contentType: "text/html" },
      { key: `view-bundles/${result.viewBundleId}/view.html`, contentType: "text/html" },
    ]);
    expect(records.get(result.viewBundleId)).toMatchObject({
      viewBundleId: result.viewBundleId,
      bundleUrl: `https://bundles.unidocs.test/view-bundles/${result.viewBundleId}/`,
      name: "Primary view", description: "Candidate", size: input.bytes.byteLength,
      uploadedAt: "2027-01-15T08:00:00.000Z", manifest: { documentType: "markdown", supportedDocumentContractIdxs: [0] }, etag: result.etag,
    });
  });

  test("replays a reservation receipt without writing objects", async () => {
    const input = await archive();
    const { repository, writes, service } = fixture();
    vi.mocked(repository.reserveUpload).mockResolvedValue({ kind: "replay", result: { viewBundleId: `vb_${"a".repeat(64)}`, etag: `"sha256-${"A".repeat(43)}"` } });
    const result = await service.upload(context, { name: "Primary view", description: "" }, input.source(), "upload-1", "request-1");
    expect(result.viewBundleId).toBe(`vb_${"a".repeat(64)}`);
    expect(writes).toHaveLength(0);
    expect(repository.publishUpload).not.toHaveBeenCalled();
  });

  test("updates only mutable metadata", async () => {
    const input = await archive();
    const { records, service } = fixture();
    const uploaded = await service.upload(context, { name: "Old", description: "" }, input.source(), "upload-1", "request-1");
    const before = records.get(uploaded.viewBundleId);
    const updated = await service.updateMetadata(context, uploaded.viewBundleId, { name: "New", description: "Notes" }, "patch-1", before.etag, "request-2");
    const after = records.get(uploaded.viewBundleId);
    expect(after).toMatchObject({ name: "New", description: "Notes", bundleUrl: before.bundleUrl, manifest: before.manifest, size: before.size });
    expect(updated.etag).not.toBe(before.etag);
  });
});
// This guard runs on every request the portal serves, not just bundle routes,
// so what it refuses it refuses for the whole worker. `pnpm dev portal` binds
// a loopback BUNDLE_ORIGIN and has no certificate to offer; before the
// relaxation, merging the bundle feature turned every admin route — sign-in
// included — into a blanket 503.
test("bundleOrigin accepts a loopback origin for local development, and nothing else non-HTTPS", () => {
  const store = { async put() {} };
  const repository = {} as ViewBundleRepository;
  for (const origin of ["http://127.0.0.1:8796", "http://localhost:8796", "https://bundles.shazhou.work"]) {
    expect(() => createViewBundleService(repository, store, { bundleOrigin: origin }), origin).not.toThrow();
  }
  for (const origin of [
    "http://bundles.shazhou.work",
    "http://127.0.0.1",                     // no port: not a spelling the runtime binds
    "http://127.0.0.1.evil.test:8796",      // a different host that merely starts with it
    "https://bundles.shazhou.work/prefix",  // path, query and hash stay refused either way
    "https://bundles.shazhou.work/?a=1",
    "http://127.0.0.1:8796/x",              // loopback is scheme-only: path still refused
    "http://127.0.0.1:8796?a=1",
    "http://127.0.0.1:8796#frag",
  ]) {
    expect(() => createViewBundleService(repository, store, { bundleOrigin: origin }), origin)
      .toThrow(/bundleOrigin must be an HTTPS origin/);
  }
});