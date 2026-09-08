import { expect, it, vi } from "vitest";
import { AdminDirectory } from "@unidocs/gateway-common";
import { createAdminTypes } from "../src/admin-type-service.js";

it("only probes exact approved endpoints through a fixed service binding, never following redirects", async () => {
  const directory = { authorized: async (_actor: unknown, callback: (value: unknown) => unknown) => callback({ validation: () => null }) } as unknown as AdminDirectory;
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }));
  const types = createAdminTypes(directory, { ADMIN_MARKDOWN_SERVICE: { fetch } as unknown as Fetcher, ADMIN_MARKDOWN_BASE_URL: "https://md.test/", ADMIN_MARKDOWN_SERVICE_ID: "md", ADMIN_MARKDOWN_STORAGE_IDENTITY: "store", ADMIN_MARKDOWN_AUDIENCE: "md" });
  const actor = { adminId: "test", issuer: "https://accounts.google.com", subject: "test", email: "test@example.com", emailVerified: true };
  await expect(types.validate(actor, { baseUrl: "https://other.test/" })).rejects.toMatchObject({ code: "url_not_approved" });
  expect(fetch).not.toHaveBeenCalled();
  await expect(types.validate(actor, { baseUrl: "https://md.test/" })).rejects.toMatchObject({ code: "redirect_not_allowed" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0]![0] as unknown as Request;
  expect(request.url).toBe("https://md.test/.well-known/unidocs-doctype");
  expect(request.redirect).toBe("manual");
  expect(request.headers.get("Authorization")).toBeNull();
  expect(() => createAdminTypes(directory, { ADMIN_MARKDOWN_BASE_URL: "https://md.test/" })).toThrow("Incomplete");
});