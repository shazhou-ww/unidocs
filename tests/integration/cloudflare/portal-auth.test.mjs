import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, test } from "vitest";
import { ADMIN_COOKIE, createAdminSession } from "../../../packages/cloudflare-portal/src/index.ts";

test("Portal JWT and cookie authentication execute in workerd", async () => {
  const now = 1_800_000_000;
  const origin = "https://portal.test";
  const audience = "portal-only-client";
  const identity = { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: now };
  const member = { memberId: "member", issuer: identity.issuer, subject: identity.subject, active: true };
  const issued = await createAdminSession(member, identity, now);
  const keys = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" }] };
  const token = await new SignJWT({ iss: identity.issuer, sub: identity.subject, email: identity.email, email_verified: true, aud: audience, iat: now, auth_time: now, exp: now + 600 })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
  const built = await build({
    stdin: {
      contents: `import { createAdminAuthenticator } from './packages/cloudflare-portal/src/index.ts';
        import { createLocalJWKSet } from 'jose';
        export default { async fetch(request, env) {
          const fixture = env.FIXTURE;
          const authenticate = createAdminAuthenticator({ origin: fixture.origin, audience: fixture.audience }, {
            now: () => fixture.now, keys: createLocalJWKSet(fixture.jwks),
            findSession: async hash => hash === fixture.session.sessionHash ? fixture.session : null,
            findMemberById: async () => fixture.member,
            findMemberByIdentity: async () => fixture.member,
          });
          try {
            const context = await authenticate(request);
            return Response.json({ memberId: context.memberId, transport: context.transport });
          } catch (error) {
            if (error.code === 'unauthorized' || error.code === 'forbidden') return new Response(error.code, { status: error.code === 'unauthorized' ? 401 : 403 });
            throw error;
          }
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    external: ["node:crypto"],
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-auth-spike",
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-08-18",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { FIXTURE: { now, origin, audience, jwks, member, session: issued.session } },
  }] }));
  try {
    const cookieHeaders = { cookie: `${ADMIN_COOKIE}=${issued.token}`, origin, "x-csrf-token": issued.csrfToken };
    const cookie = await miniflare.dispatchFetch(origin, { method: "POST", headers: cookieHeaders });
    expect(cookie.status).toBe(200);
    expect(await cookie.json()).toEqual({ memberId: "member", transport: "session" });
    const bearer = await miniflare.dispatchFetch(origin, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual({ memberId: "member", transport: "bearer" });
    expect((await miniflare.dispatchFetch(origin, { method: "POST", headers: { ...cookieHeaders, authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await miniflare.dispatchFetch(origin, { method: "POST", headers: { ...cookieHeaders, "x-csrf-token": "a".repeat(43) } })).status).toBe(403);
    expect((await miniflare.dispatchFetch(origin, { method: "POST", headers: { ...cookieHeaders, origin: "https://attacker.test" } })).status).toBe(403);
  } finally {
    await miniflare.dispose();
  }
});

test("Portal Google PKCE callback executes in workerd with Gateway client settings", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const fixture = { privateKey: await exportJWK(keys.privateKey), publicKey: await exportJWK(keys.publicKey) };
  const built = await build({
    stdin: {
      contents: `import { createPortalGoogleLogin, portalGoogleConfigFromGateway } from './packages/cloudflare-portal/src/index.ts';
        import { importJWK, SignJWT } from 'jose';
        export default { async fetch(request, env) {
          const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: 'gateway-client', GATEWAY_OIDC_CLIENT_SECRET: 'test-secret' }, 'https://portal.test');
          const now = Math.floor(Date.now() / 1000);
          const metadata = { issuer: config.issuer, authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
            code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'] };
          const transactions = new Map();
          let pending;
          let tokenRequests = 0;
          const login = createPortalGoogleLogin(config, {
            now: () => now,
            put: async transaction => { pending = transaction; transactions.set(transaction.stateHash, transaction); },
            take: async (stateHash, browserHash, time) => {
              const transaction = transactions.get(stateHash);
              if (!transaction || transaction.browserHash !== browserHash || transaction.expiresAt <= time) return null;
              transactions.delete(stateHash);
              return transaction;
            },
            fetch: async (input, init) => {
              if (init.redirect !== 'manual') throw new Error('Redirects must be disabled');
              const url = String(input);
              if (url.endsWith('openid-configuration')) return Response.json(metadata);
              if (url === metadata.jwks_uri) return Response.json({ keys: [{ ...env.FIXTURE.publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] });
              if (url !== metadata.token_endpoint) throw new Error('Unexpected endpoint');
              const body = new URLSearchParams(String(init.body));
              if (body.get('client_id') !== 'gateway-client' || body.get('code_verifier') !== pending.verifier || body.get('redirect_uri') !== (config.origin + '/admin/auth/callback')) throw new Error('Invalid code exchange');
              tokenRequests++;
              const key = await importJWK(env.FIXTURE.privateKey, 'RS256');
              const token = await new SignJWT({ iss: config.issuer, aud: config.clientId, sub: 'subject', email: 'admin@example.com', email_verified: true,
                auth_time: now, iat: now, exp: now + 600, nonce: pending.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
              return Response.json({ token_type: 'Bearer', access_token: 'discarded', id_token: token });
            },
          });
          const start = await login.begin(new Request('https://portal.test/admin/auth/login'));
          const authorization = new URL(start.headers.get('location'));
          const callback = new Request((config.origin + '/admin/auth/callback') + '?code=test&state=' + authorization.searchParams.get('state'), { headers: { cookie: start.headers.get('set-cookie').split(';')[0] } });
          const completed = await login.complete(callback);
          let replayRejected = false;
          try { await login.complete(callback); } catch (error) { replayRejected = error.code === 'unauthorized'; }
          return Response.json({ subject: completed.identity.subject, returnTo: completed.returnTo, replayRejected, tokenRequests });
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    external: ["node:crypto"],
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-google-login-spike",
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-08-18",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { FIXTURE: fixture },
  }] }));
  try {
    const response = await miniflare.dispatchFetch("https://portal.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: "subject", returnTo: "/admin/", replayRejected: true, tokenRequests: 1 });
  } finally {
    await miniflare.dispose();
  }
});