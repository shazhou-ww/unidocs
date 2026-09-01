/**
 * Production probe: exercises the docx worker's delegated CAS verification
 * with a token that carries the correct stack issuer but is signed by the
 * wrong key. The verifier must fetch the remote JWKS (CAS_STACK_JWKS_URI
 * discovery) and reject with a signature failure — proving the live JWKS
 * discovery path works, not that it fails on network errors.
 */
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const fixture = JSON.parse(readFileSync(new URL("../.wrangler/prod/capability.json", import.meta.url), "utf8"));
const privateKey = await importPKCS8(fixture.privateKeyPkcs8, "ES256");

const now = Math.floor(Date.now() / 1000);
const DOC_ISSUER = "https://unidocs.shazhou.work";
const STACK_ISSUER = "https://unicas.shazhou.work/oauth/unidocs-cloudflare";
const STACK_AUDIENCE = "https://unicas.shazhou.work/stacks/cas_SZ6wfcfqS34J";
const TENANT = "alice";
const SESSION = "probe-session-1";

const docToken = await new SignJWT({
  ver: 1, iss: DOC_ISSUER, sub: "gateway", aud: "unidocs-doc:docx",
  iat: now, nbf: now - 5, exp: now + 120, jti: "probe-doc-1",
  tenantId: TENANT, sessionId: SESSION,
  permissions: [`tenants:${TENANT}:sessions:${SESSION}:read`],
}).setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: "unidocs-cap+jwt" }).sign(privateKey);

// Delegated CAS-shaped token: correct stack issuer/audience/subject, but
// signed with the doc key (not the registered stack key).
const casToken = await new SignJWT({
  ver: 1, iss: STACK_ISSUER, sub: `doc:docx`, aud: STACK_AUDIENCE,
  iat: now, nbf: now - 5, exp: now + 120, jti: "probe-cas-1",
  tenantId: TENANT, sessionId: SESSION,
  permissions: [`tenants:${TENANT}:cas:read`],
}).setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: "unidocs-cap+jwt" }).sign(privateKey);

const r = await fetch(`https://unidocs-docx.shazhou.workers.dev/tenants/${TENANT}/sessions/${SESSION}/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${docToken}`,
    "X-UniDocs-CAS-Capability": casToken,
    "Content-Type": "application/json",
  },
  body: "{}",
});
const text = (await r.text()).slice(0, 200);
console.log(`[${r.status}] query with wrong-key delegated CAS :: ${text}`);
