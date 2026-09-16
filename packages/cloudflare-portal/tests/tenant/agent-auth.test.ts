import { describe, expect, it } from "vitest";
import { AGENT_SCOPES, TenantAccessError } from "@unidocs/portal-service";
import { AGENT_PRINCIPAL_ID, authenticateAgent } from "../../src/tenant/agent-auth.js";
import { TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";

const ORIGIN = "http://127.0.0.1:8795";
const TOKEN = "agent-local-token-0123456789";
const options = { origin: ORIGIN, token: TOKEN };

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

  it("resolves the configured token to a bearer context for the tenant named in the path", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`), options)).resolves.toEqual({
      tenantId: "t-local",
      principalId: "agent:markdown-primary",
      transport: "bearer",
      scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
    });
  });

  it("authenticates for a tenant it was never configured with: the token alone authorizes, the path names the tenant", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/api/v1/tenants/t-brand-new/documents` }), options))
      .resolves.toMatchObject({ tenantId: "t-brand-new" });
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/api/v1/tenants/t-another/threads/th-1/comments` }), options))
      .resolves.toMatchObject({ tenantId: "t-another" });
  });

  it("percent-decodes the tenant segment", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/api/v1/tenants/t%2Dlocal/documents` }), options))
      .resolves.toMatchObject({ tenantId: "t-local" });
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
    ["an unset token", undefined],
    ["an empty token", ""],
  ])("is unauthorized when the Agent credential has %s, even for the empty bearer it would match", async (_label, token) => {
    const configured = { ...options, token };
    await expect(authenticateAgent(request(`Bearer ${token || TOKEN}`), configured)).rejects.toMatchObject({ code: "unauthorized" });
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

  it("is unauthorized when the path carries no tenant segment at all: a valid bearer at the session endpoints", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/portal/auth/session` }), options))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/portal/auth/logout` }), options))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it.each([
    ["an empty segment", `${ORIGIN}/api/v1/tenants//documents`],
    ["a segment over 128 characters", `${ORIGIN}/api/v1/tenants/${"t".repeat(129)}/documents`],
    ["a segment with a raw space", `${ORIGIN}/api/v1/tenants/t%20local/documents`],
    ["a segment that decodes to a control character", `${ORIGIN}/api/v1/tenants/t%09local/documents`],
    ["a segment that is just the tenants collection itself", `${ORIGIN}/api/v1/tenants/`],
    ["a segment that is unrelated to the tenants path", `${ORIGIN}/api/v1/other/t-local/documents`],
  ])("is unauthorized for %s: a valid bearer against a malformed or missing tenant segment", async (_label, url) => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url }), options)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("is unauthorized for a malformed percent-encoding in the tenant segment", async () => {
    await expect(authenticateAgent(request(`Bearer ${TOKEN}`, { url: `${ORIGIN}/api/v1/tenants/t-%zzlocal/documents` }), options))
      .rejects.toMatchObject({ code: "unauthorized" });
  });
});
