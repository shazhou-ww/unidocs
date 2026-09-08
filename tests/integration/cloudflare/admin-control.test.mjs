import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { COMPATIBILITY_DATE } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("real management DO shares Google login and persists authorized sessions without accepting public identities", async () => {
  const built = await build({ absWorkingDir: root, entryPoints: [join(root, "tests/integration/cloudflare/admin-control-worker.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2024", conditions: ["workerd", "worker", "browser"] });
  const markdown = await build({ absWorkingDir: root, entryPoints: [join(root, "tests/integration/cloudflare/admin-markdown-discovery-worker.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2024" });
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  let nonce = "";
  let email = "shazhou.ww@gmail.com";
  const issuer = "https://accounts.google.com";
  const origin = "https://app.test";
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.origin !== issuer) return new Response("Denied", { status: 403 });
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.pathname === "/jwks") return Response.json({ keys: [{ ...jwk, kid: "test-google", alg: "RS256", use: "sig" }] });
    if (url.pathname === "/token") {
      const token = await new SignJWT({ nonce, email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "test-google" }).setIssuer(issuer).setAudience("existing-google-client").setSubject(email).setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({ id_token: token });
    }
    return new Response("Unknown", { status: 404 });
  };
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-admin-control-"));
  const options = convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, resourcePersistencePath: persistPath, log: new Log(LogLevel.WARN),
    workers: [{
      name: "admin-control", modules: true, script: built.outputFiles[0].text, compatibilityDate: COMPATIBILITY_DATE,
      durableObjects: { CONTROL: { className: "UniDocsAdminControl", useSQLite: true } }, outboundService,
      serviceBindings: { ADMIN_MARKDOWN_SERVICE: "markdown-discovery" },
      bindings: {
        ADMIN_MARKDOWN_BASE_URL: "https://md.test/", ADMIN_MARKDOWN_SERVICE_ID: "md", ADMIN_MARKDOWN_STORAGE_IDENTITY: "test-storage", ADMIN_MARKDOWN_AUDIENCE: "md-audience",
        GATEWAY_PUBLIC_ORIGIN: origin, GATEWAY_OAUTH_ISSUER: `${origin}/oauth/unidocs-cloudflare`, GATEWAY_OIDC_ISSUER: issuer,
        GATEWAY_OIDC_CLIENT_ID: "existing-google-client", GATEWAY_SESSION_ENCRYPTION_KEY: "test-session-encryption-not-production", GATEWAY_OIDC_REDIRECT_PATH: "/oauth/unidocs-cloudflare/login/callback", UNIDOCS_ADMIN_BOOTSTRAP_EMAIL: email
      }
    }, {
      name: "markdown-discovery", modules: true, script: markdown.outputFiles[0].text, compatibilityDate: COMPATIBILITY_DATE,
      bindings: { DOC_SERVICE_ID: "md", DOC_STORAGE_IDENTITY: "test-storage", DOC_CAPABILITY_AUDIENCE: "md-audience" }
    }],
  });
  let runtime;
  const send = (path, init = {}) => runtime.dispatchFetch(`${origin}${path}`, { ...init, redirect: "manual" });
  const login = async () => {
    const redirect = await send("/admin/auth/login");
    const started = await runtime.dispatchFetch(redirect.headers.get("Location"), { redirect: "manual" });
    const upstream = new URL(started.headers.get("Location"));
    expect(upstream.searchParams.get("client_id")).toBe("existing-google-client");
    expect(upstream.searchParams.get("max_age")).toBeNull();
    expect(upstream.searchParams.get("prompt")).toBe("select_account");
    nonce = upstream.searchParams.get("nonce");
    const callback = `/oauth/unidocs-cloudflare/login/callback?code=test-code&state=${encodeURIComponent(upstream.searchParams.get("state"))}`;
    const cookie = started.headers.get("Set-Cookie").split(";")[0];
    expect((await send(callback)).status).toBe(400);
    const finished = await send(callback, { headers: { Cookie: cookie } });
    expect(finished.status).toBe(303);
    expect(finished.headers.get("Location")).toBe(`${origin}/admin/?google=complete`);
    expect((await send(callback, { headers: { Cookie: cookie } })).status).toBe(400);
    return finished.headers.get("Set-Cookie").split(";")[0];
  };
  try {
    runtime = new Miniflare(options); await runtime.ready;
    expect((await send("/admin/api/v1/administrators", { headers: { "X-Admin-Email": email, Authorization: "Bearer fake" } })).status).toBe(401);
    expect((await send("/admin/_test/bootstrap", { method: "POST", body: JSON.stringify({ email }) })).status).toBe(404);
    const googleCookie = await login();
    const exchange = await send("/admin/auth/session", { method: "POST", headers: { Cookie: googleCookie, Origin: origin, "X-UniDocs-Admin": "1" } });
    expect(exchange.status).toBe(201);
    const adminCookie = exchange.headers.get("Set-Cookie").split(";")[0];
    const cookie = `${googleCookie}; ${adminCookie}`;
    const session = await exchange.json();
    const authHeaders = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.data.csrfToken, "Content-Type": "application/json", "Idempotency-Key": "add-other" };
    const added = await send("/admin/api/v1/administrators", { method: "POST", headers: authHeaders, body: JSON.stringify({ email: "second@gmail.com" }) });
    expect(added.status).toBe(201);
    const target = (await added.json()).data;
    expect((await send("/admin/api/v1/document-types")).status).toBe(401);
    expect((await send("/admin/api/v1/audit-events")).status).toBe(401);
    const validate = await send("/admin/api/v1/url-validations", { method: "POST", headers: { ...authHeaders, "Idempotency-Key": "validate-md" }, body: JSON.stringify({ baseUrl: "https://md.test/" }) });
    expect(validate.status).toBe(200);
    const proof = (await validate.json()).data;
    const registerBody = JSON.stringify({ baseUrl: "https://md.test/", enabled: true, validationId: proof.validationId });
    const registered = await send("/admin/api/v1/document-types", { method: "POST", headers: { ...authHeaders, "Idempotency-Key": "register-md" }, body: registerBody });
    expect(registered.status).toBe(201);
    const registration = (await registered.json()).data;
    expect(registration).toMatchObject({ docType: "markdown", enabled: true, discovered: { capabilities: { preview: false, edit: false } } });
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    const list = await send("/admin/api/v1/administrators", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).items).toHaveLength(2);
    const types = await send("/admin/api/v1/document-types", { headers: { Cookie: cookie } });
    expect(await types.json()).toMatchObject({ items: [registration], consumption: "not-connected" });
    const headers = { ...authHeaders, "Idempotency-Key": "disable-md", "If-Match": registration.etag };
    const disabled = await send("/admin/api/v1/document-types/markdown", { method: "PATCH", headers, body: JSON.stringify({ enabled: false, reason: "target only" }) });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).data.enabled).toBe(false);
    const result = await send("/admin/api/v1/changes/disable-md", { headers: { Cookie: cookie } });
    expect((await result.json()).data.enabled).toBe(false);
    const audit = await send("/admin/api/v1/audit-events", { headers: { Cookie: cookie } });
    const events = (await audit.json()).items;
    expect(events.filter(entry => entry.action === "doctype.updated")).toHaveLength(1);
    expect(events[0]).toMatchObject({ before: { enabled: true }, after: { enabled: false }, reason: "target only" });
    const rejected = await send("/admin/api/v1/url-validations", { method: "POST", headers: { ...authHeaders, "Idempotency-Key": "unsafe" }, body: JSON.stringify({ baseUrl: "https://evil.test/" }) });
    expect(rejected.status).toBe(422);
    const removed = await send(`/admin/api/v1/administrators/${target.adminId}`, { method: "DELETE", headers: { ...authHeaders, "Idempotency-Key": "remove-other", "If-Match": target.etag } });
    expect(removed.status).toBe(204);
    expect((await send("/admin/api/v1/session/logout", { method: "POST", headers: authHeaders })).status).toBe(204);
    expect((await send("/admin/api/v1/session", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await send("/admin/auth/session", { method: "POST", headers: { Cookie: googleCookie, Origin: origin, "X-UniDocs-Admin": "1" } })).status).toBe(201);
    email = "outsider@gmail.com";
    const outsider = await login();
    expect((await send("/admin/auth/session", { method: "POST", headers: { Cookie: outsider, Origin: origin, "X-UniDocs-Admin": "1" } })).status).toBe(403);
  } finally { await runtime?.dispose(); await rm(persistPath, { recursive: true, force: true }); }
}, 60_000);