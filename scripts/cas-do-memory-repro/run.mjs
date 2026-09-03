import { createHash, randomBytes, randomUUID } from "node:crypto";

const GATEWAY = "https://unidocs.shazhou.work";
const ISSUER = `${GATEWAY}/oauth/unidocs-cloudflare`;
const REDIRECT_URI = `${GATEWAY}/ui/callback`;
const TENANT = "shazhou-ww";
const PRINCIPAL = {
  sub: "102681972452057176712",
  name: "Scott Wei",
  email: "shazhou.ww@gmail.com",
};

const endpoint = requiredEnv("CAS_DO_REPRO_URL");
const reproKey = requiredEnv("CAS_DO_REPRO_KEY");
const sessionKey = requiredEnv("GATEWAY_SESSION_ENCRYPTION_KEY");
const input = {
  instance: randomUUID(),
  tenantId: TENANT,
  count: integerArg("--count", 7),
  concurrency: integerArg("--concurrency", 6),
  contentBytes: integerArg("--content-bytes", 512),
  padMiB: integerArg("--pad-mib", 0),
};

const capability = await mintCapability(sessionKey);
const startedAt = performance.now();
const response = await fetch(`${endpoint.replace(/\/$/, "")}/run`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${capability}`,
    "Content-Type": "application/json",
    "X-Repro-Key": reproKey,
  },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(90_000),
});
const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 500) };
}
console.log(JSON.stringify({
  status: response.status,
  elapsedMs: +(performance.now() - startedAt).toFixed(1),
  input: { ...input, instance: "fresh" },
  body,
}, null, 2));
if (!response.ok || body.success !== true) process.exitCode = 1;

async function mintCapability(keyMaterial) {
  const key = createHash("sha256").update(keyMaterial).digest();
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({
    ...PRINCIPAL,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext));
  const cookie = `gw_sess=${Buffer.concat([iv, Buffer.from(ciphertext)]).toString("base64url")}`;

  const registered = await fetch(`${ISSUER}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const client = await registered.json();
  if (!registered.ok || typeof client.client_id !== "string") throw new Error(`registration failed: ${registered.status}`);

  const verifier = `cas-do-repro-${randomBytes(32).toString("base64url")}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${ISSUER}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: "cas:read cas:write cas:manage",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorizeUrl.searchParams.set(name, value);

  const consent = await fetch(authorizeUrl, { headers: { Cookie: cookie }, redirect: "manual" });
  const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await consent.text())?.[1];
  if (!consent.ok || !transactionId) throw new Error(`consent failed: ${consent.status}`);
  const decision = await fetch(`${ISSUER}/authorize/decision`, {
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
  if (!code) throw new Error(`authorization failed: ${decision.status}`);

  const tokenResponse = await fetch(`${ISSUER}/token`, {
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
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || typeof token.access_token !== "string") {
    throw new Error(`token exchange failed: ${tokenResponse.status}`);
  }
  return token.access_token;
}

function integerArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} requires a non-negative integer`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}