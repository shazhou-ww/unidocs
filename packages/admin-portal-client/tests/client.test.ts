import { expect, test, vi } from "vitest";
import { AdminPortalClientError, createAdminPortalClient } from "../src/index.js";

test("encodes list filters and mutation security headers", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => Response.json(init?.method === "POST" ? { documentType: "markdown", etag: '"sha256-value"' } : { items: [], nextCursor: null }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test/", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "generated-key" });
  await client.listDocumentTypes({ q: "mark down", enabled: false, limit: 25 });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/document-types?q=mark+down&enabled=false&limit=25");
  await client.createDocumentType({ internalName: "Markdown" });
  const headers = new Headers(fetcher.mock.calls[1][1]?.headers);
  expect(headers.get("x-csrf-token")).toBe("csrf");
  expect(headers.get("idempotency-key")).toBe("generated-key");
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include" });
});

test("surfaces stable API errors with request correlation", async () => {
  const client = createAdminPortalClient({ fetcher: async () => Response.json({ error: { code: "precondition_failed", message: "stale", requestId: "request-1" } }, { status: 412 }) });
  const error = await client.getDocumentType("markdown").catch(value => value);
  expect(error).toBeInstanceOf(AdminPortalClientError);
  expect(error).toMatchObject({ status: 412, code: "precondition_failed", message: "stale", requestId: "request-1" });
});

test("lists and adds administrator members through the typed transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => Response.json(init?.method === "POST"
    ? { adminId: "member-1", etag: '"sha256-member"' }
    : { items: [], nextCursor: null }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "member-key" });
  await client.listAdministrators({ limit: 50, cursor: "next" });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/administrators?limit=50&cursor=next");
  await client.addAdministrator({ email: "member@example.com" });
  expect(String(fetcher.mock.calls[1][0])).toBe("https://portal.test/admin/api/v1/administrators");
  expect(new Headers(fetcher.mock.calls[1][1]?.headers)).toMatchObject(expect.any(Headers));
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("idempotency-key")).toBe("member-key");
  expect(fetcher.mock.calls[1][1]?.body).toBe('{"email":"member@example.com"}');
});

test("attempts idempotent logout even when no CSRF cookie remains", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => null });
  await client.logout();
  expect(fetcher).toHaveBeenCalledWith("https://portal.test/admin/auth/logout", expect.objectContaining({ method: "POST", credentials: "include" }));
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("x-csrf-token")).toBe(false);
});

test("removes an administrator with CSRF, idempotency, and If-Match", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "remove-key" });
  await client.removeAdministrator("member/one", '"sha256-member"');
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/administrators/member%2Fone");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "DELETE", credentials: "include" });
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(headers.get("x-csrf-token")).toBe("csrf");
  expect(headers.get("idempotency-key")).toBe("remove-key");
  expect(headers.get("if-match")).toBe('"sha256-member"');
});

test("notifies the application before surfacing any unauthorized response", async () => {
  const onUnauthorized = vi.fn();
  const client = createAdminPortalClient({
    fetcher: async () => Response.json({ error: { code: "unauthorized", message: "Session expired", requestId: "request-401" } }, { status: 401 }),
    onUnauthorized,
  });
  const error = await client.listDocumentTypes().catch(value => value);
  expect(onUnauthorized).toHaveBeenCalledOnce();
  expect(onUnauthorized).toHaveBeenCalledWith(error);
  expect(error).toMatchObject({ status: 401, code: "unauthorized", requestId: "request-401" });
});

test("encodes audit filters and pagination", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [], nextCursor: null }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher });
  await client.listAuditEvents({
    actorId: "admin one", action: "administrator.added", resourceType: "administrator", documentType: "markdown",
    occurredFrom: "2026-09-10T00:00:00.000Z", occurredTo: "2026-09-11T00:00:00.000Z", limit: 50, cursor: "next"
  });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/audit-events?actorId=admin+one&action=administrator.added&resourceType=administrator&documentType=markdown&occurredFrom=2026-09-10T00%3A00%3A00.000Z&occurredTo=2026-09-11T00%3A00%3A00.000Z&limit=50&cursor=next");
});

test("lists, reads, and appends paired Document Contracts", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => Response.json(init?.method === "POST"
    ? { documentContractIdx: 0, contractHash: "sha256:contract" }
    : { items: [], nextCursor: null }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "contract-key" });
  await client.listDocumentContracts("markdown/type", { limit: 25, cursor: "next" });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/document-types/markdown%2Ftype/document-contracts?limit=25&cursor=next");
  await client.getDocumentContract("markdown/type", 3);
  expect(String(fetcher.mock.calls[1][0])).toBe("https://portal.test/admin/api/v1/document-types/markdown%2Ftype/document-contracts/3");
  const body = { formatVersion: 1 as const, snapshot: { schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" as const } }, location: { schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" as const } }, reason: "Initial" };
  await client.appendDocumentContract("markdown", body);
  const headers = new Headers(fetcher.mock.calls[2][1]?.headers);
  expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
  expect(headers.get("x-csrf-token")).toBe("csrf");
  expect(headers.get("idempotency-key")).toBe("contract-key");
});

test("uploads, lists, reads, and updates Type Card bundles", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ typeCardBundleId: "tb_bundle", etag: '"sha256-bundle"' }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "bundle-key" });
  const file = new Blob(["zip"], { type: "application/zip" });
  await client.uploadTypeCardBundle(file, { name: "Primary card", description: "Candidate" });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/type-card-bundles?name=Primary+card&description=Candidate");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: file, credentials: "include" });
  const uploadHeaders = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(uploadHeaders.get("content-type")).toBe("application/zip");
  expect(uploadHeaders.get("x-csrf-token")).toBe("csrf");
  expect(uploadHeaders.get("idempotency-key")).toBe("bundle-key");
  await client.listTypeCardBundles("markdown/type", { limit: 10, cursor: "next" });
  expect(String(fetcher.mock.calls[1][0])).toBe("https://portal.test/admin/api/v1/type-card-bundles?documentType=markdown%2Ftype&limit=10&cursor=next");
  await client.getTypeCardBundle("tb/one");
  expect(String(fetcher.mock.calls[2][0])).toBe("https://portal.test/admin/api/v1/type-card-bundles/tb%2Fone");
  await client.updateTypeCardBundleMetadata("tb_bundle", { name: "Next", description: "Notes" }, '"sha256-old"');
  const patchHeaders = new Headers(fetcher.mock.calls[3][1]?.headers);
  expect(fetcher.mock.calls[3][1]).toMatchObject({ method: "PATCH", body: '{"name":"Next","description":"Notes"}' });
  expect(patchHeaders.get("if-match")).toBe('"sha256-old"');
});

test("uploads, lists, reads, and updates View bundles", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ viewBundleId: "vb_bundle", etag: '"sha256-bundle"' }));
  const client = createAdminPortalClient({ baseUrl: "https://portal.test", fetcher, getCsrfToken: () => "csrf", createIdempotencyKey: () => "view-key" });
  const file = new Blob(["zip"], { type: "application/zip" });
  await client.uploadViewBundle(file, { name: "Primary view", description: "Candidate" });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://portal.test/admin/api/v1/view-bundles?name=Primary+view&description=Candidate");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: file, credentials: "include" });
  const uploadHeaders = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(uploadHeaders.get("content-type")).toBe("application/zip");
  expect(uploadHeaders.get("x-csrf-token")).toBe("csrf");
  expect(uploadHeaders.get("idempotency-key")).toBe("view-key");
  await client.listViewBundles("markdown/type", { limit: 10, cursor: "next" });
  expect(String(fetcher.mock.calls[1][0])).toBe("https://portal.test/admin/api/v1/view-bundles?documentType=markdown%2Ftype&limit=10&cursor=next");
  await client.getViewBundle("vb/one");
  expect(String(fetcher.mock.calls[2][0])).toBe("https://portal.test/admin/api/v1/view-bundles/vb%2Fone");
  await client.updateViewBundleMetadata("vb_bundle", { name: "Next", description: "Notes" }, '"sha256-old"');
  const patchHeaders = new Headers(fetcher.mock.calls[3][1]?.headers);
  expect(fetcher.mock.calls[3][1]).toMatchObject({ method: "PATCH", body: '{"name":"Next","description":"Notes"}' });
  expect(patchHeaders.get("if-match")).toBe('"sha256-old"');
});