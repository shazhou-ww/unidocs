/**
 * Production probe: exercises the docx worker's capability verification path
 * directly with a doc capability minted from the deployed doc-identity key
 * (.wrangler/prod/capability.json). The DOC verification must pass; the
 * missing delegated CAS capability must then fail closed. This proves the
 * docx worker's issuer+JWKS verifier is live with the deployed secrets.
 */
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const fixture = JSON.parse(readFileSync(new URL("../.wrangler/prod/capability.json", import.meta.url), "utf8"));
const privateKey = await importPKCS8(fixture.privateKeyPkcs8, "ES256");

const now = Math.floor(Date.now() / 1000);
const ISSUER = "https://unidocs.shazhou.work";
const TENANT = "alice";
const SESSION = "probe-session-1";

const token = await new SignJWT({
  ver: 1,
  iss: ISSUER,
  sub: "gateway",
  aud: "unidocs-doc:docx",
  iat: now,
  nbf: now - 5,
  exp: now + 120,
  jti: "probe-jti-1",
  tenantId: TENANT,
  sessionId: SESSION,
  permissions: [`tenants:${TENANT}:sessions:${SESSION}:read`],
})
  .setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: "unidocs-cap+jwt" })
  .sign(privateKey);

const target = "https://unidocs-docx.shazhou.workers.dev";
const paths = [
  `/tenants/${TENANT}/sessions/${SESSION}/query`, // expects delegated CAS -> missing -> 401
  `/tenants/${TENANT}/sessions/${SESSION}/history`, // no delegated CAS needed -> 200 path
];

for (const path of paths) {
  const r = await fetch(target + path, {
    method: path.endsWith("query") ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(path.endsWith("query") ? { body: "{}" } : {}),
    },
    ...(path.endsWith("query") ? { body: "{}" } : {}),
  });
  const text = (await r.text()).slice(0, 160);
  console.log(`[${r.status}] ${path} :: ${text}`);
}
