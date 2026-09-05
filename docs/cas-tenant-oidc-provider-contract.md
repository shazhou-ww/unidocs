# Unicas Tenant OIDC Provider Contract (draft)

Status: design skeleton v0.1 (2026-08). This is the contract stack
applications implement so the tenant debug tooling (`unicas-tenant`, and later
the WebUI) can log in and obtain tenant capabilities. The platform ships this
contract only — no reference provider in v1.

## Purpose

A stack's tenant issuer (registered on the control plane through Stack OAuth
discovery: `unicas oauth-issuer inspect/activate <stackId> <issuer>`) must act
as an **OAuth 2.0 authorization server** that:

1. serves RFC 8414 discovery at `{issuer}/.well-known/openid-configuration`;
2. accepts RFC 7591 dynamic client registration (public clients, no secrets);
3. authenticates tenant users on the stack's own login page and, on consent,
   issues a **capability JWT** (the CAS data-plane credential) as the access
   token.

The capability JWT is verified by the CAS verifier against the control-plane
authority registry (issuer → stack, keys) and by the tool against the stack's
`jwks_uri`. Both must agree on the signing keys.

## 1. Discovery (RFC 8414)

The stack must publish `{issuer}/.well-known/openid-configuration` with at
least:

```json
{
  "issuer": "<configured issuer>",
  "authorization_endpoint": "https://...",
  "token_endpoint": "https://...",
  "jwks_uri": "https://...",
  "registration_endpoint": "https://...",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["cas:read", "cas:write", "cas:manage"]
}
```

Notes:

- No `id_token` is issued or consumed; the access token **is** the capability.
  The `openid` scope is out of scope for this contract.
- The discovery document is read by the tool after the platform's public
  endpoint (`GET /stacks/{stackId}/.well-known/openid-configuration`) resolved
  `{ issuer, audience }` for the stack.

## 2. Dynamic client registration (RFC 7591)

The registration endpoint must accept arbitrary clients, **including our own
tooling** — there is no first-party whitelist and no pre-registered
`client_id`/`client_secret` anywhere in the platform or the tool.

The tool registers with:

```json
{
  "client_name": "unicas-tenant",
  "redirect_uris": ["http://127.0.0.1:<port>/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

- Loopback redirect URIs with arbitrary ports (RFC 8252 pattern; the CLI runs
  a local callback server).
- Public client: `token_endpoint_auth_method=none`, no `client_secret`.
- The registration response must return a `client_id`; the tool caches it per
  (stack, tenant) entry and reuses it across logins.

## 3. Authorization

- `response_type=code` with **PKCE** (`code_challenge_method=S256`); providers
  should reject authorization requests without a PKCE challenge.
- The tool requests `scope=cas:manage` (full permission, per requirements
  decision). The provider **may downgrade** the issued permissions based on
  the user's role (e.g. read-only users get `cas:read` only).
- **No tenant selector parameter.** The provider derives `tenantId` from the
  authenticated identity and must never trust a client-supplied tenant value.
  A user's account maps to the tenant the provider decides; other tenants of
  the same stack require a different account (logout → re-authorize).
- The user must authenticate on the stack's own login page and consent to
  granting the client the requested access.

## 4. Token endpoint

The access token is a capability JWT:

```jsonc
// protected header
{ "alg": "ES256", "kid": "<kid advertised at jwks_uri>", "typ": "unidocs-cap+jwt" }
// claims (per @unicas/tenant-protocol CapabilityClaims)
{
  "ver": 1, "iss": "<configured issuer>", "sub": "<opaque user identity>",
  "aud": "<configured audience>", "iat": ..., "nbf": ..., "exp": ...,
  "jti": "...", "tenantId": "<decided by provider>",
  "permissions": ["tenants:<tenantId>:cas:manage", "..."]
}
```

Contract rules:

- `iss` must equal the stack's configured issuer; `aud` must equal the
  configured audience.
- `tenantId` and `permissions` are decided by the provider from the
  authenticated identity and role; permissions use the canonical
  `tenants:{tenantId}:cas:{read|write|manage}` vocabulary.
- Lifetime must not exceed the stack authority's
  `capabilityMaxLifetimeSeconds` (server policy for discovered Stack OAuth
  issuers, 30 minutes); the CAS verifier rejects over-lifetime tokens.
- Capabilities that write Root Refs must carry a valid `refDomain` claim
  (see `validateRefDomainClaim` in tenant-protocol); whether a user receives
  one is the provider's decision.
- `refresh_token` is optional. If issued, `grant_type=refresh_token` returns a
  new capability JWT; the default policy is one-time rotation and a refresh
  token lifetime of at most 7 days. Providers may customize, but must declare
  the policy (discovery metadata and/or docs).

## 5. JWKS

`jwks_uri` is the **single source of signing keys**. UniCAS records the URI
from verified issuer discovery and the CAS verifier fetches keys from it,
with remote caching and refresh on authority-cache expiry or an unknown `kid`.
The provider must therefore rotate keys with overlap — publish the new key
alongside the old one, then remove the old key only after cached verifiers have
refreshed. Keys removed from a successful refresh stop validating immediately.
There is no separate manual or copied active-key registry.

## 6. Error semantics

- Standard OAuth error responses (`invalid_client`, `access_denied`,
  `invalid_grant`, `unauthorized_client`, …).
- The tool maps them to CLI errors (exit code 1) with a stable code; "not
  logged in / no active entry" stays exit code 2.
- Capability verification failures use the `CapabilityErrorCode` vocabulary
  from tenant-protocol (`invalid_token`, `missing_token`,
  `insufficient_permission`, `resource_scope_mismatch`, `unknown_issuer`,
  `registry_unavailable`, `unsupported_algorithm`).

## 7. Implementation checklist

- [ ] Serve `{issuer}/.well-known/openid-configuration` with all fields above.
- [ ] Accept RFC 7591 registration; return `client_id` for public clients.
- [ ] Authorization endpoint: PKCE required, `scope=cas:manage` honored or
      downgraded, tenant decided from identity, consent screen.
- [ ] Token endpoint: issue capability JWTs signed with a key advertised at
  `jwks_uri` (`kid` + ES256), `iss`/`aud` matching configuration,
      lifetime ≤ cap.
- [ ] Publish every active capability signing key at `jwks_uri`.
- [ ] Optional: refresh grant with one-time rotation, declared policy.
