import { describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityTokenType,
  casReadPermission,
  casWritePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type {
  CapabilityPermission,
  VerifiedCapability,
} from "@unidocs/service-auth";
import {
  createDocTypeHandler,
  type DocCapabilityVerifier,
} from "../src/doc-type-handler.js";

describe("Doc capability edge", () => {
  test("verifies separated credentials before forwarding derived context", async () => {
    const primary = capability({
      sub: "gateway",
      audience: "unidocs-doc:markdown",
      permissions: [sessionWritePermission("tenant-1", "session-1")],
      exp: 1120,
    });
    const delegated = capability({
      sub: "doc:markdown",
      audience: "unidocs-cas",
      permissions: [casReadPermission("tenant-1"), casWritePermission("tenant-1")],
      exp: 1120,
    });
    let forwarded: Request | undefined;
    const editor = trackingNamespace(async request => {
      forwarded = request;
      return Response.json({ success: true, version: 2 });
    });
    const handler = capabilityHandler(primary, delegated, editor);
    const response = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/apply",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer doc-token",
          "X-UniDocs-CAS-Capability": "cas-token",
          "X-Internal-Token": "hostile-legacy",
          "X-Tenant-Id": "hostile-tenant",
          "X-Session-Id": "hostile-session",
          Cookie: "hostile-cookie",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operations: [], description: "x", baseVersion: 1 }),
      },
    ));

    expect(response.status).toBe(200);
    expect(editor.ids).toEqual(["v1:8:tenant-1:9:session-1"]);
    expect(new URL(forwarded!.url).pathname).toBe("/_internal/apply");
    expect(forwarded!.headers.get("X-Tenant-Id")).toBe("tenant-1");
    expect(forwarded!.headers.get("X-Session-Id")).toBe("session-1");
    expect(forwarded!.headers.get("X-Doc-Type")).toBe("markdown");
    expect(forwarded!.headers.get("X-UniDocs-CAS-Capability")).toBe("cas-token");
    expect(forwarded!.headers.get("Authorization")).toBeNull();
    expect(forwarded!.headers.get("X-Internal-Token")).toBeNull();
    expect(forwarded!.headers.get("Cookie")).toBeNull();
  });

  test("omits delegated authority on history and rejects an unexpected one", async () => {
    const primary = capability({
      sub: "gateway",
      audience: "unidocs-doc:markdown",
      permissions: [sessionReadPermission("tenant-1", "session-1")],
    });
    const editor = trackingNamespace(async request => {
      expect(request.headers.get("X-UniDocs-CAS-Capability")).toBeNull();
      return Response.json({ success: true, data: [], version: 1 });
    });
    const handler = capabilityHandler(primary, undefined, editor);

    const accepted = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/history",
      { headers: { Authorization: "Bearer doc-token" } },
    ));
    expect(accepted.status).toBe(200);

    const rejected = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/history",
      {
        headers: {
          Authorization: "Bearer doc-token",
          "X-UniDocs-CAS-Capability": "unexpected",
        },
      },
    ));
    expect(rejected.status).toBe(403);
    expect(editor.ids).toHaveLength(1);
  });

  test.each([
    ["missing delegated token", undefined, undefined, 401],
    [
      "wrong tenant",
      capability({
        sub: "doc:markdown",
        audience: "unidocs-cas",
        tenantId: "tenant-2",
        permissions: [casReadPermission("tenant-2"), casWritePermission("tenant-2")],
      }),
      undefined,
      403,
    ],
    [
      "wrong permission set",
      capability({
        sub: "doc:markdown",
        audience: "unidocs-cas",
        permissions: [casWritePermission("tenant-1")],
      }),
      undefined,
      403,
    ],
    [
      "delegated token outlives primary",
      capability({
        sub: "doc:markdown",
        audience: "unidocs-cas",
        permissions: [casReadPermission("tenant-1"), casWritePermission("tenant-1")],
        exp: 1121,
      }),
      1120,
      403,
    ],
  ])("rejects %s before namespace lookup", async (_name, delegated, primaryExp, status) => {
    const primary = capability({
      sub: "gateway",
      audience: "unidocs-doc:markdown",
      permissions: [sessionWritePermission("tenant-1", "session-1")],
      exp: primaryExp ?? 1120,
    });
    const editor = trackingNamespace(async () => Response.json({ success: true }));
    const handler = capabilityHandler(primary, delegated, editor);
    const headers = new Headers({ Authorization: "Bearer doc-token" });
    if (delegated) headers.set("X-UniDocs-CAS-Capability", "cas-token");
    const response = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/apply",
      { method: "POST", headers, body: "{}" },
    ));
    expect(response.status).toBe(status);
    expect(editor.ids).toEqual([]);
  });

  test("maps verifier authentication failures to 401 before namespace lookup", async () => {
    const editor = trackingNamespace(async () => Response.json({ success: true }));
    const handler = createDocTypeHandler({
      docType: "markdown",
      internalAuthMode: "capability",
      docCapabilityVerifier: verifier(async () => {
        throw new CapabilityAuthenticationError("invalid_token", "Capability token is invalid");
      }),
      casCapabilityVerifier: verifier(async () => {
        throw new Error("must not run");
      }),
      editor,
      operator: trackingNamespace(async () => Response.json({ success: true })),
    });
    const response = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/history",
      { headers: { Authorization: "Bearer invalid" } },
    ));
    expect(response.status).toBe(401);
    expect(editor.ids).toEqual([]);
  });

  test.each([
    [
      "wrong signed session",
      capability({
        sub: "gateway",
        audience: "unidocs-doc:markdown",
        sessionId: "session-2",
        permissions: [sessionReadPermission("tenant-1", "session-2")],
      }),
    ],
    [
      "write permission on a read route",
      capability({
        sub: "gateway",
        audience: "unidocs-doc:markdown",
        permissions: [sessionWritePermission("tenant-1", "session-1")],
      }),
    ],
  ])("rejects %s", async (_name, primary) => {
    const editor = trackingNamespace(async () => Response.json({ success: true }));
    const handler = capabilityHandler(primary, undefined, editor);
    const response = await handler(new Request(
      "https://doc/tenants/tenant-1/sessions/session-1/history",
      { headers: { Authorization: "Bearer doc-token" } },
    ));
    expect(response.status).toBe(403);
    expect(editor.ids).toEqual([]);
  });

  test("capability mode rejects legacy routes", async () => {
    const editor = trackingNamespace(async () => Response.json({ success: true }));
    const handler = capabilityHandler(
      capability({
        sub: "gateway",
        audience: "unidocs-doc:markdown",
        permissions: [sessionReadPermission("tenant-1", "session-1")],
      }),
      undefined,
      editor,
    );
    const response = await handler(new Request("https://doc/sessions/session-1/history", {
      headers: {
        Authorization: "Bearer doc-token",
        "X-Tenant-Id": "tenant-1",
      },
    }));
    expect(response.status).toBe(404);
    expect(editor.ids).toEqual([]);
  });
});

function capabilityHandler(
  primary: VerifiedCapability,
  delegated: VerifiedCapability | undefined,
  editor: ReturnType<typeof trackingNamespace>,
) {
  return createDocTypeHandler({
    docType: "markdown",
    internalAuthMode: "capability",
    docCapabilityVerifier: verifier(async token => {
      expect(token).toBe("doc-token");
      return primary;
    }),
    casCapabilityVerifier: verifier(async token => {
      expect(token).toBe("cas-token");
      if (!delegated) throw new Error("Delegated verifier must not run");
      return delegated;
    }),
    editor,
    operator: trackingNamespace(async () => Response.json({ success: true })),
  });
}

function verifier(
  verify: DocCapabilityVerifier["verify"],
): DocCapabilityVerifier {
  return { verify };
}

function capability(options: {
  sub: string;
  audience: string;
  permissions: readonly CapabilityPermission[];
  tenantId?: string;
  sessionId?: string;
  exp?: number;
}): VerifiedCapability {
  return {
    protectedHeader: {
      alg: CapabilityAlgorithm,
      kid: "key-1",
      typ: CapabilityTokenType,
    },
    claims: {
      ver: 1,
      iss: "unidocs-gateway:test",
      sub: options.sub,
      aud: options.audience,
      iat: 1000,
      nbf: 995,
      exp: options.exp ?? 1120,
      jti: "jti-1",
      tenantId: options.tenantId ?? "tenant-1",
      sessionId: options.sessionId ?? "session-1",
      permissions: options.permissions,
    },
  };
}

function trackingNamespace(onFetch: (request: Request) => Promise<Response>) {
  const ids: string[] = [];
  return {
    ids,
    idFromName(name: string) {
      ids.push(name);
      return name;
    },
    get() {
      return { fetch: onFetch };
    },
  };
}