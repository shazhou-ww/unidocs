import { describe, expect, test, vi } from "vitest";
import {
  createUniCasService,
  matchUniCasServiceRoute,
  type ServiceContext,
  type ServicePlatform,
} from "../src/index.js";

const tenantActorFetch = vi.fn(async () => new Response("tenant"));
const platform = {
  tenantActors: { fetch: tenantActorFetch },
} as unknown as ServicePlatform;

describe("createUniCasService", () => {
  test("dispatches tenant and admin protocol requests through one actor", async () => {
    const authorizeTenantRequest = vi.fn(async () => ({
      stackId: "s1",
      tenantId: "t1",
      subject: "caller",
      jti: "request-1",
      kid: "key-1",
      permissions: ["cas:manage:t1"],
    }));
    const handleAdminRequest = vi.fn(async () => new Response("admin"));
    const actor = createUniCasService({
      platform,
      authorizeTenantRequest,
      handleAdminRequest,
    });

    expect(await (await actor.fetch(new Request(
      "https://cas.example/stacks/s1/tenants/t1/cas/usage",
    ))).text()).toBe("tenant");
    expect(authorizeTenantRequest).toHaveBeenCalledWith(expect.objectContaining({
      platform,
      route: { operation: "usage", stackId: "s1", tenantId: "t1" },
    }));
    expect(tenantActorFetch).toHaveBeenCalledWith(
      "s1|t1",
      expect.objectContaining({ url: "https://tenant.internal/usage" }),
    );

    expect(await (await actor.fetch(new Request(
      "https://cas.example/admin/stacks/s1",
    ))).text()).toBe("admin");
    expect(handleAdminRequest).toHaveBeenCalledWith(expect.objectContaining({
      platform,
      route: { operation: "getStack", stackId: "s1" },
    }));
  });

  test("does not claim BFF, MCP, static asset, or unknown routes", async () => {
    const context = {
      platform,
      authorizeTenantRequest: vi.fn(),
      handleAdminRequest: vi.fn(),
    } as unknown as ServiceContext;
    const actor = createUniCasService(context);

    for (const path of [
      "/admin/auth/login",
      "/admin/assets/app.js",
      "/mcp",
      "/oauth/token",
      "/health",
    ]) {
      const request = new Request(`https://cas.example${path}`);
      expect(matchUniCasServiceRoute(request), path).toBeNull();
      expect((await actor.fetch(request)).status, path).toBe(404);
    }
    expect(context.authorizeTenantRequest).not.toHaveBeenCalled();
    expect(context.handleAdminRequest).not.toHaveBeenCalled();
  });

  test("builds trusted Root Ref actor requests from the authorized call", async () => {
    const actor = createUniCasService({
      platform,
      authorizeTenantRequest: async () => ({
        stackId: "stack/a",
        tenantId: "tenant/b",
        subject: "caller",
        jti: "request-2",
        kid: "key-1",
        permissions: ["cas:write:tenant/b"],
        refDomain: "doc",
      }),
      handleAdminRequest: vi.fn(),
    });
    const response = await actor.fetch(new Request(
      "https://cas.example/stacks/stack%2Fa/tenants/tenant%2Fb/root-refs",
      {
        method: "POST",
        headers: {
          "X-CAS-Stack-Id": "attacker",
          "X-CAS-Tenant-Id": "attacker",
          "X-CAS-Ref-Domain": "attacker",
        },
        body: JSON.stringify({ requestId: "r1", changes: { abc: 1 } }),
      },
    ));
    expect(await response.text()).toBe("tenant");
    const [key, forwarded] = tenantActorFetch.mock.calls.at(-1)!;
    expect(key).toBe("stack%2Fa|tenant%2Fb");
    expect(forwarded.headers.get("X-CAS-Stack-Id")).toBe("stack/a");
    expect(forwarded.headers.get("X-CAS-Tenant-Id")).toBe("tenant/b");
    expect(forwarded.headers.get("X-CAS-Ref-Domain")).toBe("doc");

    await actor.fetch(new Request(
      "https://cas.example/stacks/stack%2Fa/tenants/tenant%2Fb/root-refs?limit=10&cursor=abc",
      { headers: { "X-CAS-Ref-Domain": "attacker" } },
    ));
    const [readKey, readForwarded] = tenantActorFetch.mock.calls.at(-1)!;
    expect(readKey).toBe("stack%2Fa|tenant%2Fb");
    expect(readForwarded.url).toBe("https://tenant.internal/rootRefs?limit=10&cursor=abc");
    expect(readForwarded.method).toBe("GET");
    expect(readForwarded.headers.get("X-CAS-Ref-Domain")).toBe("doc");
  });
});