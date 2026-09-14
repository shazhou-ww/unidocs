import { describe, expect, it, vi } from "vitest";
import { casReadPermission, casWritePermission, type CapabilityIssuer, type IssueCapabilityInput } from "@unidocs/service-auth";
import { createPlatformCasCapability } from "../src/cas-capability.js";

function issuerDouble() {
  const issue = vi.fn(async (_input: IssueCapabilityInput) => "token-1");
  return { issue, issuer: { issue } as unknown as CapabilityIssuer };
}

describe("createPlatformCasCapability", () => {
  it("requests a read+write capability carrying the stack ref domain", async () => {
    const { issue, issuer } = issuerDouble();
    const getToken = createPlatformCasCapability({
      issuer,
      tenantId: "t-local",
      audience: "unidocs-cas-stack:local",
      subject: "platform:portal",
      refDomain: "doc",
    });

    await expect(getToken()).resolves.toBe("token-1");
    expect(issue).toHaveBeenCalledTimes(1);
    const input = issue.mock.calls[0][0];
    expect(input.tenantId).toBe("t-local");
    expect(input.refDomain).toBe("doc");
    // Exact set, deliberately: cas:write is required because the CAS service
    // gates Root Refs updates (retain/release) on it, not because the
    // Platform is meant to lease blob content - it is the refDomain claim
    // that keeps an Agent's credential from moving a root reference, since
    // CAS has no permission finer-grained than cas:write for that.
    expect(input.permissions).toEqual([
      casReadPermission("t-local"),
      casWritePermission("t-local"),
    ]);
  });

  it("never carries a session id, because this is not a user credential", async () => {
    const { issue, issuer } = issuerDouble();
    await createPlatformCasCapability({
      issuer, tenantId: "t-local", audience: "a", subject: "platform:portal", refDomain: "doc",
    })();
    expect(issue.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it("refuses to build without a ref domain", () => {
    const { issuer } = issuerDouble();
    expect(() => createPlatformCasCapability({
      issuer, tenantId: "t-local", audience: "a", subject: "platform:portal", refDomain: "",
    })).toThrow();
  });
});
