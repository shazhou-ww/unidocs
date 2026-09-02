// Verify migrated bucket: mint a capability, then read pre-migration nodes
// (metadata + content) through the CAS API now served from unidocs-cas-apac.
import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = GATEWAY + "/oauth/unidocs-cloudflare";
const REDIRECT_URI = GATEWAY + "/ui/callback";
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const STACK_ID = "cas_SZ6wfcfqS34J";
const TENANT = "shazhou-ww";
const CAS_BASE = `https://unicas.shazhou.work/stacks/${STACK_ID}/tenants/${TENANT}/cas`;
const HASHES = process.argv.slice(2);

const b64u = (b) => Buffer.from(b).toString("base64url");

async function sealSession() {
  const key = createHash("sha256").update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: "102681972452057176712", name: "Scott Wei", email: "shazhou.ww@gmail.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

async function mintCapability() {
  const cookie = "gw_sess=" + await sealSession();
  const reg = await fetch(ISSUER_BASE + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const client = await reg.json();
  const verifier = "verify-migration-verifier-abcdefghijklmnopqrstuvwxyz";
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const au = new URL(ISSUER_BASE + "/authorize");
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI,
    scope: "cas:read cas:write cas:manage", code_challenge: challenge, code_challenge_method: "S256",
  })) au.searchParams.set(k, v);
  const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: "manual" });
  const tid = /name="transaction_id" value="([^"]+)"/.exec(await consent.text())?.[1];
  if (!tid) throw new Error("no transaction_id");
  const decision = await fetch(ISSUER_BASE + "/authorize/decision", {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, Origin: "null", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: tid, decision: "approve" }),
  });
  const code = new URL(decision.headers.get("Location")).searchParams.get("code");
  const tok = await fetch(ISSUER_BASE + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  return (await tok.json()).access_token;
}

const token = await mintCapability();
const auth = { Authorization: `Bearer ${token}` };
for (const hash of HASHES) {
  const md = await fetch(`${CAS_BASE}/nodes/${hash}/metadata`, { headers: auth });
  const mdBody = await md.json();
  console.log(`metadata ${hash.slice(0, 12)}: ${md.status} size=${mdBody.metadata?.size} ct=${mdBody.metadata?.contentType}`);
  const ct = await fetch(`${CAS_BASE}/nodes/${hash}/content`, { headers: auth });
  const bytes = new Uint8Array(await ct.arrayBuffer());
  console.log(`content  ${hash.slice(0, 12)}: ${ct.status} bytes=${bytes.length} ct=${ct.headers.get("content-type")}`);
}

// List docs through the gateway and export one pre-migration docx if present.
if (process.env.LIST_DOCS === "1") {
  const list = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx`, { headers: auth });
  const body = await list.json();
  const docs = body.data ?? [];
  console.log(`gateway list docx: ${list.status} count=${body.count}`);
  console.log("docx docs:", JSON.stringify(docs.map((d) => ({ id: d.doc_id.slice(0, 8), v: d.version }))));
  if (docs.length > 0) {
    const docId = process.env.DOC_ID ?? docs[0].doc_id;
    const ex = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/${docId}/export`, { headers: auth });
    const buf = new Uint8Array(await ex.arrayBuffer());
    const sig = buf.length > 2 ? String.fromCharCode(buf[0], buf[1]) : "";
    console.log(`export ${docId.slice(0, 8)}: ${ex.status} bytes=${buf.length} sig=${sig}`);
  }
}
