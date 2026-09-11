import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, test, vi } from "vitest";
import { createTypeCardBundleService, type BundleObjectWrite, type TypeCardBundleRepository } from "../src/index.js";

const context = { memberId: "adm_1", identity: { issuer: "issuer", subject: "subject", email: "admin@example.com", authenticatedAt: 1 }, transport: "bearer" as const };

function webp() {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  view.setUint32(16, 10, true);
  return bytes;
}

async function archive() {
  const manifest = { protocol: "unidocs-type-card/v1", documentType: "markdown", locales: { en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Example" } }, icon: { kind: "svg", path: "icon.svg" }, sampleThumbnail: "sample.webp" };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-type-card.json", new TextReader(JSON.stringify(manifest, null, 2)));
  await writer.add("icon.svg", new TextReader('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>'));
  await writer.add("sample.webp", new Uint8ArrayReader(webp()));
  const bytes = await writer.close();
  return { bytes, source: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

function fixture() {
  const records = new Map<string, any>();
  const repository: TypeCardBundleRepository = {
    reserveUpload: vi.fn<TypeCardBundleRepository["reserveUpload"]>(async () => ({ kind: "reserved" })),
    publishUpload: vi.fn(async command => { records.set(command.typeCardBundleId, command.record); return { typeCardBundleId: command.typeCardBundleId, etag: command.record.etag }; }),
    updateMetadata: vi.fn(async command => {
      const current = records.get(command.typeCardBundleId);
      const record = await command.buildRecord(current);
      records.set(command.typeCardBundleId, record);
      return { typeCardBundleId: command.typeCardBundleId, etag: record.etag };
    }),
    get: vi.fn(async (_context, bundleId) => records.get(bundleId) ?? null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const writes: BundleObjectWrite[] = [];
  const service = createTypeCardBundleService(repository, { async put(object) { writes.push(object); } }, {
    bundleOrigin: "https://bundles.unidocs.test", now: () => new Date("2027-01-15T08:00:00.987Z"), id: () => "audit-1",
  });
  return { repository, records, writes, service };
}

describe("Type Card bundle service", () => {
  test("reserves, stores, and publishes a validated immutable bundle", async () => {
    const input = await archive();
    const { repository, records, writes, service } = fixture();
    const result = await service.upload(context, { name: "Primary card", description: "Production candidate" }, input.source(), "upload-1", "request-1");
    expect(result.typeCardBundleId).toMatch(/^tb_[0-9a-f]{64}$/);
    expect(repository.reserveUpload).toHaveBeenCalledOnce();
    expect(repository.publishUpload).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(3);
    expect(records.get(result.typeCardBundleId)).toMatchObject({
      typeCardBundleId: result.typeCardBundleId,
      bundleUrl: `https://bundles.unidocs.test/type-card-bundles/${result.typeCardBundleId}/`,
      name: "Primary card", description: "Production candidate", size: input.bytes.byteLength,
      uploadedAt: "2027-01-15T08:00:00.000Z", manifest: { documentType: "markdown" }, etag: result.etag,
    });
  });

  test("replays a reservation receipt without writing R2", async () => {
    const input = await archive();
    const { repository, writes, service } = fixture();
    vi.mocked(repository.reserveUpload).mockResolvedValue({ kind: "replay", result: { typeCardBundleId: `tb_${"a".repeat(64)}`, etag: `"sha256-${"A".repeat(43)}"` } });
    const result = await service.upload(context, { name: "Primary card", description: "" }, input.source(), "upload-1", "request-1");
    expect(result.typeCardBundleId).toBe(`tb_${"a".repeat(64)}`);
    expect(writes).toHaveLength(0);
    expect(repository.publishUpload).not.toHaveBeenCalled();
  });

  test("updates only mutable metadata through the repository", async () => {
    const input = await archive();
    const { records, service } = fixture();
    const uploaded = await service.upload(context, { name: "Old", description: "" }, input.source(), "upload-1", "request-1");
    const before = records.get(uploaded.typeCardBundleId);
    const updated = await service.updateMetadata(context, uploaded.typeCardBundleId, { name: "New", description: "Notes" }, "patch-1", before.etag, "request-2");
    const after = records.get(uploaded.typeCardBundleId);
    expect(after).toMatchObject({ name: "New", description: "Notes", bundleUrl: before.bundleUrl, manifest: before.manifest, size: before.size });
    expect(updated.etag).not.toBe(before.etag);
  });
});