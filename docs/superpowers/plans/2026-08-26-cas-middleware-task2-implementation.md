# CAS Middleware Task 2 — Implementation Notes

> **Status:** In progress. Companion to `2026-08-26-cas-middleware.md` Task 2.
> Records the concrete interpretations and phasing decisions agreed with the
> operator before and during implementation. Supersedes nothing in the frozen
> `@unidocs/protocol-cas-admin` contract except the two explicit amendments
> below.

## Agreed decisions (2026-08-26)

1. **Session state:** server-side session rows in `CAS_CONTROL_DB`; the browser
   cookie holds only an opaque session id. Session payloads (Google ID token,
   OIDC state/PKCE verifier, CSRF token) are encrypted at rest with AES-GCM.
2. **Phasing:** Phase A = cloud-neutral `cas-control-plane` service library +
   `CAS_CONTROL_DB` schema/tests; Phase B = `cas-admin-webui` OIDC BFF/session/
   CSRF + BFF route handlers; Phase C = React admin console + local Miniflare
   runtime wiring with a local mock Google OIDC provider. Each phase lands with
   tests green.
3. **UI stack:** React (new monorepo dependency, confined to the private
   `cas-admin-webui` package) + Vite + TypeScript; SPA served under `/admin/`
   with **hash routing** so UI routes never collide with the frozen `/admin`
   API namespace.
4. **Tests:** no Playwright this phase. BFF handler-level tests with an
   in-process mock OIDC provider (jose-signed ID tokens); UI state coverage via
   jsdom + Testing Library component tests. Playwright is deferred to the
   deploy task (Task 9).
5. **Local runtime:** `cas-admin-webui` (with a mock OIDC provider worker and a
   control DB) is wired into `stacks/cloudflare/local` Miniflare in Phase C so
   the console can be exercised locally.
6. **Invitation flow:** the shared `acceptUrl` points at a BFF-served UI page
   `/admin/invitations/{token}`; unauthenticated visitors are routed through
   Google OIDC login first (state carries the token + return path). The page
   POSTs to the frozen `POST /admin/member-invitations/{token}/accept`.
7. **OIDC route surface (registered Google OAuth URIs):** the BFF uses
   `/admin/auth/login`, `/admin/auth/callback`, `/admin/auth/logout`; the
   redirect URI is `PUBLIC_ORIGIN + /admin/auth/callback`.
   - prod:  `https://unicas.shazhou.work/admin/auth/callback`
   - local: `http://localhost:4070/admin/auth/callback`
8. **Local dev ports:** Vite dev serves the console at `http://localhost:4070`
   and proxies `/admin/*` (except the shell and assets) to the admin BFF
   worker's direct socket `127.0.0.1:8792`; the mock OIDC provider listens on
   `127.0.0.1:8793`. When `GOOGLE_OIDC_CLIENT_ID`/`GOOGLE_OIDC_CLIENT_SECRET`
   env vars are set, the local runtime points the BFF at the real Google
   issuer instead of the mock provider. Real credentials are never committed;
   the local runtime defaults to mock client id/secret.

## Protocol amendments (Task 2, explicitly recorded)

Both amend `@unidocs/protocol-cas-admin` (Task 1 froze it); tests updated in
the same commit.

1. **`INVALID_REQUEST` error code** added to `CasAdminErrorCodes`, mapped to
   `400`. The frozen set had no general client-input error (only
   `INVALID_CURSOR`); invalid `refDomain`/`kid`/`displayName`, empty bodies,
   and bad limits now return `INVALID_REQUEST` instead of a semantically wrong
   existing code.
2. **`pending` removed from `CasIssuerKeyState`** (`active | retiring |
   revoked`). The frozen contract has no pending→active transition endpoint,
   so possession proof on `createIssuerKey` is the activation gate and keys
   enter `active` directly. `deleteIssuerKey` transitions `active → retiring`
   (default) or explicitly `→ revoked`.

## Frozen-contract interpretations (implementation decisions)

### Issuer and keys

- `PUT /admin/stacks/{id}/issuer` creates the singleton when absent (no
  `If-Match`, or `If-Match: *` — treated as create) and replaces it when
  present (`If-Match` required → `428` missing / `412` stale). The issuer value
  is globally unique: a second stack using the same `iss` returns
  `ISSUER_CONFLICT` (409). New/replaced issuers start `active`.
- `POST /admin/stacks/{id}/issuer/keys` requires the issuer to exist
  (`NOT_FOUND` otherwise) and a unique `kid` within the stack
  (`KEY_STATE_CONFLICT`). The key is stored `active` after possession proof
  verifies (see below).
- Retiring/revoking the **last active key** of a stack returns
  `KEY_STATE_CONFLICT` — an operator must create a replacement first; this
  keeps tenant verification operational during rotation.
- Supported key algorithms: `ES256`, `RS256`, `EdDSA`. `publicJwk` must be a
  public JWK (private material such as `d`/`p`/`q`/`k` rejected).
- **Proof of possession** is interactive: the BFF requests a challenge
  (`POST /admin/issuer/possession-challenge`, a BFF-level route, not in the
  frozen matcher) which stores a one-time nonce row in `CAS_CONTROL_DB`
  (10-minute TTL) bound to `(stackId, kid, algorithm)`. The operator signs the
  canonical challenge string `cas-possession-v1\n{nonce}\n{stackId}\n{kid}\n{alg}`
  with their private key; `possessionProof` is a compact JWS over that string.
  The service verifies the JWS with the submitted public JWK (WebCrypto:
  ECDSA P1363, RSA PKCS1v1.5, or Ed25519) and consumes the nonce atomically.

### refDomains

- Format: lowercase `[a-z][a-z0-9]*(:[a-z0-9]+)*`, length ≤ 64. Creation
  rejects the reserved `_`-prefix namespace (`_legacy` and anything starting
  with `_`) with `INVALID_REQUEST`.
- Duplicate create (same stack + same domain, non-retired) is **create-or-get**:
  the existing domain is returned. A duplicate create of a `retired` domain
  returns `DOMAIN_RETIRED` (409) — retirement is terminal.
- Transitions via `PATCH`: the frozen body type only permits
  `write_disabled` or `retired` targets, so the reachable transitions are
  `active → write_disabled`, `active → retired`, `write_disabled → retired`;
  any transition from `retired` returns `DOMAIN_RETIRED`. Re-activation
  (`write_disabled → active`) is not expressible in the frozen contract and is
  deferred.

### Members and invitations

- `DELETE /admin/stacks/{id}/members` requires `If-Match` on the **stack**
  revision (membership rows have no revision; the stack revision is the
  mutation precondition). Removing the final member returns `LAST_MEMBER`.
- Invitations: 24-hour expiry, optional normalized display-email constraint,
  token stored only as SHA-256 hash; `acceptUrl` returned once. Acceptance
  binds the invitee's immutable `(iss, sub)`; an expired/revoked/used token
  returns `NOT_FOUND` (one-time). An email-constrained invitation is rejected
  when the invitee has no email claim or it does not match (normalized).
- Accepting when already a member returns the existing membership.

### Lists, cursors, idempotency, audit

- Control-plane list endpoints use versioned keyset cursors bound to a
  **control-data snapshot revision** (`cas_control_meta.snapshot`, incremented
  in every mutation batch). A cursor whose snapshot revision no longer matches
  returns `INVALID_CURSOR` (400) and the client restarts from page one. Default
  `limit` 50, max 200 for control lists.
- `GET /admin/stacks/{id}/audit-events`: `after` (string) is interpreted as an
  exclusive `event_id` continuation; pagination is by `(created_at, event_id)`.
- Creation endpoints honor `Idempotency-Key` scoped to
  `(identity, method, canonical route)` with 24-hour retention; reuse with a
  different canonical payload returns `IDEMPOTENCY_CONFLICT`.
- Every mutation appends one immutable control-audit event in the **same D1
  batch** as the resource mutation. Session/auth events (login, failed login,
  logout) are also audited through the service. Audit rows are never updated or
  deleted by request-handling paths.

### Sessions and identity

- OIDC identity is `(iss, sub)`; email/name are display metadata upserted on
  every `me()`. New identities and changed display metadata are audited.
- `cas_admin_sessions` rows hold an AES-GCM-encrypted payload (id token + OIDC
  state + PKCE verifier + CSRF token), sliding expiry, last-seen tracking.
  Session key rotation is versioned via `SESSION_ENCRYPTION_KEYS` (JSON map of
  key id → base64 key); new sessions use the newest key, old keys decrypt until
  retired.
- Refresh-token retention defaults **off** (config flag); MVP sessions re-auth
  via Google when the ID-token-backed session TTL expires.

## Phase plan and status

- [x] Protocol amendments (`INVALID_REQUEST`, drop `pending`).
- [x] Phase A — `cas-control-plane`: schema/migrations, IDs/validation,
  possession challenges, service, session store, miniflare-backed tests.
- [x] Phase B — `cas-admin-webui` BFF: Google OIDC (authorization code + PKCE +
  nonce), encrypted sessions, CSRF/origin, frozen-route handlers, mock-OIDC
  tests.
- [x] Phase C — React console (hash router): My Stacks, stack detail, members +
  invitations + accept page, issuer + keys, ref domains, control audit, Root
  Ref audit empty state; jsdom component tests; local Miniflare wiring with a
  mock OIDC provider and real-Google env override.
- [ ] Phase D — full validation: package tests/typecheck across the four
  packages; local runtime smoke.

## Local development

Start the CAS middleware runtime (gateway + tenant CAS + admin BFF + mock
OIDC provider):

```text
pnpm dev
```

Then serve the console with Vite and open http://localhost:4070/admin/:

```text
pnpm --filter @unidocs/cas-admin-webui dev:ui
```

To exercise the real Google OIDC flow locally (registered redirect URI
`http://localhost:4070/admin/auth/callback`):

```text
GOOGLE_OIDC_CLIENT_ID=<client id> GOOGLE_OIDC_CLIENT_SECRET=<secret> pnpm dev
```

Without those env vars the runtime uses the local mock provider (any sign-in
becomes `local-operator@example.com`).

## Open notes

- Root Ref audit views (`listRootDomainRefs` / `listRootDomainEvents`) render
  against the frozen contracts; the tenant-side audit reader and D1 domain
  tables land in Tasks 5–7, so Phase C shows a documented "audit data not yet
  available" empty state behind the BFF route (the BFF returns
  `SERVICE_UNAVAILABLE`/empty until the audit-reader binding exists).
- A "usage" view is listed in Task 2's UI scope, but tenant usage
  (`cas:usage:read`) is a tenant-plane capability; the admin plane has no
  tenant credential. Phase C renders a documented not-available state; wiring
  tenant usage into the admin console is deferred until the tenant
  capability/authorization tasks (Task 4/8).
