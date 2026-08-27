import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { CAS_EDGE_DISPATCH } from "../src/worker.js";
import worker from "../src/worker.js";
import type { Env } from "../src/worker.js";

function stubEnv(): {
  env: Env;
  tenantFetch: ReturnType<typeof vi.fn>;
  adminFetch: ReturnType<typeof vi.fn>;
} {
  const tenantFetch = vi.fn(async () => new Response("tenant", { status: 200 }));
  const adminFetch = vi.fn(async () => new Response("admin", { status: 200 }));
  return {
    env: {
      CAS_TENANT_SERVICE: { fetch: tenantFetch },
      CAS_ADMIN_SERVICE: { fetch: adminFetch },
    } as unknown as Env,
    tenantFetch,
    adminFetch,
  };
}

describe("cas-edge package boundary", () => {
  test("is private and does not depend on tenant DO implementation packages", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).not.toHaveProperty("@unicas/server-common");
    expect(CAS_EDGE_DISPATCH).toEqual({
      tenantPrefix: "/stacks",
      adminPrefix: "/admin",
    });
  });

  test("rejects paths outside /stacks and /admin; /health is the edge readiness", async () => {
    const { env } = stubEnv();
    const res = await worker.fetch(new Request("https://cas.example/health"), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, service: "cas-edge" });

    expect((await worker.fetch(new Request("https://cas.example/other"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://cas.example/"), env)).status).toBe(404);
  });

  test("never forwards the private audit-reader RPC or legacy internal paths", async () => {
    const { env, tenantFetch, adminFetch } = stubEnv();
    for (const path of [
      "/_internal/audit/refs",
      "/_internal/root-refs",
      "/tenants/t/cas/usage",
      "/admin/../../_internal/audit/events",
    ]) {
      const res = await worker.fetch(new Request(`https://cas.example${path}`), env);
      expect(res.status, path).toBe(404);
    }
    expect(tenantFetch).not.toHaveBeenCalled();
    expect(adminFetch).not.toHaveBeenCalled();
  });

  test("forwards /stacks to the tenant service, stripping admin cookies and shared secrets", async () => {
    const { env, tenantFetch, adminFetch } = stubEnv();
    const res = await worker.fetch(
      new Request("https://cas.example/stacks/unidocs-cloudflare/tenants/t1/root-refs", {
        method: "POST",
        headers: {
          Authorization: "Bearer tenant-capability",
          "Content-Type": "application/json",
          Cookie: "admin_session=secret",
          "X-Internal-Token": "shared-key",
          "X-Cas-Audit-Reader-Key": "reader-secret",
        },
        body: JSON.stringify({ requestId: "r", changes: {} }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(adminFetch).not.toHaveBeenCalled();
    expect(tenantFetch).toHaveBeenCalledTimes(1);
    const forwarded = tenantFetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toContain("/stacks/unidocs-cloudflare/tenants/t1/root-refs");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer tenant-capability");
    expect(forwarded.headers.get("Content-Type")).toBe("application/json");
    expect(forwarded.headers.get("Cookie")).toBeNull();
    expect(forwarded.headers.get("X-Internal-Token")).toBeNull();
    expect(forwarded.headers.get("X-Cas-Audit-Reader-Key")).toBeNull();
  });

  test("forwards /admin to the admin service, stripping tenant Bearer Authorization", async () => {
    const { env, tenantFetch, adminFetch } = stubEnv();
    const res = await worker.fetch(
      new Request("https://cas.example/admin/me", {
        headers: {
          Cookie: "admin_session=secret",
          Authorization: "Bearer tenant-capability",
          "X-Cas-Audit-Reader-Key": "reader-secret",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(tenantFetch).not.toHaveBeenCalled();
    expect(adminFetch).toHaveBeenCalledTimes(1);
    const forwarded = adminFetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toContain("/admin/me");
    expect(forwarded.headers.get("Cookie")).toBe("admin_session=secret");
    expect(forwarded.headers.get("Authorization")).toBeNull();
    expect(forwarded.headers.get("X-Cas-Audit-Reader-Key")).toBeNull();
  });

  test("forwards Basic credentials for the configured admin test account", async () => {
    const { env, adminFetch } = stubEnv();
    await worker.fetch(
      new Request("https://cas.example/admin/auth/login?test-account=1", {
        headers: { Authorization: "Basic dGVzdGVyQGV4YW1wbGUuY29tOnBhc3N3b3Jk" },
      }),
      env,
    );

    const forwarded = adminFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("Authorization")).toBe(
      "Basic dGVzdGVyQGV4YW1wbGUuY29tOnBhc3N3b3Jk",
    );
  });

  test("strips non-Basic authorization schemes from admin requests", async () => {
    const { env, adminFetch } = stubEnv();
    await worker.fetch(
      new Request("https://cas.example/admin/auth/login", {
        headers: { Authorization: "Digest credentials" },
      }),
      env,
    );

    const forwarded = adminFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("Authorization")).toBeNull();
  });
});
