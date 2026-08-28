import { describe, expect, it } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission, VerifiedCapability } from "@unidocs/service-auth";
import { createDocTypeHandler } from "../src/doc-type-handler.js";
import type { DocCapabilityVerifier } from "../src/doc-type-handler.js";

interface StubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

function stubNamespace(onFetch: (req: Request) => Promise<Response>): StubNamespace {
  return {
    idFromName: name => name,
    get: () => ({ fetch: onFetch }),
  };
}

function streamBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function handler(
  operation: "create" | "apply" | "run",
  onFetch: (request: Request) => Promise<Response>,
  audit?: (event: unknown) => void,
) {
  const docPermission = operation === "create"
    ? sessionCreatePermission("tenant-1")
    : sessionWritePermission("tenant-1", "session-1");
  const casPermissions = operation === "create"
    ? [casWritePermission("tenant-1")]
    : [casReadPermission("tenant-1"), casWritePermission("tenant-1")];
  return createDocTypeHandler({
    docType: "markdown",
    docCapabilityVerifier: verifier(capability("gateway", [docPermission])),
    casCapabilityVerifier: verifier(capability("doc:markdown", casPermissions)),
    audit,
    editor: stubNamespace(onFetch),
    operator: stubNamespace(onFetch),
  });
}

function verifier(result: VerifiedCapability): DocCapabilityVerifier {
  return { verify: async () => result };
}

function capability(sub: string, permissions: readonly CapabilityPermission[]): VerifiedCapability {
  return {
    protectedHeader: { alg: CapabilityAlgorithm, kid: "key-1", typ: CapabilityTokenType },
    claims: {
      ver: 1,
      iss: "issuer",
      sub,
      aud: "audience",
      iat: 1000,
      nbf: 995,
      exp: 1120,
      jti: `${sub}-jti`,
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions,
    },
  };
}

function request(path: string, method: string, body: string): Request {
  return new Request(`http://gw.local${path}`, {
    method,
    headers: {
      Authorization: "Bearer doc-token",
      "X-UniDocs-CAS-Capability": "cas-token",
      "Content-Type": "application/json",
    },
    body: streamBody(body),
    duplex: "half",
  } as RequestInit);
}

describe("createDocTypeHandler streaming forwarding", () => {
  it("forwards create body on the tenant-scoped route", async () => {
    let received: string | undefined;
    const audits: unknown[] = [];
    const handle = handler("create", async req => {
      received = await req.text();
      return Response.json({ success: true });
    }, event => audits.push(event));

    const response = await handle(request("/tenants/tenant-1/sessions/session-1", "PUT", "create"));

    expect(response.status).toBe(200);
    expect(received).toBe("create");
    expect(audits).toEqual([expect.objectContaining({
      credentialKind: "capability",
      routeGeneration: "tenant",
      operation: "create",
    })]);
  });

  it("forwards apply body intact", async () => {
    let received: string | undefined;
    const handle = handler("apply", async req => {
      received = await req.text();
      return Response.json({ success: true });
    });
    const payload = JSON.stringify({ operations: [], baseVersion: 1 });

    const response = await handle(request("/tenants/tenant-1/sessions/session-1/apply", "POST", payload));

    expect(response.status).toBe(200);
    expect(received).toBe(payload);
  });

  it("forwards operator body intact", async () => {
    let received: string | undefined;
    const handle = handler("run", async req => {
      received = await req.text();
      return Response.json({ success: true });
    });
    const payload = JSON.stringify({ prompt: "do it" });

    const response = await handle(request("/tenants/tenant-1/sessions/session-1/run", "POST", payload));

    expect(response.status).toBe(200);
    expect(received).toBe(payload);
  });
});
