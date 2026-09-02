// Probe: measure per-CAS-operation latency against production unicas middleware.
// Mints a capability via the gateway OAuth flow, then issues direct CAS API calls
// (full-body lease, bodyless lease, readMetadata, lease-with-refs) and prints
// wall time plus the Server-Timing breakdown from the CAS worker.
import { createHash, randomBytes } from "node:crypto";

const HEADER_SIZE = 24;
const HASH_SIZE = 32;
const SIGNATURE = [0x55, 0x44]; // "UD"
const VERSION = 1;

function encodeHeader(contentSize, contentType, refCount) {
  const contentTypeBytes = new TextEncoder().encode(contentType);
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[0] = SIGNATURE[0];
  header[1] = SIGNATURE[1];
  view.setUint16(2, VERSION, true);
  view.setUint32(4, 0, true);
  view.setBigUint64(8, BigInt(contentSize), true);
  view.setUint32(16, refCount, true);
  view.setUint16(20, contentTypeBytes.length, true);
  view.setUint16(22, 0, true);
  return header;
}

function concatenateNodeBytes(header, contentType, childHashes, content) {
  const contentTypeBytes = new TextEncoder().encode(contentType);
  const total = HEADER_SIZE + contentTypeBytes.length + childHashes.length * HASH_SIZE + content.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(header, offset); offset += header.length;
  out.set(contentTypeBytes, offset); offset += contentTypeBytes.length;
  for (const hash of childHashes) { out.set(hash, offset); offset += HASH_SIZE; }
  out.set(content, offset);
  return out;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(HASH_SIZE);
  for (let i = 0; i < HASH_SIZE; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function canonicalNode(content, contentType, refs = []) {
  const childHashes = refs.map(hexToBytes);
  const header = encodeHeader(content.length, contentType, childHashes.length);
  const bytes = concatenateNodeBytes(header, contentType, childHashes, content);
  return { hash: sha256Hex(bytes), bytes };
}

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = GATEWAY + "/oauth/unidocs-cloudflare";
const REDIRECT_URI = GATEWAY + "/ui/callback";
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const STACK_ID = "cas_SZ6wfcfqS34J";
const TENANT = "shazhou-ww";
const CAS_BASE = `https://unicas.shazhou.work/stacks/${STACK_ID}/tenants/${TENANT}/cas`;

const b64u = (b) => Buffer.from(b).toString("base64url");

async function sealSession() {
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

async function mintCapability() {
  const cookie = "gw_sess=" + await sealSession();
  const reg = await fetch(ISSUER_BASE + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const client = await reg.json();
  const verifier = "latency-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const au = new URL(ISSUER_BASE + "/authorize");
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT_URI,
    scope: "cas:read cas:write cas:manage",
    code_challenge: challenge, code_challenge_method: "S256",
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
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, client_id: client.client_id,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    }),
  });
  return (await tok.json()).access_token;
}

async function call(token, label, fn) {
  const t = Date.now();
  const res = await fn(token);
  const ms = Date.now() - t;
  const timing = res.headers.get("Server-Timing") ?? "(no Server-Timing)";
  console.log(`${label.padEnd(38)} ${res.status}  ${String(ms).padStart(6)}ms  ST[${timing}]`);
  return { ms, timing, status: res.status, res };
}

const CAS_NODE_CONTENT_TYPE = "application/vnd.unidocs.cas-node.v1";

async function main() {
  const token = await mintCapability();
  const auth = { Authorization: "Bearer " + token, "Content-Type": CAS_NODE_CONTENT_TYPE };

  const probe = canonicalNode(new TextEncoder().encode("probe-cas-latency"), "application/octet-stream", []);
  console.log("probe node hash:", probe.hash);

  // 1. First full-body lease of a brand-new node (cold upload path).
  await call(token, "lease full-body (new node)", async (t) => fetch(
    `${CAS_BASE}/nodes/${probe.hash}/lease`,
    { method: "POST", headers: auth, body: probe.bytes },
  ));

  // 2. Bodyless lease of the now-ready node (renewal path) — R2 HEAD on existing key.
  await call(token, "lease bodyless (ready node)", async (t) => fetch(
    `${CAS_BASE}/nodes/${probe.hash}/lease`,
    { method: "POST", headers: { Authorization: "Bearer " + t } },
  ));

  // 3. readMetadata.
  await call(token, "readMetadata", async (t) => fetch(
    `${CAS_BASE}/nodes/${probe.hash}/metadata`,
    { headers: { Authorization: "Bearer " + t } },
  ));

  // 4. Full-body lease with one existing child ref (measures child-ready checks).
  const withRef = canonicalNode(
    new TextEncoder().encode("probe-with-ref"),
    "application/x-probe",
    [probe.hash],
  );
  await call(token, "lease full-body (1 existing ref)", async (t) => fetch(
    `${CAS_BASE}/nodes/${withRef.hash}/lease`,
    { method: "POST", headers: auth, body: withRef.bytes },
  ));

  // 5. Repeat full-body lease of the new node (warm path, node now ready).
  await call(token, "lease full-body (warm, exists)", async (t) => fetch(
    `${CAS_BASE}/nodes/${probe.hash}/lease`,
    { method: "POST", headers: auth, body: probe.bytes },
  ));

  // 6. Repeat bodyless leases to see variance / DO warm-up.
  for (let i = 0; i < 3; i++) {
    await call(token, `lease bodyless (repeat ${i + 1})`, async (t) => fetch(
      `${CAS_BASE}/nodes/${probe.hash}/lease`,
      { method: "POST", headers: { Authorization: "Bearer " + t } },
    ));
  }

  // 7. Sustained sample: 10 back-to-back bodyless leases for min/median/max.
  const times = [];
  const r2heads = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    const r = await fetch(`${CAS_BASE}/nodes/${probe.hash}/lease`, {
      method: "POST", headers: { Authorization: "Bearer " + token },
    });
    const ms = Date.now() - t;
    times.push(ms);
    const head = /cas_r2_head;dur=([0-9.]+)/.exec(r.headers.get("Server-Timing") ?? "")?.[1] ?? "-";
    r2heads.push(head);
    console.log(`sample ${String(i).padStart(2)}  ${r.status}  ${String(ms).padStart(6)}ms  r2_head=${head}`);
    await new Promise((res) => setTimeout(res, 300));
  }
  times.sort((a, b) => a - b);
  console.log("sample sorted:", times.join(","));
  console.log("sample min", times[0], "median", times[5], "max", times[9]);
}

main().catch((err) => { console.error("FAILED:", err); process.exit(1); });
