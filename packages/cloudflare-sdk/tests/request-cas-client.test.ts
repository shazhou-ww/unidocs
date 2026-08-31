import { describe, expect, test, vi } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  CapabilityVerifier,
  JoseCapabilitySigner,
  casReadPermission,
  casWritePermission,
  sessionReadPermission,
} from "../../service-auth/src/index.js";
import { createRequestCasClient } from "../src/request-cas-client.js";

describe("createRequestCasClient", () => {
  test("uses only the delegated CAS Bearer on tenant-prefixed routes", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const issuer = new CapabilityIssuer({
      issuer: "unidocs-gateway:request-cas-client-test",
      signer: new JoseCapabilitySigner(pair.privateKey, "test-key"),
    });
    const delegatedToken = await issuer.issue({
      subject: "doc:docx",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [casReadPermission("tenant-1"), casWritePermission("tenant-1")],
    });
    const primaryDocToken = await issuer.issue({
      subject: "gateway",
      audience: "unidocs-doc:docx",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [sessionReadPermission("tenant-1", "session-1")],
    });
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    const client = createRequestCasClient(
      { CAS_SERVICE: { fetch }, CAS_STACK_ID: "stack-1" },
      privateRequest({
        "X-UniDocs-Auth-Context": "capability",
        "X-UniDocs-CAS-Capability": delegatedToken,
        Authorization: `Bearer ${primaryDocToken}`,
        Cookie: "session=hostile-cookie",
        "X-User-Id": "hostile-user",
        "X-Internal-Token": "hostile-legacy-token",
        "X-Forwarded-For": "203.0.113.1",
      }),
    );
    await new Response(await client!.unicasClient.readContent("a".repeat(64))).arrayBuffer();

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://cas.internal/stacks/stack-1/tenants/tenant-1/cas/nodes/${"a".repeat(64)}/content`);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${delegatedToken}`);
    expect([...headers]).toHaveLength(1);
    expect(JSON.stringify(init)).not.toContain(primaryDocToken);
    expect(JSON.stringify(init)).not.toContain("hostile-cookie");
    expect(JSON.stringify(init)).not.toContain("hostile-user");
    expect(JSON.stringify(init)).not.toContain("hostile-legacy-token");
    expect(JSON.stringify(init)).not.toContain("203.0.113.1");

    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const verifier = new CapabilityVerifier({
      issuer: "unidocs-gateway:request-cas-client-test",
      audience: "unidocs-cas",
      algorithm: CapabilityAlgorithm,
      jwks: { keys: [{ ...publicJwk, kid: "test-key", alg: CapabilityAlgorithm }] },
      allowedPermissionKinds: ["cas:read", "cas:write", "cas:manage"],
    });
    const outbound = await verifier.verify(delegatedToken);
    expect(outbound.claims).toMatchObject({
      sub: "doc:docx",
      aud: "unidocs-cas",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [casReadPermission("tenant-1"), casWritePermission("tenant-1")],
    });
  });

  test("does not construct a CAS client without delegated authority", () => {
    expect(createRequestCasClient(
      { CAS_SERVICE: { fetch: vi.fn() }, CAS_STACK_ID: "stack-1" },
      privateRequest({ "X-UniDocs-Auth-Context": "capability" }),
    )).toBeNull();
  });

  test("does not grant CAS authority to legacy Doc requests", () => {
    expect(createRequestCasClient(
      { CAS_SERVICE: { fetch: vi.fn() }, CAS_STACK_ID: "stack-1" },
      privateRequest({ "X-UniDocs-Auth-Context": "legacy" }),
    )).toBeNull();
  });

  test("rejects delegated CAS access without a stack namespace", () => {
    expect(() => createRequestCasClient(
      { CAS_SERVICE: { fetch: vi.fn() }, CAS_STACK_ID: "" },
      privateRequest({
        "X-UniDocs-Auth-Context": "capability",
        "X-UniDocs-CAS-Capability": "token",
      }),
    )).toThrow("CAS_STACK_ID");
  });
});

function privateRequest(extraHeaders: Record<string, string>): Request {
  return new Request("https://editor.internal/_internal/query", {
    headers: {
      "X-Tenant-Id": "tenant-1",
      "X-Session-Id": "session-1",
      ...extraHeaders,
    },
  });
}