import { beforeAll, describe, expect, test } from "vitest";
import {
  SignJWT,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
} from "jose";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  casAdminPermission,
  casReadPermission,
  casWritePermission,
  createPkcs8CapabilityIssuer,
  sessionReadPermission,
  sessionWritePermission,
} from "../../../packages/service-auth/src/index.ts";
import {
  computeNodeDigest,
  encodeHeader,
  hashToHex,
} from "../../../packages/cas-server-common/src/index.ts";

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

export function runAuthorizationSuite(getRuntime, { docTypes, directCas = false }) {
  let issuer;
  let expiredIssuer;
  let futureIssuer;
  let wrongIssuer;
  let wrongKeyIssuer;
  let signingKey;

  beforeAll(async () => {
    const fixture = getRuntime().capabilityFixture;
    issuer = await createPkcs8CapabilityIssuer({
      issuer: fixture.issuer,
      kid: fixture.kid,
      privateKeyPkcs8: fixture.privateKeyPkcs8,
    });
    expiredIssuer = await createPkcs8CapabilityIssuer({
      issuer: fixture.issuer,
      kid: fixture.kid,
      privateKeyPkcs8: fixture.privateKeyPkcs8,
      now: () => Date.now() / 1000 - 600,
    });
    futureIssuer = await createPkcs8CapabilityIssuer({
      issuer: fixture.issuer,
      kid: fixture.kid,
      privateKeyPkcs8: fixture.privateKeyPkcs8,
      now: () => Date.now() / 1000 + 600,
    });
    wrongIssuer = await createPkcs8CapabilityIssuer({
      issuer: `${fixture.issuer}:wrong`,
      kid: fixture.kid,
      privateKeyPkcs8: fixture.privateKeyPkcs8,
    });
    const wrongPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    wrongKeyIssuer = await createPkcs8CapabilityIssuer({
      issuer: fixture.issuer,
      kid: fixture.kid,
      privateKeyPkcs8: await exportPKCS8(wrongPair.privateKey),
    });
    signingKey = await importPKCS8(fixture.privateKeyPkcs8, CapabilityAlgorithm);
  });

  describe("Doc capability HTTP conformance", () => {
    for (const docType of docTypes) {
      describe(docType, () => {
        const tenantId = `auth-${docType}`;
        let sessionId;
        let validToken;
        let writeResponse;
        let writeBody;

        beforeAll(async () => {
          const runtime = getRuntime();
          const createdResponse = await closeFetch(
            `${runtime.urls.gateway}/tenants/${tenantId}/docs/${docType}/`,
            { method: "POST" },
          );
          const created = await createdResponse.json();
          expect(createdResponse.ok, JSON.stringify(created)).toBe(true);
          const identity = await runtime.storage.sessionIdentity(docType, created.docId);
          expect(identity).toMatchObject({ tenantId });
          sessionId = identity.sessionId;
          validToken = await issueDocToken(issuer, {
            docType,
            tenantId,
            sessionId,
            permission: sessionReadPermission(tenantId, sessionId),
          });
          const [primaryWriteToken, delegatedToken] = await Promise.all([
            issueDocToken(issuer, {
              docType,
              tenantId,
              sessionId,
              permission: sessionWritePermission(tenantId, sessionId),
            }),
            issuer.issue({
              subject: `doc:${docType}`,
              audience: "unidocs-cas",
              tenantId,
              sessionId,
              permissions: [casReadPermission(tenantId), casWritePermission(tenantId)],
            }),
          ]);
          writeResponse = await closeFetch(
            `${runtime.urls[docType]}/tenants/${tenantId}/sessions/${sessionId}/apply`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${primaryWriteToken}`,
                "X-UniDocs-CAS-Capability": delegatedToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                baseVersion: 1,
                description: "capability conformance write",
                operations: [],
              }),
            },
          );
          writeBody = await writeResponse.json();
        });

        function history(headers = {}) {
          return closeFetch(
            `${getRuntime().urls[docType]}/tenants/${tenantId}/sessions/${sessionId}/history`,
            { headers },
          );
        }

        test("accepts exact Gateway-issued create, write, and read capabilities", async () => {
          expect(writeResponse.status, JSON.stringify(writeBody)).toBe(200);
          expect(writeBody).toMatchObject({ success: true, version: 2 });
          const response = await history({ Authorization: `Bearer ${validToken}` });
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body).toMatchObject({ success: true, version: 2 });
        });

        test("rejects missing, malformed, tampered, and legacy credentials", async () => {
          const tokenParts = validToken.split(".");
          tokenParts[2] = `${tokenParts[2][0] === "a" ? "b" : "a"}${tokenParts[2].slice(1)}`;
          const tampered = tokenParts.join(".");
          const responses = await Promise.all([
            history(),
            history({ Authorization: "Bearer not-a-jwt" }),
            history({ Authorization: `Bearer ${tampered}` }),
            history({ "X-Internal-Token": "legacy-probe" }),
          ]);
          expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401]);
        });

        test("rejects wrong audience, permission, tenant, and session", async () => {
          const otherTenant = `${tenantId}-other`;
          const otherSession = `${sessionId}-other`;
          const [casToken, writeToken, tenantToken, sessionToken] = await Promise.all([
            issuer.issue({
              subject: "gateway",
              audience: "unidocs-cas",
              tenantId,
              permissions: [casReadPermission(tenantId)],
            }),
            issueDocToken(issuer, {
              docType,
              tenantId,
              sessionId,
              permission: sessionWritePermission(tenantId, sessionId),
            }),
            issueDocToken(issuer, {
              docType,
              tenantId: otherTenant,
              sessionId,
              permission: sessionReadPermission(otherTenant, sessionId),
            }),
            issueDocToken(issuer, {
              docType,
              tenantId,
              sessionId: otherSession,
              permission: sessionReadPermission(tenantId, otherSession),
            }),
          ]);
          const responses = await Promise.all(
            [casToken, writeToken, tenantToken, sessionToken]
              .map(token => history({ Authorization: `Bearer ${token}` })),
          );
          expect(responses.map(response => response.status)).toEqual([401, 403, 403, 403]);
        });

        test("rejects expired, future, overlong, wrong-issuer, and wrong-key tokens", async () => {
          const permission = sessionReadPermission(tenantId, sessionId);
          const input = { docType, tenantId, sessionId, permission };
          const fixture = getRuntime().capabilityFixture;
          const tokens = await Promise.all([
            issueDocToken(expiredIssuer, input),
            issueDocToken(futureIssuer, input),
            issueOverlongDocToken(signingKey, fixture, input),
            issueDocToken(wrongIssuer, input),
            issueDocToken(wrongKeyIssuer, input),
          ]);
          const responses = await Promise.all(
            tokens.map(token => history({ Authorization: `Bearer ${token}` })),
          );
          expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401, 401]);
        });
      });
    }
  });

  if (directCas) {
    describe("CAS capability HTTP conformance", () => {
      const tenantId = "auth-cas";
      const content = new TextEncoder().encode("capability conformance");
      let hash;
      let readToken;

      beforeAll(async () => {
        const header = encodeHeader(content.length, "text/plain", 0);
        hash = hashToHex(await computeNodeDigest(header, "text/plain", [], content));
        const writeToken = await issueCasToken(
          issuer,
          tenantId,
          casWritePermission(tenantId),
        );
        readToken = await issueCasToken(issuer, tenantId, casReadPermission(tenantId));
        const response = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${writeToken}`,
              "Content-Type": "text/plain",
              "Content-Length": String(content.length),
              "X-CAS-Lease-Duration": "120000",
            },
            body: content,
          },
        );
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({ ready: true, hash });
      });

      test("accepts exact write, read, and admin capabilities", async () => {
        const contentResponse = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}/content`,
          { headers: { Authorization: `Bearer ${readToken}` } },
        );
        expect(contentResponse.status).toBe(200);
        expect(new Uint8Array(await contentResponse.arrayBuffer())).toEqual(content);

        const adminToken = await issueCasToken(
          issuer,
          tenantId,
          casAdminPermission(tenantId),
        );
        const usageResponse = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/usage`,
          { headers: { Authorization: `Bearer ${adminToken}` } },
        );
        const usage = await usageResponse.json();
        expect(usageResponse.status, JSON.stringify(usage)).toBe(200);
        expect(usage).toMatchObject({ nodeCount: expect.any(Number) });
      });

      test("rejects missing, legacy, Doc, wrong-permission, and wrong-tenant credentials", async () => {
        const sessionId = "session-cross-audience";
        const otherTenant = `${tenantId}-other`;
        const [docToken, adminToken, tenantToken] = await Promise.all([
          issueDocToken(issuer, {
            docType: docTypes[0],
            tenantId,
            sessionId,
            permission: sessionReadPermission(tenantId, sessionId),
          }),
          issueCasToken(issuer, tenantId, casAdminPermission(tenantId)),
          issueCasToken(issuer, otherTenant, casReadPermission(otherTenant)),
        ]);
        const url = `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}/content`;
        const responses = await Promise.all([
          closeFetch(url),
          closeFetch(url, { headers: { "X-Internal-Token": "legacy-probe" } }),
          closeFetch(url, { headers: { Authorization: `Bearer ${docToken}` } }),
          closeFetch(url, { headers: { Authorization: `Bearer ${adminToken}` } }),
          closeFetch(url, { headers: { Authorization: `Bearer ${tenantToken}` } }),
        ]);
        expect(responses.map(response => response.status)).toEqual([401, 401, 401, 403, 403]);
      });
    });
  }
}

function issueDocToken(issuer, { docType, tenantId, sessionId, permission }) {
  return issuer.issue({
    subject: "gateway",
    audience: `unidocs-doc:${docType}`,
    tenantId,
    sessionId,
    permissions: [permission],
  });
}

function issueCasToken(issuer, tenantId, permission) {
  return issuer.issue({
    subject: "gateway",
    audience: "unidocs-cas",
    tenantId,
    permissions: [permission],
  });
}

function issueOverlongDocToken(signingKey, fixture, { docType, tenantId, sessionId, permission }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    ver: 1,
    iss: fixture.issuer,
    sub: "gateway",
    aud: `unidocs-doc:${docType}`,
    iat: now,
    nbf: now - 5,
    exp: now + 301,
    jti: crypto.randomUUID(),
    tenantId,
    sessionId,
    permissions: [permission],
  }).setProtectedHeader({
    alg: CapabilityAlgorithm,
    kid: fixture.kid,
    typ: CapabilityTokenType,
  }).sign(signingKey);
}