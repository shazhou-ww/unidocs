// Measure production create latency for docx vs markdown (temp tool).
import { createHash, randomBytes } from 'node:crypto';

const GATEWAY = 'https://unidocs.shazhou.work';
const ISSUER_BASE = GATEWAY + '/oauth/unidocs-cloudflare';
const REDIRECT_URI = GATEWAY + '/ui/callback';
const SESSION_KEY = 'AalKCUybiXoCtq17b4TZENkOMEG5LBnTIIL/TwIZ1dU=';

const b64u = (b) => Buffer.from(b).toString('base64url');

async function sealSession() {
  const key = createHash('sha256').update(SESSION_KEY).digest();
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({
    sub: '102681972452057176712',
    name: 'Scott Wei',
    email: 'shazhou.ww@gmail.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cipher = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cipher, payload));
  return b64u(Buffer.concat([iv, Buffer.from(ct)]));
}

const cookie = 'gw_sess=' + await sealSession();

// RFC 7591 dynamic client registration (no auth).
const reg = await fetch(ISSUER_BASE + '/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
});
const client = await reg.json();

// PKCE S256.
const verifier = 'latency-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
const challenge = b64u(createHash('sha256').update(verifier).digest());
const au = new URL(ISSUER_BASE + '/authorize');
for (const [k, v] of Object.entries({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: REDIRECT_URI,
  scope: 'cas:read cas:write cas:manage',
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) au.searchParams.set(k, v);

// Consent flow.
const consent = await fetch(au, { headers: { Cookie: cookie }, redirect: 'manual' });
const m = /name="transaction_id" value="([^"]+)"/.exec(await consent.text());
const tid = m?.[1];
if (!tid) throw new Error('no transaction_id in consent page');
const decision = await fetch(ISSUER_BASE + '/authorize/decision', {
  method: 'POST',
  redirect: 'manual',
  headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ transaction_id: tid, decision: 'approve' }),
});
const code = new URL(decision.headers.get('Location')).searchParams.get('code');

// Exchange.
const tok = await fetch(ISSUER_BASE + '/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: client.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: verifier,
  }),
});
const token = (await tok.json()).access_token;
const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

for (const type of ['docx', 'markdown']) {
  const t = Date.now();
  const r = await fetch(GATEWAY + '/tenants/shazhou-ww/docs/' + type + '/', {
    method: 'POST', headers: auth, body: '{}',
  });
  console.log(type, 'create:', r.status, 'in', (Date.now() - t) + 'ms', (await r.text()).slice(0, 100));
}
