import { readFile } from "node:fs/promises";
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "../../../packages/portal-service/node_modules/@zip.js/zip.js/index.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1PortalAuthRepository } from "../../../packages/cloudflare-portal/src/auth-repository.ts";
import { D1DocumentTypeRepository } from "../../../packages/cloudflare-portal/src/document-types-repository.ts";
import { D1TypeCardBundleRepository } from "../../../packages/cloudflare-portal/src/type-card-bundles-repository.ts";
import { createTypeCardBundlesHttp } from "../../../packages/cloudflare-portal/src/type-card-bundles-http.ts";
import { adminMcpZipStream, createDocumentTypeService, createTypeCardBundleService } from "../../../packages/portal-service/src/index.ts";

let miniflare;
let database;
const now = 1_800_000_000;
const identity = { issuer: "https://accounts.google.com", subject: "first", email: "first@example.com", authenticatedAt: now };

async function migrate(name) {
  const sql = await readFile(new URL(`../../../packages/cloudflare-portal/migrations/${name}`, import.meta.url), "utf8");
  await database.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
}

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "portal-type-card-bundles", modules: true, script: "export default { fetch() { return new Response('test'); } };",
      compatibilityDate: "2026-08-18", d1Databases: { DB: `portal-type-cards-${crypto.randomUUID()}` },
    }],
  }));
  database = await miniflare.getD1Database("DB", "portal-type-card-bundles");
  for (const name of ["0001_admin_auth.sql", "0002_document_types.sql", "0003_document_contracts.sql", "0004_type_card_bundles.sql", "0008_mcp_audit_attribution.sql"]) await migrate(name);
});

afterEach(async () => { await miniflare?.dispose(); });

function webp() {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  view.setUint32(16, 10, true);
  return bytes;
}

async function archive(documentType) {
  const manifest = { protocol: "unidocs-type-card/v1", documentType, locales: { en: { name: "Card", description: "Text", sampleThumbnailAlt: "Example" } }, icon: { kind: "svg", path: "icon.svg" }, sampleThumbnail: "sample.webp" };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-type-card.json", new TextReader(JSON.stringify(manifest)));
  await writer.add("icon.svg", new TextReader('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>'));
  await writer.add("sample.webp", new Uint8ArrayReader(webp()));
  return writer.close();
}

function source(bytes) {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

async function setup() {
  const auth = new D1PortalAuthRepository(database, () => now);
  const issued = await auth.completeLogin(identity, identity.email, "bootstrap");
  const context = { memberId: issued.memberId, identity, transport: "session", sessionHash: issued.session.sessionHash };
  const types = new D1DocumentTypeRepository(database, () => now);
  const typeService = createDocumentTypeService(types, { now: () => new Date(now * 1000), id: () => "markdown" });
  const created = await typeService.create(context, { internalName: "Markdown" }, "create-type", "create-type");
  const repository = new D1TypeCardBundleRepository(database, () => now);
  const writes = [];
  let auditId = 0;
  const service = createTypeCardBundleService(repository, { async put(object) { writes.push(object); } }, {
    bundleOrigin: "https://bundles.unidocs.test", now: () => new Date(now * 1000), id: () => `audit-card-${++auditId}`,
  });
  return { context, created, types, repository, service, writes };
}

test("concurrent same-key uploads publish one candidate, receipt, and audit", async () => {
  const { context, service, writes } = await setup();
  const bytes = await archive("dt-markdown");
  const results = await Promise.all(Array.from({ length: 4 }, () => service.upload(context, { name: "Primary", description: "" }, source(bytes), "upload-card", "request-card")));
  expect(results.every(result => result.typeCardBundleId === results[0].typeCardBundleId && result.etag === results[0].etag)).toBe(true);
  expect(writes).toHaveLength(12);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_type_card_bundles").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_type_card_bundle_reservations").first("count")).toBe(0);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'uploadTypeCardBundle'").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'type_card_bundle.uploaded'").first("count")).toBe(1);
}, 30_000);

test("MCP Type Card upload and metadata retain attribution on replay without ZIP input in audit", async () => {
  const { context, service } = await setup();
  const caller = { memberId: context.memberId, identity, transport: "bearer", caller: { channel: "mcp", oauthClientHandle: "a".repeat(64), toolName: "upload_type_card_bundle" } };
  const encoded = Buffer.from(await archive("dt-markdown")).toString("base64");
  const upload = () => service.upload(caller, { name: "MCP", description: "" }, adminMcpZipStream(encoded), "mcp-upload", "upload-request");
  const created = await upload();
  expect(await upload()).toEqual(created);
  const metadataCaller = { ...caller, caller: { ...caller.caller, toolName: "update_type_card_bundle_metadata" } };
  const update = () => service.updateMetadata(metadataCaller, created.typeCardBundleId, { name: "Next", description: "" }, "mcp-update", created.etag, "update-request");
  expect(await update()).toEqual(await update());
  const rows = (await database.prepare("SELECT caller_channel, oauth_client_handle, tool_name, details_json FROM portal_admin_audit WHERE caller_channel = 'mcp' ORDER BY tool_name").all()).results;
  expect(rows.map(row => row.tool_name)).toEqual(["update_type_card_bundle_metadata", "upload_type_card_bundle"]);
  expect(rows.every(row => row.oauth_client_handle === "a".repeat(64))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(encoded);
  expect(JSON.stringify(rows)).not.toContain("icon.svg");
});

test("duplicate content reports the existing identity and does not publish another candidate", async () => {
  const { context, service } = await setup();
  const bytes = await archive("dt-markdown");
  const first = await service.upload(context, { name: "Primary", description: "" }, source(bytes), "upload-one", "request-one");
  await expect(service.upload(context, { name: "Other", description: "" }, source(bytes), "upload-two", "request-two"))
    .rejects.toMatchObject({ code: "bundle_already_exists", details: { typeCardBundleId: first.typeCardBundleId } });
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_type_card_bundles").first("count")).toBe(1);
});

test("metadata update is atomic and the document type resolver reads the candidate", async () => {
  const { context, types, service } = await setup();
  const bytes = await archive("dt-markdown");
  const uploaded = await service.upload(context, { name: "Old", description: "" }, source(bytes), "upload-one", "request-one");
  const current = await service.get(context, uploaded.typeCardBundleId);
  expect((await types.resolveTypeCardBundle(context, "dt-markdown", uploaded.typeCardBundleId))?.etag).toBe(current.etag);
  const updated = await service.updateMetadata(context, uploaded.typeCardBundleId, { name: "New", description: "Notes" }, "patch-one", current.etag, "request-patch");
  await expect(service.updateMetadata(context, uploaded.typeCardBundleId, { name: "Stale", description: "" }, "patch-stale", current.etag, "request-stale"))
    .rejects.toMatchObject({ code: "precondition_failed" });
  expect((await service.get(context, uploaded.typeCardBundleId)).name).toBe("New");
  expect(updated.etag).not.toBe(current.etag);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'updateTypeCardBundleMetadata'").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'type_card_bundle.metadata_changed'").first("count")).toBe(1);
});

test("HTTP adapter streams ZIP upload and serves list, detail, and metadata patch", async () => {
  const { context, repository } = await setup();
  const writes = [];
  const handle = createTypeCardBundlesHttp(repository, { async put(object) { writes.push(object); } }, "https://bundles.unidocs.test");
  const base = "https://portal.test/admin/api/v1/type-card-bundles";
  const bytes = await archive("dt-markdown");
  const upload = await handle(new Request(`${base}?name=Primary&description=Candidate`, {
    method: "POST", headers: { "content-type": "application/zip", "idempotency-key": "http-upload" }, body: bytes,
  }), context, "request-upload");
  const uploadBody = await upload.text();
  expect(upload.status, uploadBody).toBe(201);
  const created = JSON.parse(uploadBody);
  expect(created).toMatchObject({ typeCardBundleId: expect.stringMatching(/^tb_[0-9a-f]{64}$/), etag: expect.stringMatching(/^"sha256-/) });
  expect(writes).toHaveLength(3);
  const list = await handle(new Request(`${base}?documentType=dt-markdown&limit=10`), context, "request-list");
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ items: [{ typeCardBundleId: created.typeCardBundleId, documentType: "dt-markdown", name: "Primary" }], nextCursor: null });
  const detail = await handle(new Request(`${base}/${created.typeCardBundleId}`), context, "request-detail");
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ typeCardBundleId: created.typeCardBundleId, manifest: { protocol: "unidocs-type-card/v1" } });
  const noPrecondition = await handle(new Request(`${base}/${created.typeCardBundleId}`, {
    method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "http-patch" }, body: '{"name":"Next","description":"Notes"}',
  }), context, "request-no-precondition");
  expect(noPrecondition.status).toBe(428);
  const patch = await handle(new Request(`${base}/${created.typeCardBundleId}`, {
    method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "http-patch", "if-match": created.etag }, body: '{"name":"Next","description":"Notes"}',
  }), context, "request-patch");
  expect(patch.status).toBe(200);
  expect(await patch.json()).toMatchObject({ typeCardBundleId: created.typeCardBundleId, etag: expect.not.stringMatching(created.etag) });
  const unsupported = await handle(new Request(`${base}?name=Bad&description=`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "bad-upload" }, body: "{}",
  }), context, "request-unsupported");
  expect(unsupported.status).toBe(415);
});