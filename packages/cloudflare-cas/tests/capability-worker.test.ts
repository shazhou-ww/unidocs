import {
  SignJWT,
  exportJWK,
  generateKeyPair,
} from "jose";
import type { CryptoKey, JWK } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  CapabilityTokenType,
  JoseCapabilitySigner,
  casAdminPermission,
  casReadPermission,
  casWritePermission,
} from "@unidocs/service-auth";
import worker from "../src/worker.js";

const ISSUER = "unidocs-gateway:test";
const AUDIENCE = "unidocs-cas";
const hash = "a".repeat(64);
let privateKey: CryptoKey;
let publicJwk: JWK;
let issuer: CapabilityIssuer;

beforeAll(async () => {
  const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  issuer = new CapabilityIssuer({
    issuer: ISSUER,
    signer: new JoseCapabilitySigner(privateKey, "key-1"),
  });
});

describe("CAS capability worker", () => {
  test("accepts a tenant Gateway read capability", async () => {
    const bindings = capabilityEnv();
    const token = await issue({
      subject: "gateway",
      tenantId: "tenant-a",
      permissions: [casReadPermission("tenant-a")],
    });
    const response = await worker.fetch(new Request(
      `https://cas/tenants/tenant-a/cas/nodes/${hash}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), bindings as never);

    expect(response.status).toBe(200);
    expect(bindings.doFetch).toHaveBeenCalledOnce();
    expect(bindings.idFromName).toHaveBeenCalledWith("tenant-a");
  });

  test("rejects a correctly signed Doc-audience token before schema or DO access", async () => {
    const bindings = capabilityEnv();
    const token = await issue({
      subject: "gateway",
      audience: "unidocs-doc:docx",
      tenantId: "tenant-a",
      sessionId: "session-a",
      permissions: [casReadPermission("tenant-a")],
    });
    const response = await worker.fetch(new Request(
      `https://cas/tenants/tenant-a/cas/nodes/${hash}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), bindings as never);

    expect(response.status).toBe(401);
    expect(bindings.dbExec).not.toHaveBeenCalled();
    expect(bindings.doFetch).not.toHaveBeenCalled();
  });

  test("rejects wrong-tenant and admin-as-read capabilities", async () => {
    const wrongTenant = await issue({
      subject: "gateway",
      tenantId: "tenant-b",
      permissions: [casReadPermission("tenant-b")],
    });
    const wrongTenantResponse = await worker.fetch(new Request(
      `https://cas/tenants/tenant-a/cas/nodes/${hash}/content`,
      { headers: { Authorization: `Bearer ${wrongTenant}` } },
    ), capabilityEnv() as never);
    expect(wrongTenantResponse.status).toBe(403);

    const admin = await issue({
      subject: "gateway",
      tenantId: "tenant-a",
      permissions: [casAdminPermission("tenant-a")],
    });
    const adminReadResponse = await worker.fetch(new Request(
      `https://cas/tenants/tenant-a/cas/nodes/${hash}/content`,
      { headers: { Authorization: `Bearer ${admin}` } },
    ), capabilityEnv() as never);
    expect(adminReadResponse.status).toBe(403);
  });

  test("accepts tenant-only Gateway admin for GC", async () => {
    const token = await issue({
      subject: "gateway",
      tenantId: "tenant-a",
      permissions: [casAdminPermission("tenant-a")],
    });
    const response = await worker.fetch(new Request(
      "https://cas/tenants/tenant-a/cas/gc",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    ), capabilityEnv() as never);
    expect(response.status).toBe(200);
  });

  test("binds root assignments to the signed Doc session", async () => {
    const token = await issue({
      subject: "doc:docx",
      tenantId: "tenant-a",
      sessionId: "session-a",
      permissions: [casWritePermission("tenant-a")],
    });
    const wrongOwnerBindings = capabilityEnv();
    const wrongOwner = await worker.fetch(new Request(
      "https://cas/tenants/tenant-a/_internal/root-assignments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "root-1",
          assignments: [{ owner: "session:session-b:delta:1", hash }],
        }),
      },
    ), wrongOwnerBindings as never);
    expect(wrongOwner.status).toBe(403);
    expect(wrongOwnerBindings.dbExec).not.toHaveBeenCalled();
    expect(wrongOwnerBindings.doFetch).not.toHaveBeenCalled();

    const validBindings = capabilityEnv();
    const valid = await worker.fetch(new Request(
      "https://cas/tenants/tenant-a/_internal/root-assignments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "root-2",
          assignments: [{ owner: "session:session-a:delta:1", hash }],
        }),
      },
    ), validBindings as never);
    expect(valid.status).toBe(200);
    expect(validBindings.doFetch).toHaveBeenCalledOnce();
  });

  test("rejects a multi-audience token", async () => {
    const token = await new SignJWT({
      ver: 1,
      iss: ISSUER,
      sub: "gateway",
      aud: [AUDIENCE, "other"],
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000) - 5,
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: "multi-aud",
      tenantId: "tenant-a",
      permissions: [casReadPermission("tenant-a")],
    }).setProtectedHeader({
      alg: CapabilityAlgorithm,
      kid: "key-1",
      typ: CapabilityTokenType,
    }).sign(privateKey);
    const response = await worker.fetch(new Request(
      `https://cas/tenants/tenant-a/cas/nodes/${hash}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), capabilityEnv() as never);
    expect(response.status).toBe(401);
  });

  test("capability mode rejects the tenant-less legacy internal path", async () => {
    const token = await issue({
      subject: "doc:docx",
      tenantId: "tenant-a",
      sessionId: "session-a",
      permissions: [casWritePermission("tenant-a")],
    });
    const response = await worker.fetch(new Request(
      "https://cas/_internal/root-refs",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": "tenant-a",
        },
      },
    ), capabilityEnv() as never);
    expect(response.status).toBe(401);
  });
});

function capabilityEnv() {
  const doFetch = vi.fn(async () => Response.json({ success: true }));
  const idFromName = vi.fn(() => "id");
  const dbExec = vi.fn(async () => undefined);
  return {
    INTERNAL_AUTH_MODE: "capability",
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAPABILITY_ISSUER: ISSUER,
    CAS_CAPABILITY_AUDIENCE: AUDIENCE,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, kid: "key-1", alg: CapabilityAlgorithm }],
    }),
    CAS_DB: {
      exec: dbExec,
      prepare: () => ({ all: async () => ({ results: [{ name: "tenant_id" }] }) }),
    },
    CAS_R2: {},
    CAS_DO: {
      idFromName,
      get: () => ({ fetch: doFetch }),
    },
    doFetch,
    idFromName,
    dbExec,
  };
}

async function issue(input: {
  subject: string;
  tenantId: string;
  permissions: Parameters<CapabilityIssuer["issue"]>[0]["permissions"];
  audience?: string;
  sessionId?: string;
}): Promise<string> {
  return issuer.issue({
    subject: input.subject,
    audience: input.audience ?? AUDIENCE,
    tenantId: input.tenantId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    permissions: input.permissions,
  });
}
