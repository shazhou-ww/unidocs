/**
 * Local mock Google OIDC provider (dev only).
 *
 * Implements the authorization-code flow against a fixed local identity:
 * `/authorize` immediately redirects to the BFF callback with a code, and
 * `/token` returns a jose-signed id_token echoing the authorization request's
 * nonce. Discovery and JWKS are served for the configured issuer origin.
 *
 * This worker is bundled by the local runtime (see doc-types.mjs
 * `bundleTargets`); it never runs in production.
 */
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const pendingCodes = new Map();

let keyPairPromise = null;
function keyPair() {
  if (!keyPairPromise) keyPairPromise = generateKeyPair("RS256");
  return keyPairPromise;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
      });
    }

    if (url.pathname === "/jwks") {
      const { publicKey } = await keyPair();
      const jwk = await exportJWK(publicKey);
      return Response.json({
        keys: [{ ...jwk, kid: "local-mock", alg: "RS256", use: "sig" }],
      });
    }

    if (url.pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const sub = url.searchParams.get("sub") ?? "local-operator";
      if (!redirectUri || !state || !nonce) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const code = `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingCodes.set(code, { nonce, sub });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    }

    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code");
      const entry = pendingCodes.get(code);
      if (!entry || body.get("grant_type") !== "authorization_code") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      pendingCodes.delete(code);
      const { privateKey } = await keyPair();
      const idToken = await new SignJWT({
        iss: origin,
        sub: entry.sub,
        aud: body.get("client_id"),
        nonce: entry.nonce,
        email: `${entry.sub}@example.com`,
        name: "Local Operator",
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-mock" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: "mock-access" });
    }

    return new Response("Not Found", { status: 404 });
  },
};
