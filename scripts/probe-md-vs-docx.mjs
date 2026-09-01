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
    sub: "verify-e2e-user",
    name: "Verification User",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

async function getToken() {
  const cookie = `gw_sess=${await sealCookie()}`;
  const reg = await fetch(`${ISSUER_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "probe-md" }),
  });
  const client = await reg.json();
  const verifier = "probe-md-verifier-abcdefghijklmnopqrstuvwxyz-0123";
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const au = new URL(`${ISSUER_BASE}/authorize`);
  au.searchParams.set("response_type", "code");
  au.searchParams.set("client_id", client.client_id);
  au.searchParams.set("redirect_uri", REDIRECT_URI);
  au.searchParams.set("tenant_id", "alice");
  au.searchParams.set("scope", "cas:read cas:write cas:manage");
  au.searchParams.set("state", "s");
  au.searchParams.set("code_challenge", challenge);
  au.searchParams.set("code_challenge_method", "S256");
  const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
  const html = await consent.text();
  const tid = /name="transaction_id" value="([^"]+)"/.exec(html)?.[1];
  const decision = await fetch(`${ISSUER_BASE}/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie, Origin: GATEWAY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: tid, decision: "approve" }),
  });
  const code = new URL(decision.headers.get("Location")).searchParams.get("code");
  const tok = await fetch(`${ISSUER_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  return (await tok.json()).access_token;
}

const token = await getToken();
console.log("token ok");
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
for (const type of ["markdown", "docx"]) {
  const t = Date.now();
  try {
    const r = await fetch(`${GATEWAY}/tenants/alice/docs/${type}/`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const body = await r.json();
    console.log(type, "create:", r.status, "in", Date.now() - t, "ms", JSON.stringify(body).slice(0, 120));
  } catch (e) {
    console.log(type, "ERR", e.message);
  }
}
