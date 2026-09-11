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