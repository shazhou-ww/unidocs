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
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "../../../packages/service-auth/src/index.ts";
import {
  computeNodeDigest,
  encodeHeader,
  hashToHex,
  parseNodeBytes,
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

        test("isolates equal document and session IDs across tenants", async () => {
          const runtime = getRuntime();
          const tenants = [`collision-${docType}-a`, `collision-${docType}-b`];
          const docId = `shared-${docType}-doc`;
          const createResponses = await Promise.all(tenants.map(tenant => closeFetch(
            `${runtime.urls.gateway}/tenants/${tenant}/docs/${docType}/`,
            {
              method: "POST",
              headers: {
                "X-Doc-Id": docId,
                "Idempotency-Key": "shared-create-key",
                "X-User-Id": "untrusted-user-key",
              },
            },
          )));
          const created = await Promise.all(createResponses.map(response => response.json()));
          expect(createResponses.map(response => response.status), JSON.stringify(created))
            .toEqual([200, 200]);
          expect(created.map(body => body.docId)).toEqual([docId, docId]);
          const identities = await Promise.all(
            tenants.map(tenant => runtime.storage.sessionIdentity(docType, docId, tenant)),
          );
          expect(identities.map(identity => identity.tenantId)).toEqual(tenants);
          expect(identities[0].sessionId).not.toBe(identities[1].sessionId);

          const sharedSessionId = `shared-${docType}-session`;
          const createSessions = await Promise.all(tenants.map(async tenant => {
            const [primaryToken, delegatedToken] = await Promise.all([
              issueDocToken(issuer, {
                docType,
                tenantId: tenant,
                sessionId: sharedSessionId,
                permission: sessionCreatePermission(tenant),
              }),
              issueDelegatedCasToken(
                issuer,
                docType,
                tenant,
                sharedSessionId,
                [casWritePermission(tenant)],
              ),
            ]);
            return closeFetch(
              `${runtime.urls[docType]}/tenants/${tenant}/sessions/${sharedSessionId}`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${primaryToken}`,
                  "X-UniDocs-CAS-Capability": delegatedToken,
                  "X-User-Id": "untrusted-user-key",
                },
              },
            );
          }));
          const sessionBodies = await Promise.all(createSessions.map(response => response.json()));
          expect(createSessions.map(response => response.status), JSON.stringify(sessionBodies))
            .toEqual([200, 200]);

          const [writeToken, delegatedWriteToken] = await Promise.all([
            issueDocToken(issuer, {
              docType,
              tenantId: tenants[0],
              sessionId: sharedSessionId,
              permission: sessionWritePermission(tenants[0], sharedSessionId),
            }),
            issueDelegatedCasToken(
              issuer,
              docType,
              tenants[0],
              sharedSessionId,
              [casReadPermission(tenants[0]), casWritePermission(tenants[0])],
            ),
          ]);
          const applyResponse = await closeFetch(
            `${runtime.urls[docType]}/tenants/${tenants[0]}/sessions/${sharedSessionId}/apply`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${writeToken}`,
                "X-UniDocs-CAS-Capability": delegatedWriteToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                baseVersion: 1,
                description: "advance only tenant A",
                operations: [],
              }),
            },
          );
          const applied = await applyResponse.json();
          expect(applyResponse.status, JSON.stringify(applied)).toBe(200);

          const histories = await Promise.all(tenants.map(async tenant => {
            const token = await issueDocToken(issuer, {
              docType,
              tenantId: tenant,
              sessionId: sharedSessionId,
              permission: sessionReadPermission(tenant, sharedSessionId),
            });
            const response = await closeFetch(
              `${runtime.urls[docType]}/tenants/${tenant}/sessions/${sharedSessionId}/history`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            return { response, body: await response.json() };
          }));
          expect(histories.map(({ response }) => response.status)).toEqual([200, 200]);
          expect(histories.map(({ body }) => body.version)).toEqual([2, 1]);
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
        expect(Object.keys(usage).sort()).toEqual([
          "leasedNodeCount",
          "nodeCount",
          "notReadyNodeCount",
          "readyContentBytes",
        ]);
        expect(usage).toMatchObject({
          nodeCount: expect.any(Number),
          readyContentBytes: expect.any(Number),
          notReadyNodeCount: expect.any(Number),
          leasedNodeCount: expect.any(Number),
        });
      });

      test("preserves metadata, lease, portable-node, root, and GC wire contracts", async () => {
        const metadataResponse = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}/metadata`,
          { headers: { Authorization: `Bearer ${readToken}` } },
        );
        const metadataBody = await metadataResponse.json();
        expect(metadataResponse.status).toBe(200);
        expect(metadataBody.metadata).toEqual({
          hash,
          size: content.length,
          contentType: "text/plain",
          refs: [],
        });
        expect(metadataBody.state).toMatchObject({
          leaseStartedAt: expect.any(Number),
          leaseExpiresAt: expect.any(Number),
          childRefCount: 0,
          rootRefCount: 0,
        });

        const writeToken = await issueCasToken(
          issuer,
          tenantId,
          casWritePermission(tenantId),
        );
        const lease = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}/lease`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${writeToken}`,
              "X-CAS-Lease-Duration": "180000",
            },
          },
        );
        const leaseBody = await lease.json();
        expect(lease.status).toBe(200);
        expect(leaseBody).toEqual({
          hash,
          ready: true,
          leaseStartedAt: expect.any(Number),
          leaseExpiresAt: expect.any(Number),
        });
        expect(leaseBody.leaseExpiresAt).toBeGreaterThan(leaseBody.leaseStartedAt);

        const portable = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/_internal/nodes/${hash}`,
          { headers: { Authorization: `Bearer ${readToken}` } },
        );
        const portableBytes = new Uint8Array(await portable.arrayBuffer());
        expect(portable.status).toBe(200);
        expect(portable.headers.get("content-type")).toBe("application/vnd.unidocs.cas-node");
        expect(Number(portable.headers.get("content-length"))).toBe(portableBytes.length);
        const parsed = parseNodeBytes(portableBytes);
        expect(parsed.contentType).toBe("text/plain");
        expect(parsed.childHashes).toEqual([]);
        expect(parsed.content).toEqual(content);

        const portableLease = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/_internal/nodes/${hash}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${writeToken}`,
              "Content-Type": "application/vnd.unidocs.cas-node",
              "X-CAS-Lease-Duration": "180000",
            },
            body: portableBytes,
          },
        );
        const portableLeaseBody = await portableLease.json();
        expect(portableLease.status, JSON.stringify(portableLeaseBody)).toBe(200);
        expect(portableLeaseBody).toEqual({
          hash,
          ready: true,
          leaseStartedAt: expect.any(Number),
          leaseExpiresAt: expect.any(Number),
        });

        const sessionId = "cas-wire-session";
        const delegatedWriteToken = await issueDelegatedCasToken(
          issuer,
          "docx",
          tenantId,
          sessionId,
          [casWritePermission(tenantId)],
        );
        const rootRefsBody = {
          requestId: "cas-wire-root-refs",
          changes: { [hash]: 1 },
        };
        const rootRefsUrl = `${getRuntime().urls.cas}/tenants/${tenantId}/_internal/root-refs`;
        const rootRefs = await postJson(rootRefsUrl, delegatedWriteToken, rootRefsBody);
        expect(rootRefs.response.status, JSON.stringify(rootRefs.body)).toBe(200);
        expect(rootRefs.body).toEqual({ success: true });
        const rootRefsRetry = await postJson(rootRefsUrl, delegatedWriteToken, rootRefsBody);
        expect(rootRefsRetry.body).toEqual({ success: true, idempotent: true });

        const assignmentsBody = {
          requestId: "cas-wire-root-assignments",
          assignments: [{ owner: `session:${sessionId}:wire:1`, hash }],
        };
        const assignmentsUrl = `${getRuntime().urls.cas}/tenants/${tenantId}/_internal/root-assignments`;
        const assignments = await postJson(assignmentsUrl, delegatedWriteToken, assignmentsBody);
        expect(assignments.response.status, JSON.stringify(assignments.body)).toBe(200);
        expect(assignments.body).toEqual({ success: true, idempotent: false });
        const assignmentsRetry = await postJson(
          assignmentsUrl,
          delegatedWriteToken,
          assignmentsBody,
        );
        expect(assignmentsRetry.body).toEqual({ success: true, idempotent: true });

        const adminToken = await issueCasToken(
          issuer,
          tenantId,
          casAdminPermission(tenantId),
        );
        const gc = await closeFetch(
          `${getRuntime().urls.cas}/tenants/${tenantId}/cas/gc`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ maxNodes: 1 }),
          },
        );
        const gcBody = await gc.json();
        expect(gc.status).toBe(200);
        expect(gcBody).toEqual({
          examined: expect.any(Number),
          deleted: expect.any(Number),
          reclaimedContentBytes: expect.any(Number),
        });
        expect(gcBody.deleted).toBe(0);
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

      test("stores an equal hash independently in another tenant", async () => {
        const otherTenant = `${tenantId}-other`;
        const [otherReadToken, otherWriteToken] = await Promise.all([
          issueCasToken(issuer, otherTenant, casReadPermission(otherTenant)),
          issueCasToken(issuer, otherTenant, casWritePermission(otherTenant)),
        ]);
        const otherUrl = `${getRuntime().urls.cas}/tenants/${otherTenant}/cas/nodes/${hash}`;
        const missing = await closeFetch(`${otherUrl}/content`, {
          headers: { Authorization: `Bearer ${otherReadToken}` },
        });
        expect(missing.status).toBe(404);

        const upload = await closeFetch(otherUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${otherWriteToken}`,
            "Content-Type": "text/plain",
            "Content-Length": String(content.length),
            "X-CAS-Lease-Duration": "120000",
          },
          body: content,
        });
        const uploaded = await upload.json();
        expect(upload.status, JSON.stringify(uploaded)).toBe(200);
        expect(uploaded).toMatchObject({ ready: true, hash });

        const reads = await Promise.all([
          closeFetch(
            `${getRuntime().urls.cas}/tenants/${tenantId}/cas/nodes/${hash}/content`,
            { headers: { Authorization: `Bearer ${readToken}` } },
          ),
          closeFetch(`${otherUrl}/content`, {
            headers: { Authorization: `Bearer ${otherReadToken}` },
          }),
        ]);
        expect(reads.map(response => response.status)).toEqual([200, 200]);
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

function issueDelegatedCasToken(issuer, docType, tenantId, sessionId, permissions) {
  return issuer.issue({
    subject: `doc:${docType}`,
    audience: "unidocs-cas",
    tenantId,
    sessionId,
    permissions,
  });
}

async function postJson(url, token, value) {
  const response = await closeFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  return { response, body: await response.json() };
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