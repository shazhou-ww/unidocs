import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { AdminDirectory, AdminTypeDirectory, adminTypeEtag, createAdminHandler } from "@unidocs/gateway-common";
import { SqliteAdminDirectoryStore } from "../src/admin-directory-sqlite.js";

const databases: DatabaseSync[] = [];
const baseUrl = "https://types.example.com/markdown/";
const nextUrl = "https://next.example.com/markdown/";
const descriptor = { docType: "markdown", displayName: "Markdown", description: "Text documents", serviceId: "md", storageIdentity: "storage", audience: "md", protocol: "unidocs-doctype/1", editorProtocol: "0.1", formats: [".md"], capabilities: { preview: true, edit: false } };
const policy = [baseUrl, nextUrl].map(url => ({ baseUrl: url, ...descriptor }));
async function setup() {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  const store = new SqliteAdminDirectoryStore({
    sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings); return { toArray: () => rows }; } },
    transactionSync(callback) { database.exec("BEGIN IMMEDIATE"); try { const result = callback(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  });
  const directory = new AdminDirectory(store);
  const identity = { issuer: "https://accounts.google.com", email: "alice@example.com", subject: "alice", emailVerified: true };
  await directory.bootstrap(identity.email);
  const self = await directory.bindGoogleIdentity(identity);
  const actor = { ...identity, adminId: self.adminId };
  let now = Date.now();
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith("unidocs-doctype") ? Response.json(descriptor) : new Response(null, { headers: { "Content-Type": "text/html" } }));
  const types = new AdminTypeDirectory(directory, policy, fetcher, () => now);
  const register = async () => { const validation = await types.validate(actor, { baseUrl }); return types.register(actor, { baseUrl, enabled: true, validationId: validation.validationId }, "register"); };
  return { database, directory, actor, fetcher, types, register, advance: (ms: number) => { now += ms; } };
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

it("stores enabled as target configuration without requiring an embedded editor or probing it", async () => {
  const fixture = await setup();
  fixture.fetcher.mockImplementation(async input => String(input).endsWith("unidocs-doctype")
    ? Response.json({ ...descriptor, editorProtocol: null, capabilities: { preview: false, edit: false } }) : new Response(null));
  const validation = await fixture.types.validate(fixture.actor, { baseUrl });
  expect(fixture.fetcher.mock.calls.map(call => String(call[0]))).toEqual([`${baseUrl}.well-known/unidocs-doctype`, `${baseUrl}health`]);
  const record = await fixture.types.register(fixture.actor, { baseUrl, enabled: false, validationId: validation.validationId }, "disabled");
  const again = await fixture.types.validate(fixture.actor, { baseUrl, expectedDocType: record.docType, expectedConfigEtag: adminTypeEtag(record) });
  await fixture.types.update(fixture.actor, record.docType, adminTypeEtag(record), { enabled: true, validationId: again.validationId, reason: "enable target" }, "enable");
  expect((await fixture.types.get(fixture.actor, record.docType)).enabled).toBe(true);
});

it("discovers only an approved directory without credentials or redirect following, then registers once", async () => {
  const fixture = await setup();
  await expect(fixture.types.validate(fixture.actor, { baseUrl: "https://evil.test/" })).rejects.toMatchObject({ code: "url_not_approved" });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  const validation = await fixture.types.validate(fixture.actor, { baseUrl }, "validation");
  expect(await fixture.types.validate(fixture.actor, { baseUrl }, "validation")).toEqual(validation);
  await expect(fixture.types.validate(fixture.actor, { baseUrl: nextUrl }, "validation")).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await fixture.types.list(fixture.actor)).toEqual([]);
  expect(fixture.fetcher.mock.calls.map(call => String(call[0]))).toEqual([`${baseUrl}.well-known/unidocs-doctype`, `${baseUrl}health`, `${baseUrl}editor/`]);
  for (const call of fixture.fetcher.mock.calls) expect(call[1]).toMatchObject({ redirect: "error", credentials: "omit" });
  const input = { baseUrl, enabled: true, validationId: validation.validationId };
  const first = await fixture.types.register(fixture.actor, input, "register");
  expect(await fixture.types.register(fixture.actor, input, "register")).toEqual(first);
  await expect(fixture.types.register(fixture.actor, { ...input, enabled: false }, "register")).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await fixture.types.list(fixture.actor)).toHaveLength(1);
});

it("rejects malformed, excessive or unapproved descriptors without persisting validation", async () => {
  const fixture = await setup();
  for (const body of [{ ...descriptor, storageIdentity: "other" }, { ...descriptor, protocol: "unknown" }, { ...descriptor, description: "x".repeat(20_000) }]) {
    fixture.fetcher.mockImplementationOnce(async () => Response.json(body));
    await expect(fixture.types.validate(fixture.actor, { baseUrl })).rejects.toMatchObject({ status: 422 });
  }
  expect(fixture.database.prepare("SELECT * FROM unidocs_admin_url_validations").all()).toEqual([]);
});

it("binds verification to original URL, config and expiry, but lets unavailable services be disabled", async () => {
  const fixture = await setup(); const first = await fixture.register();
  const validation = await fixture.types.validate(fixture.actor, { baseUrl: nextUrl, expectedDocType: first.docType, expectedConfigEtag: adminTypeEtag(first) });
  await expect(fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), { baseUrl: "https://changed.example.com/", validationId: validation.validationId, reason: "switch" }, "invalid")).rejects.toMatchObject({ code: "validation_required" });
  fixture.advance(15 * 60_000);
  await expect(fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), { baseUrl: nextUrl, validationId: validation.validationId, reason: "switch" }, "expired")).rejects.toMatchObject({ code: "validation_required" });
  fixture.fetcher.mockRejectedValue(new Error("offline"));
  const disabled = await fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), { enabled: false, reason: "maintenance" }, "disable");
  expect(disabled.enabled).toBe(false);
  await expect(fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), { enabled: true, reason: "stale" }, "stale")).rejects.toMatchObject({ status: 412 });
  await expect(fixture.types.update(fixture.actor, first.docType, adminTypeEtag(disabled), { enabled: true, reason: "enable" }, "enable")).rejects.toMatchObject({ status: 422 });
});

it("switches validated URL atomically without changing identity and rolls back if auditing fails", async () => {
  const fixture = await setup(); const first = await fixture.register();
  const validation = await fixture.types.validate(fixture.actor, { baseUrl: nextUrl, expectedDocType: first.docType, expectedConfigEtag: adminTypeEtag(first) });
  const input = { baseUrl: nextUrl, validationId: validation.validationId, reason: "switch" };
  fixture.database.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON unidocs_admin_audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
  await expect(fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), input, "switch")).rejects.toThrow("audit failure");
  expect(await fixture.types.get(fixture.actor, first.docType)).toEqual(first);
  fixture.database.exec("DROP TRIGGER fail_audit");
  const next = await fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), input, "switch");
  expect(next).toMatchObject({ baseUrl: nextUrl, enabled: true, descriptor: { serviceId: "md" }, revision: 2 });
  expect(await fixture.types.update(fixture.actor, first.docType, adminTypeEtag(first), input, "switch")).toEqual(next);
});

it("rechecks administrator authority after network discovery and before mutation", async () => {
  const fixture = await setup();
  const identity = { issuer: "https://accounts.google.com", email: "bob@example.com", subject: "bob", emailVerified: true };
  await fixture.directory.add(fixture.actor, identity.email, "bob");
  const bob = await fixture.directory.bindGoogleIdentity(identity);
  const actor = { ...identity, adminId: bob.adminId };
  fixture.fetcher.mockImplementationOnce(async () => {
    await fixture.directory.remove(fixture.actor, bob.adminId, bob.revision, "remove-bob");
    return Response.json(descriptor);
  });
  await expect(fixture.types.validate(actor, { baseUrl })).rejects.toMatchObject({ status: 403 });
  expect(fixture.database.prepare("SELECT * FROM unidocs_admin_url_validations").all()).toEqual([]);
});

it("serves protected directory APIs with whitelisted payloads and required mutation preconditions", async () => {
  const fixture = await setup();
  const timestamp = Date.now();
  const options = { directory: fixture.directory, origin: "https://admin.test", currentSession: async () => ({ actor: fixture.actor, csrfToken: "csrf", authenticatedAt: timestamp, expiresAt: timestamp + 60_000 }) };
  const handler = createAdminHandler({ ...options, types: fixture.types });
  const headers = { Origin: "https://admin.test", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "Idempotency-Key": "validate" };
  const send = (path: string, init?: RequestInit) => handler(new Request(`https://admin.test/admin/api/v1${path}`, init));
  expect((await createAdminHandler(options)(new Request("https://admin.test/admin/api/v1/document-types")))!.status).toBe(501);
  expect((await send("/url-validations", { method: "POST", body: "{}" }))!.status).toBe(403);
  expect((await send("/url-validations", { method: "POST", headers, body: JSON.stringify({ baseUrl, serviceId: "injected" }) }))!.status).toBe(400);
  const validation = await (await send("/url-validations", { method: "POST", headers, body: JSON.stringify({ baseUrl }) }))!.json() as { data: { validationId: string } };
  expect(JSON.stringify(validation)).not.toContain("policyKey");
  const created = (await send("/document-types", { method: "POST", headers: { ...headers, "Idempotency-Key": "register" }, body: JSON.stringify({ baseUrl, enabled: true, validationId: validation.data.validationId }) }))!;
  expect(created.status).toBe(201);
  const etag = created.headers.get("ETag")!;
  expect((await send("/document-types/markdown", { method: "PATCH", headers, body: JSON.stringify({ enabled: false, reason: "maintenance" }) }))!.status).toBe(428);
  expect((await send("/document-types/markdown", { method: "PATCH", headers: { ...headers, "Idempotency-Key": "disable", "If-Match": etag }, body: JSON.stringify({ enabled: false, reason: "maintenance" }) }))!.status).toBe(200);
  const list = (await send("/document-types?enabled=false&q=mark"))!;
  expect(list.headers.get("Cache-Control")).toBe("no-store");
  expect(await list.json()).toMatchObject({ items: [{ docType: "markdown", enabled: false }], nextCursor: null });
  expect((await send("/document-types?enabled=maybe"))!.status).toBe(400);
  expect((await send("/document-types?cursor=invalid"))!.status).toBe(400);
  expect((await send("/document-types?limit=101"))!.status).toBe(400);
});