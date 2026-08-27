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
  mcpFetch: ReturnType<typeof vi.fn>;
} {
  const tenantFetch = vi.fn(async () => new Response("tenant", { status: 200 }));
  const adminFetch = vi.fn(async () => new Response("admin", { status: 200 }));
  const mcpFetch = vi.fn(async () => new Response("mcp", { status: 200 }));
  return {
    env: {
      CAS_TENANT_SERVICE: { fetch: tenantFetch },
      CAS_ADMIN_SERVICE: { fetch: adminFetch },
      CAS_MCP_SERVICE: { fetch: mcpFetch },
      CAS_PUBLIC_ORIGIN: "https://cas.example",
    } as unknown as Env,
    tenantFetch,
    adminFetch,
    mcpFetch,
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
      mcpPath: "/mcp",
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

  test("forwards only /mcp to the MCP service, preserving Bearer auth and stripping cookies", async () => {
    const { env, tenantFetch, adminFetch, mcpFetch } = stubEnv();
    const response = await worker.fetch(
      new Request("https://cas.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer mcp-access-token",
          Accept: "application/json, text/event-stream",
          Cookie: "cas_admin_session=secret",
          "MCP-Protocol-Version": "2026-07-28",
          "X-Cas-Audit-Reader-Key": "reader-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(tenantFetch).not.toHaveBeenCalled();
    expect(adminFetch).not.toHaveBeenCalled();
    expect(mcpFetch).toHaveBeenCalledTimes(1);
    const forwarded = mcpFetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toBe("https://cas.example/mcp");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer mcp-access-token");
    expect(forwarded.headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(forwarded.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(forwarded.headers.get("Cookie")).toBeNull();
    expect(forwarded.headers.get("X-Cas-Audit-Reader-Key")).toBeNull();

    expect((await worker.fetch(new Request("https://cas.example/mcp/other"), env)).status).toBe(404);
  });

  test("rejects untrusted browser Origins on /mcp while allowing non-browser clients", async () => {
    const { env, mcpFetch } = stubEnv();
    const rejected = await worker.fetch(new Request("https://cas.example/mcp", {
      headers: { Origin: "https://attacker.example" },
    }), env);
    expect(rejected.status).toBe(403);
    expect(mcpFetch).not.toHaveBeenCalled();

    const trusted = await worker.fetch(new Request("https://cas.example/mcp", {
      headers: { Origin: "https://cas.example" },
    }), env);
    expect(trusted.status).toBe(200);
    expect(mcpFetch).toHaveBeenCalledTimes(1);

    await worker.fetch(new Request("https://cas.example/mcp"), env);
    expect(mcpFetch).toHaveBeenCalledTimes(2);
  });

  test("forwards only the OAuth route allowlist to the MCP service", async () => {
    const { env, mcpFetch } = stubEnv();
    const paths = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
      "/oauth/google/callback",
      "/oauth/token",
      "/oauth/register",
    ];

    for (const path of paths) {
      expect((await worker.fetch(new Request(`https://cas.example${path}`), env)).status, path).toBe(200);
    }
    expect(mcpFetch).toHaveBeenCalledTimes(paths.length);
    expect((await worker.fetch(new Request("https://cas.example/oauth/other"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://cas.example/.well-known/other"), env)).status).toBe(404);
  });

  test("isolates credentials by OAuth route class", async () => {
    const { env, mcpFetch } = stubEnv();
    const sensitiveHeaders = {
      Authorization: "Basic client-credentials",
      Cookie: "cas_admin_session=admin; unicas_mcp_oauth=transaction; unrelated=value",
      "X-Internal-Token": "internal",
    };

    await worker.fetch(new Request("https://cas.example/.well-known/oauth-authorization-server", {
      headers: sensitiveHeaders,
    }), env);
    await worker.fetch(new Request("https://cas.example/oauth/authorize", {
      headers: sensitiveHeaders,
    }), env);
    await worker.fetch(new Request("https://cas.example/oauth/token", {
      method: "POST",
      headers: sensitiveHeaders,
      body: "grant_type=authorization_code",
    }), env);

    const metadata = mcpFetch.mock.calls[0][0] as Request;
    expect(metadata.headers.get("Authorization")).toBeNull();
    expect(metadata.headers.get("Cookie")).toBeNull();
    expect(metadata.headers.get("X-Internal-Token")).toBeNull();

    const authorize = mcpFetch.mock.calls[1][0] as Request;
    expect(authorize.headers.get("Authorization")).toBeNull();
    expect(authorize.headers.get("Cookie")).toBe("unicas_mcp_oauth=transaction");
    expect(authorize.headers.get("X-Internal-Token")).toBeNull();

    const token = mcpFetch.mock.calls[2][0] as Request;
    expect(token.headers.get("Authorization")).toBe("Basic client-credentials");
    expect(token.headers.get("Cookie")).toBeNull();
    expect(token.headers.get("X-Internal-Token")).toBeNull();
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
