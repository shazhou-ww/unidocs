import { afterEach, describe, expect, test } from "vitest";
import type { IssueCapabilityInput } from "@unidocs/service-auth";
import {
  createGatewayHandler,
  GatewayCapabilityAuthority,
  MemoryGatewayDocumentDirectory,
} from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Gateway capability HTTP forwarding", () => {
  test("sends separated Doc and delegated CAS credentials for create", async () => {
    const issued: IssueCapabilityInput[] = [];
    const authority = authorityFor(issued, ["cas-jti", "doc-jti"]);
    let forwarded: Request | undefined;
    globalThis.fetch = async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ success: true, sessionId: "session-1", version: 1 });
    };
    const handler = createGatewayHandler({
      internalAuthMode: "capability",
      capabilityAuthority: authority,
      identityResolver: tenantIdentity,
      resolveDocService: async () => ({
        serviceId: "docx-primary",
        url: "https://doc.internal",
        audience: "unidocs-doc:docx",
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isPublicCasRoute: () => false,
      generateId: sequence("doc-1", "session-1"),
      now: () => 10,
    });

    const response = await handler(new Request("https://gw/tenants/tenant-1/docs/docx/", {
      method: "POST",
      headers: {
        Authorization: "Bearer hostile-user-token",
        Cookie: "session=hostile",
        "X-Internal-Token": "hostile-internal-token",
        "X-Tenant-Id": "hostile-tenant",
        "X-Session-Id": "hostile-session",
        "X-UniDocs-CAS-Capability": "hostile-capability",
      },
    }));

    expect(response.status).toBe(200);
    expect(new URL(forwarded!.url).pathname)
      .toBe("/tenants/tenant-1/sessions/session-1");
    expect(forwarded!.method).toBe("PUT");
    expect(forwarded!.headers.get("Authorization")).toBe("Bearer token-doc-jti");
    expect(forwarded!.headers.get("X-UniDocs-CAS-Capability")).toBe("token-cas-jti");
    expect(forwarded!.headers.get("X-Internal-Token")).toBeNull();
    expect(forwarded!.headers.get("X-Tenant-Id")).toBeNull();
    expect(forwarded!.headers.get("X-Session-Id")).toBeNull();
    expect(forwarded!.headers.get("Cookie")).toBeNull();
    expect(issued.map(input => ({
      subject: input.subject,
      audience: input.audience,
      permissions: input.permissions,
    }))).toEqual([
      {
        subject: "doc:docx",
        audience: "unidocs-cas",
        permissions: ["tenants:tenant-1:cas:write"],
      },
      {
        subject: "gateway",
        audience: "unidocs-doc:docx",
        permissions: ["tenants:tenant-1:sessions:create"],
      },
    ]);
  });

  test("omits delegated CAS authority for history", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve({
      docId: "doc-1",
      tenantId: "tenant-1",
      docType: "markdown",
      serviceId: "markdown-primary",
      sessionId: "session-1",
      idempotencyKey: "create-1",
      requestedDocId: null,
      now: 1,
    });
    await directory.markReady("tenant-1", "doc-1", 1, 2);
    const issued: IssueCapabilityInput[] = [];
    let forwarded: Request | undefined;
    globalThis.fetch = async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ success: true, data: [], version: 1 });
    };
    const handler = createGatewayHandler({
      internalAuthMode: "capability",
      capabilityAuthority: authorityFor(issued, ["doc-jti"]),
      identityResolver: tenantIdentity,
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "https://doc.internal",
        audience: "unidocs-doc:markdown",
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory,
      isPublicCasRoute: () => false,
    });

    const response = await handler(new Request(
      "https://gw/tenants/tenant-1/docs/markdown/doc-1/history?from=1",
    ));
    expect(response.status).toBe(200);
    expect(new URL(forwarded!.url).pathname)
      .toBe("/tenants/tenant-1/sessions/session-1/history");
    expect(new URL(forwarded!.url).search).toBe("?from=1");
    expect(forwarded!.headers.get("Authorization")).toBe("Bearer token-doc-jti");
    expect(forwarded!.headers.get("X-UniDocs-CAS-Capability")).toBeNull();
    expect(issued).toHaveLength(1);
  });

  test("sends a CAS-only Bearer credential for direct CAS", async () => {
    const issued: IssueCapabilityInput[] = [];
    let forwarded: Request | undefined;
    const handler = createGatewayHandler({
      internalAuthMode: "capability",
      capabilityAuthority: authorityFor(issued, ["cas-jti"]),
      identityResolver: tenantIdentity,
      resolveDocService: async () => null,
      casFetcher: {
        fetch: async (request) => {
          forwarded = request as Request;
          return new Response(null, { status: 204 });
        },
      },
      directory: new MemoryGatewayDocumentDirectory(),
      isPublicCasRoute: () => true,
    });

    const response = await handler(new Request("https://gw/tenants/tenant-1/cas/usage", {
      headers: {
        Authorization: "Bearer hostile-user-token",
        "X-Internal-Token": "hostile-token",
      },
    }));
    expect(response.status).toBe(204);
    expect(forwarded!.headers.get("Authorization")).toBe("Bearer token-cas-jti");
    expect(forwarded!.headers.get("X-Internal-Token")).toBeNull();
    expect(forwarded!.headers.get("X-Tenant-Id")).toBeNull();
    expect(issued[0]).toMatchObject({
      subject: "gateway",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      permissions: ["tenants:tenant-1:cas:admin"],
    });
    expect(issued[0].sessionId).toBeUndefined();
  });

  test("fails startup when capability mode has no authority", () => {
    expect(() => createGatewayHandler({
      internalAuthMode: "capability",
      identityResolver: tenantIdentity,
      resolveDocService: async () => null,
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isPublicCasRoute: () => false,
    })).toThrow("requires a capability authority");
  });
});

const tenantIdentity = {
  resolve: async (_request: Request, requestedTenantId: string) => ({
    userId: "authenticated-user",
    tenantId: requestedTenantId,
    canManageTenant: true,
  }),
};

function authorityFor(
  issued: IssueCapabilityInput[],
  jtis: string[],
): GatewayCapabilityAuthority {
  return new GatewayCapabilityAuthority({
    issuer: {
      keyId: "key-1",
      issue: async (input) => {
        issued.push(input);
        return `token-${input.jti}`;
      },
    },
    casAudience: "unidocs-cas",
    generateJti: () => jtis.shift()!,
  });
}

function sequence(...values: string[]): () => string {
  return () => values.shift()!;
}