import { describe, expect, it } from "vitest";
import { AGENT_SCOPES, TenantAccessError } from "@unidocs/portal-service";
import { AGENT_PRINCIPAL_ID, authenticateAgent } from "../../src/tenant/agent-auth.js";
import { TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";

const ORIGIN = "http://127.0.0.1:8795";
const TOKEN = "agent-local-token-0123456789";
const TENANT = "t-local";
const options = { origin: ORIGIN, token: TOKEN, tenantId: TENANT };

function request(authorization: string | null, init: { url?: string; method?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(init.url ?? `${ORIGIN}/api/v1/tenants/t-local/documents`, { method: init.method ?? "GET", headers });
}

describe("authenticateAgent", () => {
  it("exports the principal and the four Agent scopes", () => {
    expect(AGENT_PRINCIPAL_ID).toBe("agent:markdown-primary");
    expect(AGENT_SCOPES).toEqual(["documents:read", "comments:read", "comments:reply", "versions:submit"]);
  });

  it("resolves the configured token to a bearer context", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`), options)).resolves.toEqual({
      tenantId: TENANT,
      principalId: "agent:markdown-primary",
      transport: "bearer",
      scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
    });
  });

  it("needs neither Origin nor a CSRF token on a mutation", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { method: "POST" }), options)).resolves.toMatchObject({ transport: "bearer" });
  });

  it.each([
    ["a wrong token", `Bearer ${TOKEN}x`],
    ["a token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
    ["a lowercase scheme", `bearer ${TOKEN}`],
    ["an extra space", `Bearer  ${TOKEN}`],
    ["a trailing field", `Bearer ${TOKEN} extra`],
    ["the Basic scheme", `Basic ${TOKEN}`],
    ["a bare scheme", "Bearer"],
  ])("is unauthorized for %s", async (_label, authorization) => {
    await expect(authenticateAgent(request(authorization), options)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("is unauthorized without an Authorization header", async () => {
    await expect(authenticateAgent(request(null), options)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it.each([
    ["an unset token", { token: undefined }],
    ["an empty token", { token: "" }],
    ["an unset tenant", { tenantId: undefined }],
    ["an empty tenant", { tenantId: "" }],
  ])("is unauthorized when the Agent credential has %s, even for the empty bearer it would match", async (_label, override) => {
    const configured = { ...options, ...override };
    await expect(authenticateAgent(request(`Bearer ${configured.token || TOKEN}`), configured)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(authenticateAgent(request("Bearer "), configured)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("is forbidden when the request URL origin is not the portal origin", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: "http://evil.test:8795/api/v1/tenants/t-local/documents" }), options))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    ["a wrong token", `Bearer ${TOKEN}x`],
    ["no Authorization header", null],
    ["a malformed header", "Basic abc"],
  ])("is forbidden, not unauthorized, on a foreign host with %s: the token is never judged there", async (_label, authorization) => {
    await expect(authenticateAgent(request(authorization, { url: "http://evil.test:8795/api/v1/tenants/t-local/documents" }), options))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(authenticateAgent(request(authorization, { url: "http://evil.test:8795/api/v1/tenants/t-local/documents" }), { ...options, token: undefined }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("does not look at the cookie: a wrong token beside a tenant session cookie is unauthorized", async () => {
    const cookie = `${TENANT_SESSION_COOKIE}=${"a".repeat(43)}`;
    const rejected = authenticateAgent(request(`Bearer ${TOKEN}x`, { cookie }), options);
    await expect(rejected).rejects.toBeInstanceOf(TenantAccessError);
    await expect(rejected).rejects.toMatchObject({ code: "unauthorized" });
  });
});
