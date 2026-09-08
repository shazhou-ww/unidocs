import { describe, expect, test } from "vitest";
import type { IssueCapabilityInput } from "@unidocs/service-auth";
import {
  GatewayCapabilityAuthority,
  type GatewayCapabilityAuditEvent,
} from "../src/capability-authority.js";

describe("GatewayCapabilityAuthority", () => {
  test("issues separated Doc and delegated CAS capabilities", async () => {
    const issued: IssueCapabilityInput[] = [];
    const audits: GatewayCapabilityAuditEvent[] = [];
    const ids = ["cas-jti", "doc-jti"];
    const authority = new GatewayCapabilityAuthority({
      issuer: {
        keyId: "key-1",
        issue: async (input) => {
          issued.push(input);
          return `token-${input.jti}`;
        },
      },
      casIssuer: {
        keyId: "key-1",
        issue: async (input) => {
          issued.push(input);
          return `token-${input.jti}`;
        },
      },
      casAudience: "unidocs-cas",
      casStackId: "stack-1",
      generateJti: () => ids.shift()!,
      audit: event => audits.push(event),
    });

    await expect(authority.issueDocOperation({
      operation: "apply",
      docType: "docx",
      docAudience: "unidocs-doc:docx",
      tenantId: "tenant-1",
      sessionId: "session-1",
    })).resolves.toEqual({
      authorization: "Bearer token-doc-jti",
      delegatedCasCapability: "token-cas-jti",
      deadlineSeconds: 90,
    });

    expect(issued).toEqual([
      {
        subject: "doc:docx",
        audience: "unidocs-cas",
        tenantId: "tenant-1",
        sessionId: "session-1",
        permissions: ["tenants:tenant-1:cas:read", "tenants:tenant-1:cas:write"],
        lifetimeSeconds: 120,
        jti: "cas-jti",
      },
      {
        subject: "gateway",
        audience: "unidocs-doc:docx",
        tenantId: "tenant-1",
        sessionId: "session-1",
        permissions: ["tenants:tenant-1:sessions:session-1:write"],
        lifetimeSeconds: 120,
        jti: "doc-jti",
      },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({ kind: "delegated-cas", kid: "key-1", jti: "cas-jti" }),
      expect.objectContaining({ kind: "doc", kid: "key-1", jti: "doc-jti" }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("token-");
  });

  test("omits delegated authority for no-CAS routes", async () => {
    const issued: IssueCapabilityInput[] = [];
    const authority = new GatewayCapabilityAuthority({
      issuer: {
        keyId: "key-1",
        issue: async (input) => {
          issued.push(input);
          return "doc-token";
        },
      },
      casIssuer: { keyId: "cas-key-1", issue: async () => "unused" },
      casAudience: "unidocs-cas",
      casStackId: "stack-1",
      generateJti: () => "doc-jti",
    });

    await expect(authority.issueDocOperation({
      operation: "history",
      docType: "markdown",
      docAudience: "unidocs-doc:markdown",
      tenantId: "tenant-1",
      sessionId: "session-1",
    })).resolves.toEqual({
      authorization: "Bearer doc-token",
      deadlineSeconds: 30,
    });
    expect(issued).toHaveLength(1);
    expect(issued[0].audience).toBe("unidocs-doc:markdown");
  });

  test("issues a tenant-only direct CAS capability", async () => {
    const issued: IssueCapabilityInput[] = [];
    const authority = new GatewayCapabilityAuthority({
      issuer: {
        keyId: "key-1",
        issue: async (input) => {
          issued.push(input);
          return "cas-token";
        },
      },
      casIssuer: {
        keyId: "key-1",
        issue: async (input) => {
          issued.push(input);
          return "cas-token";
        },
      },
      casAudience: "unidocs-cas",
      casStackId: "stack-1",
      generateJti: () => "cas-jti",
    });

    await expect(authority.issueCasOperation({ operation: "gc", tenantId: "tenant-1" }))
      .resolves.toBe("Bearer cas-token");
    expect(issued).toEqual([{
      subject: "gateway",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      permissions: ["tenants:tenant-1:cas:manage"],
      lifetimeSeconds: 120,
      jti: "cas-jti",
    }]);
  });

  test("issues a dedicated platform root retention capability in the configured domain", async () => {
    const issued: IssueCapabilityInput[] = [];
    const audits: GatewayCapabilityAuditEvent[] = [];
    const authority = new GatewayCapabilityAuthority({
      issuer: { keyId: "doc-key", issue: async () => "unused" },
      casIssuer: { keyId: "cas-key", issue: async input => { issued.push(input); return "platform-token"; } },
      casAudience: "unidocs-cas", casStackId: "stack-1", casRefDomain: "doc",
      platformCasRefDomain: "platform:documents",
      generateJti: () => "platform-jti", audit: event => audits.push(event),
    });

    await expect(authority.issuePlatformRootRetention("tenant-1")).resolves.toBe("Bearer platform-token");
    expect(issued).toEqual([{
      subject: "platform", audience: "unidocs-cas", tenantId: "tenant-1", refDomain: "platform:documents",
      permissions: ["tenants:tenant-1:cas:write"], lifetimeSeconds: 120, jti: "platform-jti",
    }]);
    expect(audits).toEqual([expect.objectContaining({ kind: "platform-cas", subject: "platform",
      refDomain: "platform:documents", permissions: ["tenants:tenant-1:cas:write"] })]);
    expect(JSON.stringify(audits)).not.toContain("platform-token");
  });

  test("fails closed when platform root retention has no ref domain", async () => {
    const authority = new GatewayCapabilityAuthority({
      issuer: { keyId: "doc-key", issue: async () => "unused" },
      casIssuer: { keyId: "cas-key", issue: async () => "unused" },
      casAudience: "unidocs-cas", casStackId: "stack-1",
    });

    await expect(authority.issuePlatformRootRetention("tenant-1")).rejects.toThrow("ref domain");
  });
});