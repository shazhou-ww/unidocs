import { readFile } from "node:fs/promises";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "../../../packages/portal-service/node_modules/@zip.js/zip.js/index.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1PortalAuthRepository } from "../../../packages/cloudflare-portal/src/auth-repository.ts";
import { D1DocumentTypeRepository } from "../../../packages/cloudflare-portal/src/document-types-repository.ts";
import { D1ViewBundleRepository } from "../../../packages/cloudflare-portal/src/view-bundles-repository.ts";
import { createViewBundlesHttp } from "../../../packages/cloudflare-portal/src/view-bundles-http.ts";
import { adminMcpZipStream, createDocumentTypeService, createViewBundleService } from "../../../packages/portal-service/src/index.ts";

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
      name: "portal-view-bundles", modules: true, script: "export default { fetch() { return new Response('test'); } };",
      compatibilityDate: "2026-08-18", d1Databases: { DB: `portal-views-${crypto.randomUUID()}` },
    }],
  }));
  database = await miniflare.getD1Database("DB", "portal-view-bundles");
  for (const name of ["0001_admin_auth.sql", "0002_document_types.sql", "0003_document_contracts.sql", "0004_type_card_bundles.sql", "0005_view_bundles.sql", "0008_mcp_audit_attribution.sql"]) await migrate(name);
});

afterEach(async () => { await miniflare?.dispose(); });

async function archive(revisions = [0]) {
  const manifest = {
    protocol: "unidocs-view-bundle/v1", documentType: "dt-markdown",
    entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: revisions,
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-view.json", new TextReader(JSON.stringify(manifest)));
  await writer.add("view.html", new TextReader("<!doctype html><script type=module src=app.js></script>"));
  await writer.add("thumbnail.html", new TextReader("<!doctype html><main>Preview</main>"));
  await writer.add("app.js", new TextReader("export {};"));
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
  await typeService.create(context, { internalName: "Markdown" }, "create-type", "create-type");
  await database.prepare(`INSERT INTO portal_document_contracts
    (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES (?, 0, ?, '{}', ?)`)
    .bind("dt-markdown", "sha256:contract", now).run();
  const repository = new D1ViewBundleRepository(database, () => now);
  const writes = [];
  let auditId = 0;
  const service = createViewBundleService(repository, { async put(object) { writes.push(object); } }, {
    bundleOrigin: "https://bundles.unidocs.test", now: () => new Date(now * 1000), id: () => `audit-view-${++auditId}`,
  });
  return { context, types, repository, service, writes };
}

test("publishes a validated candidate with receipt, consumed reservation, and audit", async () => {
  const { context, service, writes } = await setup();
  const result = await service.upload(context, { name: "Primary", description: "" }, source(await archive()), "upload-view", "request-view");
  expect(result.viewBundleId).toMatch(/^vb_[0-9a-f]{64}$/);
  expect(writes).toHaveLength(4);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_view_bundles").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_view_bundle_reservations").first("count")).toBe(0);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'uploadViewBundle'").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'view_bundle.uploaded'").first("count")).toBe(1);
});

test("MCP View upload and metadata retain attribution on replay without ZIP input in audit", async () => {
  const { context, service } = await setup();
  const caller = { memberId: context.memberId, identity, transport: "bearer", caller: { channel: "mcp", oauthClientHandle: "a".repeat(64), toolName: "upload_view_bundle" } };
  const encoded = Buffer.from(await archive()).toString("base64");
  const upload = () => service.upload(caller, { name: "MCP", description: "" }, adminMcpZipStream(encoded), "mcp-upload", "upload-request");
  const created = await upload();
  expect(await upload()).toEqual(created);
  const metadataCaller = { ...caller, caller: { ...caller.caller, toolName: "update_view_bundle_metadata" } };
  const update = () => service.updateMetadata(metadataCaller, created.viewBundleId, { name: "Next", description: "" }, "mcp-update", created.etag, "update-request");
  expect(await update()).toEqual(await update());
  const rows = (await database.prepare("SELECT caller_channel, oauth_client_handle, tool_name, details_json FROM portal_admin_audit WHERE caller_channel = 'mcp' ORDER BY tool_name").all()).results;
  expect(rows.map(row => row.tool_name)).toEqual(["update_view_bundle_metadata", "upload_view_bundle"]);
  expect(rows.every(row => row.oauth_client_handle === "a".repeat(64))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(encoded);
  expect(JSON.stringify(rows)).not.toContain("view.html");
});

test("concurrent same-key uploads publish one candidate and replay one result", async () => {
  const { context, service } = await setup();
  const bytes = await archive();
  const results = await Promise.all(Array.from({ length: 4 }, () => service.upload(context, { name: "Primary", description: "" }, source(bytes), "same-key", "same-request")));
  expect(results.every(result => result.viewBundleId === results[0].viewBundleId && result.etag === results[0].etag)).toBe(true);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_view_bundles").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'uploadViewBundle'").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'view_bundle.uploaded'").first("count")).toBe(1);
}, 30_000);

test("rejects a manifest revision that is not registered", async () => {
  const { context, service, writes } = await setup();
  await expect(service.upload(context, { name: "Unsupported", description: "" }, source(await archive([1])), "upload-view", "request-view"))
    .rejects.toMatchObject({ code: "bundle_invalid" });
  expect(writes).toHaveLength(0);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_view_bundles").first("count")).toBe(0);
});

test("HTTP supports upload, list, detail, metadata patch, and document type resolution", async () => {
  const { context, types, repository } = await setup();
  const writes = [];
  const handle = createViewBundlesHttp(repository, { async put(object) { writes.push(object); } }, "https://bundles.unidocs.test");
  const base = "https://portal.test/admin/api/v1/view-bundles";
  const upload = await handle(new Request(`${base}?name=Primary&description=Candidate`, {
    method: "POST", headers: { "content-type": "application/zip", "idempotency-key": "http-upload" }, body: await archive(),
  }), context, "request-upload");
  const uploadBody = await upload.text();
  expect(upload.status, uploadBody).toBe(201);
  const created = JSON.parse(uploadBody);
  expect(writes).toHaveLength(4);
  const list = await handle(new Request(`${base}?documentType=dt-markdown&limit=10`), context, "request-list");
  expect(await list.json()).toMatchObject({ items: [{ viewBundleId: created.viewBundleId, supportedDocumentContractIdxs: [0] }], nextCursor: null });
  const detail = await handle(new Request(`${base}/${created.viewBundleId}`), context, "request-detail");
  expect(await detail.json()).toMatchObject({ viewBundleId: created.viewBundleId, manifest: { protocol: "unidocs-view-bundle/v1" } });
  expect((await types.resolveViewBundle(context, "dt-markdown", created.viewBundleId))?.etag).toBe(created.etag);
  const patch = await handle(new Request(`${base}/${created.viewBundleId}`, {
    method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "http-patch", "if-match": created.etag }, body: '{"name":"Next","description":"Notes"}',
  }), context, "request-patch");
  expect(patch.status).toBe(200);
  expect(await patch.json()).toMatchObject({ viewBundleId: created.viewBundleId, etag: expect.not.stringMatching(created.etag) });
  const stale = await handle(new Request(`${base}/${created.viewBundleId}`, {
    method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "http-stale", "if-match": created.etag }, body: '{"name":"Stale","description":""}',
  }), context, "request-stale");
  expect(stale.status).toBe(412);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'view_bundle.metadata_changed'").first("count")).toBe(1);
});
