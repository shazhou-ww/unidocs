// Verify a FRESH node upload no longer does the read-back R2 GET (cas_r2_prefix).
import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = GATEWAY + "/oauth/unidocs-cloudflare";
const REDIRECT_URI = GATEWAY + "/ui/callback";
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const b64u = (b) => Buffer.from(b).toString("base64url");

async function seal() {
  const key = createHash("sha256").update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const p = Buffer.from(JSON.stringify({
    sub: "102681972452057176712", name: "Scott Wei", email: "shazhou.ww@gmail.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const c = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, c, p));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

async function mint() {
  const cookie = "gw_sess=" + await seal();
  const reg = await fetch(ISSUER_BASE + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const client = await reg.json();
  const verifier = "fresh-upload-verifier-abcdefghijklmnopqrstuvwxyz";
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const au = new URL(ISSUER_BASE + "/authorize");
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI,
    scope: "cas:read cas:write cas:manage", code_challenge: challenge, code_challenge_method: "S256",
  })) au.searchParams.set(k, v);
  const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
  const tid = /name="transaction_id" value="([^"]+)"/.exec(await consent.text())?.[1];
  const dec = await fetch(ISSUER_BASE + "/authorize/decision", {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, Origin: "null", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: tid, decision: "approve" }),
  });
  const code = new URL(dec.headers.get("Location")).searchParams.get("code");
  const tok = await fetch(ISSUER_BASE + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  return (await tok.json()).access_token;
}

const token = await mint();
for (let i = 0; i < 3; i++) {
  const content = new TextEncoder().encode("fresh-upload-" + Date.now() + "-" + i);
  const contentType = "application/octet-stream";
  const header = new Uint8Array(24);
  const v = new DataView(header.buffer);
  header[0] = 0x55; header[1] = 0x44;
  v.setUint16(2, 1, true);
  v.setBigUint64(8, BigInt(content.length), true);
  v.setUint32(16, 0, true);
  v.setUint16(20, contentType.length, true);
  const ctB = new TextEncoder().encode(contentType);
  const node = new Uint8Array(24 + ctB.length + content.length);
  node.set(header, 0); node.set(ctB, 24); node.set(content, 24 + ctB.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", node));
  const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const url = "https://unicas.shazhou.work/stacks/cas_SZ6wfcfqS34J/tenants/shazhou-ww/cas/nodes/" + hash + "/lease";
  const t = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/vnd.unidocs.cas-node.v1" },
    body: node,
  });
  const ms = Date.now() - t;
  const st = r.headers.get("Server-Timing") ?? "";
  console.log(`fresh lease ${i}: ${r.status} ${ms}ms  read-back-GET=${/cas_r2_prefix/.test(st)}  ${st}`);
}
