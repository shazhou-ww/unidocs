import { beforeEach, describe, expect, test, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  tenant: vi.fn(async () => new Response("tenant")),
  admin: vi.fn(async () => new Response("admin")),
  mcp: vi.fn(async () => new Response("mcp")),
  migrate: vi.fn(async () => undefined),
  verify: vi.fn(async (_request: Request, route: { stackId: string; tenantId: string }) => ({
    stackId: route.stackId,
    tenantId: route.tenantId,
    subject: "caller",
    jti: "request-1",
    kid: "key-1",
    permissions: [],
  })),
}));

vi.mock("@unicas/server-cloudflare", () => ({
  default: { fetch: handlers.tenant },
  CasDurableObject: class {},
  RootRefDomainDurableObject: class {},
  migrateStackTenantSchema: handlers.migrate,
}));
vi.mock("@unicas/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unicas/service")>();
  return {
    ...actual,
    StackCapabilityVerifier: class {
      verify = handlers.verify;
    },
  };
});
vi.mock("@unicas/control-plane", () => ({
  AuthorityRepository: class {},
}));
vi.mock("@unicas/admin-webui", () => ({
  default: { fetch: handlers.admin },
}));
vi.mock("@unicas/control-plane-mcp", () => ({
  default: { fetch: handlers.mcp },
}));

import worker, { type Env } from "../src/worker.js";

const env = {
  CAS_CONTROL_DB: {},
  CAS_DB: {},
  CAS_R2: {},
  CAS_DO: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: handlers.tenant }),
  },
  CAS_DOMAIN_DO: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: vi.fn() }),
  },
  CAS_PUBLIC_ORIGIN: "https://cas.example",
  PUBLIC_ORIGIN: "https://cas.example",
} as unknown as Env;

const ctx = {} as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("service-cloudflare public routing", () => {
  test("serves health and rejects unknown or private internal routes", async () => {
    const health = await worker.fetch(new Request("https://cas.example/health"), env, ctx);
    await expect(health.json()).resolves.toEqual({ ok: true, service: "unicas" });

    for (const path of ["/", "/other", "/_internal/audit/refs", "/mcp/other"]) {
      expect((await worker.fetch(new Request(`https://cas.example${path}`), env, ctx)).status)
        .toBe(404);
    }
  });

  test("routes tenant protocol requests without admin cookies or internal secrets", async () => {
    await worker.fetch(new Request(
      "https://cas.example/stacks/s1/tenants/t1/cas/usage",
      {
        headers: {
          Authorization: "Bearer tenant-capability",
          Cookie: "cas_admin_session=secret",
          "X-Internal-Token": "internal",
          "X-Cas-Audit-Reader-Key": "reader",
        },
      },
    ), env, ctx);

    const authorizationRequest = handlers.verify.mock.calls[0]![0] as Request;
    expect(authorizationRequest.headers.get("Authorization")).toBe("Bearer tenant-capability");
    expect(authorizationRequest.headers.get("Cookie")).toBeNull();
    expect(authorizationRequest.headers.get("X-Internal-Token")).toBeNull();
    expect(authorizationRequest.headers.get("X-Cas-Audit-Reader-Key")).toBeNull();

    const actorRequest = handlers.tenant.mock.calls[0]![0] as Request;
    expect(actorRequest.headers.get("Authorization")).toBeNull();
    expect(actorRequest.headers.get("X-CAS-Stack-Id")).toBe("s1");
    expect(actorRequest.headers.get("X-CAS-Tenant-Id")).toBe("t1");
  });

  test("routes admin protocol and BFF requests without tenant bearer credentials", async () => {
    for (const path of ["/admin/me", "/admin/auth/login"]) {
      await worker.fetch(new Request(`https://cas.example${path}`, {
        headers: {
          Authorization: "Bearer tenant-capability",
          Cookie: "cas_admin_session=secret",
          "X-Cas-Audit-Reader-Key": "reader",
        },
      }), env, ctx);
    }

    for (const call of handlers.admin.mock.calls) {
      const request = call[0] as Request;
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.headers.get("Cookie")).toBe("cas_admin_session=secret");
      expect(request.headers.get("X-Cas-Audit-Reader-Key")).toBeNull();
    }
  });

  test("enforces MCP browser origin and strips cookies", async () => {
    const rejected = await worker.fetch(new Request("https://cas.example/mcp", {
      headers: { Origin: "https://attacker.example" },
    }), env, ctx);
    expect(rejected.status).toBe(403);
    expect(handlers.mcp).not.toHaveBeenCalled();

    await worker.fetch(new Request("https://cas.example/mcp", {
      headers: {
        Origin: "https://cas.example",
        Authorization: "Bearer mcp-token",
        Cookie: "cas_admin_session=secret",
      },
    }), env, ctx);
    const request = handlers.mcp.mock.calls[0]![0] as Request;
    expect(request.headers.get("Authorization")).toBe("Bearer mcp-token");
    expect(request.headers.get("Cookie")).toBeNull();
  });
});