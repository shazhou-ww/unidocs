import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = `${GATEWAY}/oauth/unidocs-cloudflare`;
const REDIRECT_URI = `${GATEWAY}/ui/callback`;
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const b64u = (b) => Buffer.from(b).toString("base64url");

async function seal() {
  const key = createHash("sha256").update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: "102681972452057176712",
    name: "Scott Wei",
    email: "shazhou.ww@gmail.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

const cookie = `gw_sess=${await seal()}`;
const reg = await fetch(`${ISSUER_BASE}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
});
const client = await reg.json();
const au = new URL(`${ISSUER_BASE}/authorize`);
for (const [k, v] of Object.entries({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT_URI,
  scope: "cas:read cas:write cas:manage",
  code_challenge: "A".repeat(43),
  code_challenge_method: "S256",
})) au.searchParams.set(k, v);
const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
const html = await consent.text();
const action = /action="([^"]+)"/.exec(html)?.[1];
console.log("status:", consent.status);
console.log("title UniDocs access:", html.includes("Authorize UniDocs access"));
console.log("title UniCAS gone:", !html.includes("Authorize UniCAS"));
console.log("View your documents:", html.includes("View your documents"));
console.log("Edit your documents:", html.includes("Edit your documents"));
console.log("Manage your document storage:", html.includes("Manage your document storage"));
console.log("form action:", action);
