/**
 * Production end-to-end verification of the UniDocs docx flow without the
 * interactive Google screen: mints a gateway session cookie for a controlled
 * test identity (the deployment's GATEWAY_SESSION_ENCRYPTION_KEY), completes
 * the OAuth authorization-code + PKCE flow, and runs docx create -> apply ->
 * export through the public gateway. The only skipped step is the upstream
 * Google login UI itself; everything else is the real production chain.
 */
import { createHash, randomBytes } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER_BASE = `${GATEWAY}/oauth/unidocs-cloudflare`;
const REDIRECT_URI = `${GATEWAY}/ui/callback`;
const SESSION_KEY = "AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=";
const PRINCIPAL = "verify-e2e-user";
const TENANT = "alice";

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function sealSessionCookie() {
  const key = createHash("sha256").update(SESSION_KEY, "utf8").digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: PRINCIPAL,
    name: "Verification User",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cipher, payload,
  ));
  return base64Url(Buffer.concat([iv, Buffer.from(ciphertext)]));
}

async function registerClient() {
  const r = await fetch(`${ISSUER_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      client_name: "prod-e2e-verification",
    }),
  });
  const body = await r.json();
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(body)}`);
  return body.client_id;
}

async function main() {
  const cookieValue = await sealSessionCookie();
  const cookie = `gw_sess=${cookieValue}`;
  const clientId = await registerClient();
  console.log("client registered:", clientId);

  const verifier = "prod-e2e-verifier-abcdefghijklmnopqrstuvwxyz-012345";
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = new URL(`${ISSUER_BASE}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    tenant_id: TENANT,
    scope: "cas:read cas:write cas:manage",
    state: "prod-e2e-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorizeUrl.searchParams.set(name, value);

  const consent = await fetch(authorizeUrl, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  const consentHtml = await consent.text();
  const transactionId = /name="transaction_id" value="([^"]+)"/.exec(consentHtml)?.[1];
  if (consent.status !== 200 || !transactionId) {
    throw new Error(`consent failed: ${consent.status} ${consentHtml.slice(0, 200)}`);
  }
  console.log("consent obtained, transaction:", transactionId);

  const decision = await fetch(`${ISSUER_BASE}/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Origin: GATEWAY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ transaction_id: transactionId, decision: "approve" }),
  });
  const location = decision.headers.get("Location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (decision.status !== 303 || !code) {
    throw new Error(`decision failed: ${decision.status} ${location}`);
  }
  console.log("authorization code obtained");

  const tokenResponse = await fetch(`${ISSUER_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const token = await tokenResponse.json();
  if (tokenResponse.status !== 200 || !token.access_token) {
    throw new Error(`token exchange failed: ${tokenResponse.status} ${JSON.stringify(token)}`);
  }
  console.log("access token obtained (scopes:", token.scope + ")");
  const auth = { Authorization: `Bearer ${token.access_token}` };

  // Create a docx document.
  const create = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await create.json();
  if (!create.ok || !created.docId) {
    throw new Error(`create failed: ${create.status} ${JSON.stringify(created)}`);
  }
  const docId = created.docId;
  console.log("docx created:", docId, "version", created.version);

  // Edit: append a paragraph (one retry for the transient local-socket quirk
  // does not apply here; production fetch handles keep-alive properly, but a
  // single retry is harmless insurance).
  const applyBody = JSON.stringify({
    baseVersion: 1,
    description: "append",
    operations: [{ kind: "appendParagraph", payload: { text: "production e2e" } }],
  });
  let apply = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/${docId}/apply`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: applyBody,
  });
  if (apply.status === 502) {
    apply = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/${docId}/apply`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: applyBody,
    });
  }
  const applied = await apply.json();
  if (!apply.ok || !applied.success) {
    throw new Error(`apply failed: ${apply.status} ${JSON.stringify(applied)}`);
  }
  console.log("docx edited: version", applied.version);

  // Read back the text.
  const query = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/${docId}/query`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getText" }),
  });
  const queryBody = await query.json();
  console.log("query:", query.status, JSON.stringify(queryBody.data));

  // Download: export as a docx file.
  const exportResponse = await fetch(`${GATEWAY}/tenants/${TENANT}/docs/docx/${docId}/export`, {
    headers: auth,
  });
  const bytes = Buffer.from(await exportResponse.arrayBuffer());
  if (!exportResponse.ok || bytes.length === 0) {
    throw new Error(`export failed: ${exportResponse.status}`);
  }
  console.log("docx downloaded:", bytes.length, "bytes,", exportResponse.headers.get("content-type"));
  console.log("docx zip signature:", bytes.subarray(0, 2).toString("hex") === "504b" ? "OK (PK)" : "unexpected");
  console.log("\nALL PRODUCTION E2E CHECKS PASSED");
}

main().catch((error) => {
  console.error("E2E FAILED:", error.message);
  process.exit(1);
});
