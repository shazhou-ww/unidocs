/** Quick production check: document list (what the webui shows) with a token. */
import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = `${GATEWAY}/oauth/unidocs-cloudflare`;
const REDIRECT_URI = `${GATEWAY}/ui/callback`;
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const b64u = (b) => Buffer.from(b).toString("base64url");

async function sealCookie() {
  const key = createHash("sha256").update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: "verify-e2e-user", name: "Verification User", exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

const cookie = `gw_sess=${await sealCookie()}`;
const reg = await fetch(`${ISSUER_BASE}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
});
const client = await reg.json();
const verifier = "list-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
const challenge = b64u(createHash("sha256").update(verifier).digest());
const au = new URL(`${ISSUER_BASE}/authorize`);
for (const [k, v] of Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI,
  tenant_id: "alice", scope: "cas:read cas:write cas:manage", state: "s",
  code_challenge: challenge, code_challenge_method: "S256",
})) au.searchParams.set(k, v);
const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
const tid = /name="transaction_id" value="([^"]+)"/.exec(await consent.text())?.[1];
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
const token = (await tok.json()).access_token;

for (const type of ["docx", "markdown"]) {
  const r = await fetch(`${GATEWAY}/tenants/alice/docs/${type}/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json();
  console.log(`${type} list:`, r.status, "count:", body.count, "docs:", body.data?.map(d => d.doc_id.slice(0, 8)).join(", ") ?? JSON.stringify(body).slice(0, 120));
}
