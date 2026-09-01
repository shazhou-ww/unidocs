/**
 * Verify auto-provisioning: a brand-new principal (no membership) with a
 * verified email resolves their own tenant from the email on authorize, and
 * the membership row is created. Uses the real operator's Google sub/email so
 * their next browser login resolves immediately.
 */
import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = `${GATEWAY}/oauth/unidocs-cloudflare`;
const REDIRECT_URI = `${GATEWAY}/ui/callback`;
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const SUB = "102681972452057176712";
const EMAIL = "shazhou.ww@gmail.com";
const b64u = (b) => Buffer.from(b).toString("base64url");

async function sealCookie() {
  const key = createHash("sha256").update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: SUB,
    name: "Scott Wei",
    email: EMAIL,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

const cookie = `gw_sess=${await sealCookie()}`;
const reg = await fetch(`${ISSUER_BASE}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "auto-provision-check" }),
});
const client = await reg.json();
const verifier = "autoprovision-verifier-abcdefghijklmnopqrstuvwxyz-0123";
const challenge = b64u(createHash("sha256").update(verifier).digest());
const au = new URL(`${ISSUER_BASE}/authorize`);
for (const [k, v] of Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI,
  scope: "cas:read cas:write cas:manage", state: "s",
  code_challenge: challenge, code_challenge_method: "S256",
})) au.searchParams.set(k, v);

const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
const consentHtml = await consent.text();
const tid = /name="transaction_id" value="([^"]+)"/.exec(consentHtml)?.[1];
if (consent.status !== 200 || !tid) {
  throw new Error(`consent failed: ${consent.status} ${consentHtml.slice(0, 200)}`);
}
console.log("consent OK, transaction:", tid);

const decision = await fetch(`${ISSUER_BASE}/authorize/decision`, {
  method: "POST", redirect: "manual",
  headers: { Cookie: cookie, Origin: GATEWAY, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ transaction_id: tid, decision: "approve" }),
});
const code = new URL(decision.headers.get("Location")).searchParams.get("code");
const tok = await fetch(`${ISSUER_BASE}/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
});
const token = await tok.json();
if (tok.status !== 200 || !token.access_token) {
  throw new Error(`token failed: ${tok.status} ${JSON.stringify(token)}`);
}
const payload = JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url"));
console.log("access token tenantId:", payload.tenantId);
console.log("access token iss:", payload.iss, "sub:", payload.sub);

// The documents list should now work for the auto-provisioned tenant.
const list = await fetch(`${GATEWAY}/tenants/${payload.tenantId}/docs/docx/`, {
  headers: { Authorization: `Bearer ${token.access_token}` },
});
console.log("docx list:", list.status, (await list.text()).slice(0, 120));
