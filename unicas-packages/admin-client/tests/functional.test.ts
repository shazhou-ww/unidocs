import { beforeEach, describe, expect, it } from "vitest";
import { casAdminRoutes } from "@unicas/admin-protocol";
import type { CasAdminPage } from "@unicas/admin-protocol";
import { createAdminClient } from "../src/index.js";
import type { AdminHttpFetcher, AdminClientSession } from "../src/index.js";

const STACK = "cas_stack_a";

/** Minimal in-memory fake of the /admin BFF API. */
class MockAdminService implements AdminHttpFetcher {
  readonly requests: { path: string; method: string; cookie: string | null; csrf: string | null }[] = [];
  readonly stack = {
    stackId: STACK,
    displayName: "Ops",
    description: "",
    status: "active" as const,
    createdAt: 1,
    revision: 3,
  };
  session = true;

  async fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const cookie = request.headers.get("Cookie");
    const csrf = request.headers.get("X-CSRF-Token");
    this.requests.push({ path: url.pathname, method: request.method, cookie, csrf });
    if (!this.session) {
      return Response.json({ error: "ADMIN_AUTH_REQUIRED", message: "session required" }, { status: 401 });
    }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && csrf !== "csrf-1") {
      return Response.json({ error: "CSRF_REJECTED" }, { status: 403 });
    }
    const path = url.pathname;

    if (path === casAdminRoutes.me()) {
      return Response.json({
        identity: { identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" },
        memberships: [{ stackId: STACK, identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" }],
      });
    }
    if (path === casAdminRoutes.stacks() && request.method === "GET") {
      const page: CasAdminPage<typeof this.stack> = { items: [this.stack], nextCursor: null };
      return Response.json(page);
    }
    if (path === casAdminRoutes.stack({ stackId: STACK }) && request.method === "GET") {
      return Response.json(this.stack, { headers: { ETag: `"rev-${this.stack.revision}"` } });
    }
    if (path === casAdminRoutes.stack({ stackId: STACK }) && request.method === "PATCH") {
      this.stack.revision += 1;
      return Response.json(this.stack, { headers: { ETag: `"rev-${this.stack.revision}"` } });
    }
    if (path === casAdminRoutes.issuer({ stackId: STACK }) && request.method === "GET") {
      return Response.json({
        stackId: STACK,
        issuer: "https://issuer.example",
        audience: "unidocs-cas",
        status: "active",
        revision: 2,
      }, { headers: { ETag: `"rev-2"` } });
    }
    if (path === casAdminRoutes.issuerKeys({ stackId: STACK }) && request.method === "GET") {
      return Response.json({ keys: [] });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
}

function sessionOf(): Promise<AdminClientSession> {
  return Promise.resolve({ cookie: "cas_admin_session=abc", csrfToken: "csrf-1" });
}

describe("functional admin client", () => {
  let service: MockAdminService;
  let client: ReturnType<typeof createAdminClient>;

  beforeEach(() => {
    service = new MockAdminService();
    client = createAdminClient({ baseUrl: "https://admin.test", getSession: sessionOf, fetcher: service.fetch.bind(service) });
  });

  it("reads identity and typed pages", async () => {
    const me = await client.me();
    expect(me.identity.subject).toBe("sub-1");
    expect(me.memberships[0]!.stackId).toBe(STACK);

    const stacks = await client.listStacks();
    expect(stacks.items[0]!.displayName).toBe("Ops");
    expect(stacks.nextCursor).toBeNull();
  });

  it("returns ETag on etag-sensitive reads and sends it as If-Match on mutations", async () => {
    const { value, etag } = await client.getStack({ stackId: STACK });
    expect(value.revision).toBe(3);
    expect(etag).toBe('"rev-3"');
    expect(service.requests[0]!.cookie).toBe("cas_admin_session=abc");
  });

  it("attaches CSRF to mutations", async () => {
    await client.patchStack({ stackId: STACK }, { description: "x" }, '"rev-3"');
    const mutation = service.requests.find(r => r.method === "PATCH")!;
    expect(mutation.csrf).toBe("csrf-1");
    expect(mutation.path).toBe(casAdminRoutes.stack({ stackId: STACK }));
  });

  it("forces re-login after a 401 session failure", async () => {
    service.session = false;
    await expect(client.me()).rejects.toMatchObject({ status: 401, code: "ADMIN_AUTH_REQUIRED" });
    service.session = true;
    const me = await client.me();
    expect(me.identity.subject).toBe("sub-1");
  });
});
