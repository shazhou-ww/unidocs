import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { resolveAdminMcpContext, type AdminMcpMember, type VerifiedAdminMcpGrant } from "../src/mcp/context.js";

const grant: VerifiedAdminMcpGrant = {
  memberId: "member", clientId: "private-client-id", scopes: ["admin:read"],
  identity: { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" },
};
const member: AdminMcpMember = { memberId: "member", issuer: grant.identity.issuer, subject: "subject", email: "admin@example.com", active: true };

function setup() {
  return {
    verifiedGrant: grant,
    toolName: "whoami" as const,
    policy: { enabled: true, contentMutationsEnabled: false, publishMutationsEnabled: false, securityMutationsEnabled: false },
    allowedEmails: ["admin@example.com"], now: 1100,
    findMember: vi.fn(async (): Promise<AdminMcpMember | null> => member),
  };
}

test("uses the active binding and attributes only a hashed OAuth client", async () => {
  const options = setup();
  const context = await resolveAdminMcpContext(options);
  expect(options.findMember).toHaveBeenCalledWith("member");
  expect(context).toEqual({ memberId: "member", identity: grant.identity, transport: "bearer", caller: {
    channel: "mcp", toolName: "whoami", oauthClientHandle: createHash("sha256").update(grant.clientId).digest("hex"),
  } });
  expect(context).not.toHaveProperty("sessionHash");
  expect(JSON.stringify(context)).not.toContain(grant.clientId);
});

test("rechecks membership on every call and immediately rejects removal", async () => {
  const options = setup();
  await resolveAdminMcpContext(options);
  options.findMember.mockResolvedValue({ ...member, active: false });
  await expect(resolveAdminMcpContext(options)).rejects.toMatchObject({ code: "forbidden" });
  options.findMember.mockResolvedValue(null);
  await expect(resolveAdminMcpContext(options)).rejects.toMatchObject({ code: "forbidden" });
  expect(options.findMember).toHaveBeenCalledTimes(3);
});

test.each([
  { memberId: "other" }, { issuer: "https://other.example" }, { subject: "other" },
])("rejects mismatched binding even when email matches %#", async change => {
  const options = setup();
  options.findMember.mockResolvedValue({ ...member, ...change });
  await expect(resolveAdminMcpContext(options)).rejects.toMatchObject({ code: "forbidden" });
});

test.each([{ allowedEmails: [] }, { allowedEmails: ["other@example.com"] }, { allowedEmails: ["invalid"] }])("canary allowlist fails closed %#", async ({ allowedEmails }) => {
  await expect(resolveAdminMcpContext({ ...setup(), allowedEmails })).rejects.toMatchObject({ code: "forbidden" });
});

test("canary evaluates the current member email, not an old grant email", async () => {
  const options = setup();
  options.findMember.mockResolvedValue({ ...member, email: "other@example.com" });
  await expect(resolveAdminMcpContext(options)).rejects.toMatchObject({ code: "forbidden" });
  expect((await resolveAdminMcpContext({ ...options, allowedEmails: [" OTHER@example.com "] })).identity.email).toBe("other@example.com");
});

test("does not synthesize recent authentication or let other issuers through", async () => {
  const options = setup();
  expect((await resolveAdminMcpContext({ ...options, now: 20_000 })).identity.loginConfirmedAt).toBe(1000);
  await expect(resolveAdminMcpContext({ ...options, verifiedGrant: { ...grant, identity: { ...grant.identity, issuer: "https://tenant.example" } } })).rejects.toMatchObject({ code: "unauthorized" });
});

test("scope and global kill switch deny before membership lookup", async () => {
  const options = setup();
  await expect(resolveAdminMcpContext({ ...options, verifiedGrant: { ...grant, scopes: ["admin:security"] } })).rejects.toMatchObject({ code: "forbidden" });
  await expect(resolveAdminMcpContext({ ...options, policy: { ...options.policy, enabled: false } })).rejects.toMatchObject({ code: "forbidden" });
  expect(options.findMember).not.toHaveBeenCalled();
});