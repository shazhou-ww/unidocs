import { expect, test, vi } from "vitest";
import { createTenantCasService, type CasCapabilityIssuer, type TenantContext } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const grant = {
  baseUrl: "https://cas.example/", stackId: "stack-1", tenantId: "tenant-a",
  accessToken: "header.payload.signature", expiresAt: 2_000, permissions: ["cas:read", "cas:write"] as const,
};

function setup(issue: CasCapabilityIssuer["issue"] = vi.fn(async () => grant)) {
  const issuer: CasCapabilityIssuer = { issue };
  return { issuer, service: createTenantCasService(issuer, { now: () => 1_000 }) };
}

test("issues a tenant-scoped read and write capability", async () => {
  const { issuer, service } = setup();
  await expect(service.issue(context, "tenant-a")).resolves.toEqual(grant);
  expect(issuer.issue).toHaveBeenCalledWith(context);
});

test("refuses a grant issued for a different tenant than the caller", async () => {
  const { service } = setup(vi.fn(async () => ({ ...grant, tenantId: "tenant-b" })));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "forbidden" });
});

test("refuses a grant that is already expired", async () => {
  const { service } = setup(vi.fn(async () => ({ ...grant, expiresAt: 999 })));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});

test.each([
  { ...grant, permissions: ["cas:read"] },
  { ...grant, permissions: ["cas:read", "cas:write", "cas:manage"] },
  { ...grant, accessToken: "" },
  { ...grant, baseUrl: "not-a-url" },
])("refuses a malformed grant %#", async malformed => {
  const { service } = setup(vi.fn(async () => malformed as never));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});

test("refuses to issue against another tenant's path", async () => {
  const { issuer, service } = setup();
  await expect(service.issue(context, "tenant-b")).rejects.toMatchObject({ code: "forbidden" });
  expect(issuer.issue).not.toHaveBeenCalled();
});

test("with no options supplied, falls back to the real clock and still refuses an expired grant", async () => {
  const issuer: CasCapabilityIssuer = { issue: vi.fn(async () => ({ ...grant, expiresAt: 1 })) };
  const service = createTenantCasService(issuer);
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});

test("refuses a grant whose expiry exactly equals now, not only one strictly in the past", async () => {
  const { service } = setup(vi.fn(async () => ({ ...grant, expiresAt: 1_000 })));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});
