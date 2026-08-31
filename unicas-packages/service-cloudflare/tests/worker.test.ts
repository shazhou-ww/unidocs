import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
} from "@unicas/tenant-protocol";

const handlers = vi.hoisted(() => ({
  tenant: vi.fn(async () => new Response("tenant")),
  admin: vi.fn(async () => new Response("admin")),
  mcp: vi.fn(async () => new Response("mcp")),
  migrate: vi.fn(async () => undefined),
  tenantIdFromName: vi.fn((name: string) => `do:${name}`),
  tenantGet: vi.fn((_id: string) => ({ fetch: undefined as unknown })),
  verify: vi.fn(async (_request: Request, route: { stackId: string; tenantId: string }) => ({
    stackId: route.stackId,
    tenantId: route.tenantId,
    subject: "caller",
    jti: "request-1",
    kid: "key-1",
    permissions: [],
  })),
}));

vi.mock("../src/schema.js", () => ({
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
  AuthorityRepository: class { },
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
    idFromName: handlers.tenantIdFromName,
    get: handlers.tenantGet,
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
  handlers.tenantGet.mockImplementation(() => ({ fetch: handlers.tenant }));
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

  test("dispatches tenant operations to the canonical Durable Object with trusted headers", async () => {
    const hash = "a".repeat(64);
    await worker.fetch(new Request(
      `https://cas.example/stacks/s1/tenants/t1/cas/nodes/${hash}/content`,
      {
        headers: {
          Authorization: "Bearer tenant-capability",
          Range: "bytes=10-19",
          "X-CAS-Stack-Id": "forged-stack",
          "X-CAS-Tenant-Id": "forged-tenant",
          "X-CAS-Hash": "forged-hash",
        },
      },
    ), env, ctx);

    expect(handlers.tenantIdFromName).toHaveBeenLastCalledWith("s1|t1");
    expect(handlers.tenantGet).toHaveBeenLastCalledWith("do:s1|t1");
    const readRequest = handlers.tenant.mock.calls[0]![0] as Request;
    expect(new URL(readRequest.url).pathname).toBe("/read");
    expect(readRequest.headers.get("Authorization")).toBeNull();
    expect(readRequest.headers.get("X-CAS-Stack-Id")).toBe("s1");
    expect(readRequest.headers.get("X-CAS-Tenant-Id")).toBe("t1");
    expect(readRequest.headers.get("X-CAS-Hash")).toBe(hash);
    expect(readRequest.headers.get("Range")).toBe("bytes=10-19");

    await worker.fetch(new Request(
      `https://cas.example/stacks/s1/tenants/t1/cas/nodes/${hash}/lease`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer tenant-capability",
          "Content-Type": "application/vnd.unidocs.cas-node.v1",
          "X-CAS-Lease-Duration": "120000",
          "X-CAS-Ref-Domain": "forged-domain",
        },
        body: "node-content",
      },
    ), env, ctx);
    const leaseRequest = handlers.tenant.mock.calls[1]![0] as Request;
    expect(new URL(leaseRequest.url).pathname).toBe("/lease");
    expect(leaseRequest.headers.get("X-CAS-Hash")).toBe(hash);
    expect(leaseRequest.headers.get("X-CAS-Lease-Duration")).toBe("120000");
    expect(leaseRequest.headers.get("Content-Type")).toBe("application/vnd.unidocs.cas-node.v1");
    expect(leaseRequest.headers.get("X-CAS-Ref-Domain")).toBeNull();
    expect(await leaseRequest.text()).toBe("node-content");

    handlers.verify.mockResolvedValueOnce({
      stackId: "s1",
      tenantId: "t1",
      subject: "caller",
      jti: "request-2",
      kid: "key-1",
      permissions: [],
      refDomain: "doc",
    });
    await worker.fetch(new Request(
      "https://cas.example/stacks/s1/tenants/t1/root-refs",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer tenant-capability",
          "Content-Type": "application/json",
          "X-CAS-Ref-Domain": "forged-domain",
        },
        body: JSON.stringify({ requestId: "r1", changes: { [hash]: 1 } }),
      },
    ), env, ctx);
    const rootRefsRequest = handlers.tenant.mock.calls[2]![0] as Request;
    expect(new URL(rootRefsRequest.url).pathname).toBe("/updateRootRefs");
    expect(rootRefsRequest.headers.get("X-CAS-Stack-Id")).toBe("s1");
    expect(rootRefsRequest.headers.get("X-CAS-Tenant-Id")).toBe("t1");
    expect(rootRefsRequest.headers.get("X-CAS-Ref-Domain")).toBe("doc");
    await expect(rootRefsRequest.json()).resolves.toEqual({
      requestId: "r1",
      changes: { [hash]: 1 },
    });
  });

  test("returns verifier authentication and authorization failures without Durable Object dispatch", async () => {
    handlers.verify.mockRejectedValueOnce(new CapabilityAuthenticationError(
      "missing_token",
      "CAS capability token is required",
    ));
    const unauthenticated = await worker.fetch(new Request(
      "https://cas.example/stacks/s1/tenants/t1/cas/usage",
    ), env, ctx);
    expect(unauthenticated.status).toBe(401);

    handlers.verify.mockRejectedValueOnce(new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "CAS capability stack does not match the requested path",
    ));
    const forbidden = await worker.fetch(new Request(
      "https://cas.example/stacks/s1/tenants/t1/cas/usage",
      { headers: { Authorization: "Bearer wrong-stack-capability" } },
    ), env, ctx);
    expect(forbidden.status).toBe(403);
    expect(handlers.tenant).not.toHaveBeenCalled();
    expect(handlers.tenantIdFromName).not.toHaveBeenCalled();
    expect(handlers.tenantGet).not.toHaveBeenCalled();
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