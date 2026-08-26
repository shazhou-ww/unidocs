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

## Task 3 execution notes (operator-approved approach)

The canonical `@unidocs/protocol-cas` is frozen to the stack-scoped protocol
(`/stacks/{stackId}/tenants/{tenantId}/...`, `updateRootRefs`, no
assignment/portable contracts, no `isPublicCasRoute`). The pre-stack tenant
surface is quarantined verbatim in the migration-only
`@unidocs/protocol-cas-legacy` package; the legacy runtime packages
(cloudflare-cas, cas-client, cloudflare-gateway, azure-gateway, gateway-common,
protocol-gateway) changed only their import sources (and the Gateway exposure
policy moved to Gateway-owned `isGatewayExposedCasRoute` in
`@unidocs/protocol-gateway`, injected by `gateway-handler`). The new
`@unidocs/cas-server-cloudflare` package hosts the canonical stack protocol
skeleton (501 handlers until Tasks 4–7). The old runtime + local dev + Azure
keep working unchanged during the compatibility window.

## Task 4 execution notes

The canonical stack authorization lands on `cas-server-cloudflare` (per the
Option A structure). `service-auth` gains `cas:usage:read`/`cas:gc:trigger`
(`cas:admin` retained only as the legacy runtime's credential until Task 10),
an optional validated `refDomain` claim (issuer signs after format checks;
verifier validates), and new auth error codes. `cas-control-plane` exposes the
read-only `AuthorityRepository` (issuer → stack/audience/keys, registered
domains). `StackCapabilityVerifier` enforces the exact operation permission
matrix, issuer-derived stack equality, token tenant equality, registered
active refDomains for Root Refs writes (token-only attribution; reserved
domains rejected), opaque `sub`, a 30s cache / 60s hard stale bound /
fail-closed policy with telemetry, and a static legacy-stack bootstrap.
Storage/DO dispatch is Task 5/6; the gateway's legacy `cas:admin` issuance
and per-doc-type refDomain wiring migrate with stack onboarding (Task 9).

## Task 5 execution notes

The stack-scoped tenant storage lands in `cas-server-cloudflare` as its fresh
target schema: `cas_nodes`/`cas_edges` keyed by `(stack_id, tenant_id, ...)`,
domain-scoped idempotency `(stack_id, tenant_id, ref_domain, request_id)` with
payload_hash/revision, the audit tables (`cas_root_domain_events`,
`cas_root_domain_refs`, `cas_root_domain_revisions`), and the durable
schema/cutover record (`cas_schema_meta`) + R2 manifest
(`cas_r2_migration_manifest`). DO names use `canonicalComposite(stackId,
component)` (unambiguous URL-encoded pairs); R2 keys use
`stacks/{stackId}/tenants/{tenantId}/nodes/{hash}`. The reserved `_legacy`
baseline importer writes deterministic events/balances without touching
aggregates and reruns idempotently; the R2 migration job is manifest-driven,
copy-only, resumable, size+digest verified, with post-contract deletion gated
on a complete manifest; the stackless fallback is legacy-stack-only and
non-contracted. The old runtime's schema/owner tables are untouched (Option A).

## Task 6 execution notes

The atomic Root Refs write lands in `cas-server-cloudflare`: the tenant CAS DO
(per `(stackId, tenantId)` command queue) canonicalizes the caller update
(dup-key rejection on the raw text, hash-sorted payload) and forwards ONE
canonical command to the `RootRefDomainDurableObject` (per
`(stackId, refDomain)`); the domain DO executes the atomic D1 batch —
domain-scoped idempotency, optimistic revision allocation (CAS on the current
revision), aggregate `cas_nodes.root_ref_count` updates, one event append,
projection update (negative balances kept, zero rows removed), idempotency
insert — and retries only retryable conflicts/transients with bounded
exponential backoff. Validation reads only `cas_nodes` (never audit tables);
the worker forwards the VERIFIED stack/tenant/refDomain (never caller
headers). The remaining node operations (read, lease, usage, GC) return 501
until their storage dispatch follow-on.

## Task 7 execution notes

The stack-domain audit reads land in `cas-server-cloudflare`:
`listRootDomainRefs` (keyset `(tenantId, hash)` pages with revision-before/
query/after guards; first pages retry on revision movement, cursor pages fail
`ROOT_REF_SNAPSHOT_CHANGED`; versioned opaque cursors bound to revision,
domain, and tenant filter; positive and negative balances returned) and
`listRootDomainEvents` (revision-ordered, exclusive `after`, optional tenant
filter, consistently-read `latestRevision`, `nextAfter` advancing empty
filtered pages to the stack-domain watermark). A narrow private reader RPC
(`/_internal/audit/refs`, `/_internal/audit/events`) guarded by a shared
`CAS_AUDIT_READER_KEY` is served by the tenant worker; cas-edge never
dispatches `/_internal`. `cas-admin-webui` now enforces stack membership via
`getStack`, validates the operator-selected refDomain (reserved `_legacy`
readable), and forwards to the reader binding (503 until the binding is wired
at deployment).

## Task 8 execution notes

`CasClient.assignRoots()` is removed; the SValue editor (`cloudflare-sdk`
`editor-do-svalue.ts`) now emits explicit `updateRootRefs` deltas. The retained
set is the **current** delta plus, when present, the **current** snapshot —
computed by `rootTransitionChanges(previous, next)` in
`packages/cloudflare-sdk/src/root-transition.ts` (unit-tested). Zero-sum
entries are dropped, so re-settling an already-retained hash yields an empty
map and the CAS call is skipped (the legacy handler rejects empty change sets;
the canonical handler rejects zero deltas).

Durable row transitions (durable tables `svalue_deltas` / `svalue_snapshots`,
previous roots = `SELECT root_hash ... ORDER BY version DESC LIMIT 1`):

- **Commit** (`#settlePending`, requestId `session:{sid}:version:{N}:roots`):
  INSERT delta row; INSERT snapshot row when the pending version snapshots.
  CAS changes: `{newDelta: +1, prevDelta: -1}` when hashes differ, plus
  `{newSnapshot: +1, prevSnapshot: -1}` when a snapshot is being settled and
  the previous snapshot differs. Snapshot-less versions leave the previous
  snapshot retained.
- **Pending recovery** (same path on the next request with write authority,
  or on restart): the pending row's version is still the newest durable row,
  so `previous == next` except for the CAS rows the failed write never
  recorded — re-running settle completes exactly the missing half. A response
  lost after CAS commit but before the durable rows yields `previous == next`
  for every hash → empty changes → no CAS call, no double count. The
  deterministic requestId makes the legacy `cas_root_ref_requests`
  idempotency a second layer.
- **Snapshot repair** (`#ensureCurrentSnapshot`, requestId
  `session:{sid}:snapshot:{V}:ensure`): INSERT snapshot row for the current
  version; CAS changes `{snapshotHash: +1}` — additive, never releases.
- **Rollback** is a normal commit of a `restore` delta with `forceSnapshot`,
  so it settles through the commit transition above.

Future callers of the editor DO may add truncate (release all-but-current
roots) and session deletion (release every root) paths; both are just larger
`changes` maps with the same zero-delta rejection rules. Recovery requires
write authority — a read-only capability cannot settle a pending outbox, so
recovery is driven by the next write request (or the gateway's own restore
path), not by queries.

Rollback semantics on root failure are unchanged: `#commit` rethrows
`CasClientError` and the pending row survives for the next write request;
`doctype-server-common` keeps `commitRootRefsOrRollback` (its
`session.test.ts` covers updateRootRefs-failure rollback; `cas-rollback`
integration covers the end-to-end 502 → retry-409 recovery).

## Task 9 execution notes (round 1: canonical storage + client surface)

The tenant CAS runtime is now a complete storage server, not just Root Refs:
`packages/cas-server-cloudflare/src/nodes.ts` implements stack-scoped
lease/read/metadata/usage/GC against `cas_nodes`/`cas_edges`/R2, every row and
object keyed by `(stackId, tenantId)` (R2 keys via `stackNodeKey`). The tenant
DO dispatches `/leaseNode`, `/leaseExisting`, `/read`, `/metadata`, `/usage`,
`/gc` in addition to `/updateRootRefs`, keeping the per-tenant serialization
boundary (a lease claim can never race a GC deletion decision). The worker
forwards each verified node op to the DO with the VERIFIED stack/tenant
context — caller-supplied identity headers are never forwarded; only
content-metadata headers (Content-Type, `X-CAS-Refs`, `X-CAS-Lease-Duration`)
and the content body pass through. Lease validation mirrors the legacy
content-addressed kernel: hash format, content length, SValue child-ref
agreement, digest equality, immutable metadata on re-lease, and
children-ready-before-parent.

`CasClient` gains the canonical stack surface: `stackId` config variants
(public `{baseUrl, stackId, tenantId}` and capability `{fetcher, stackId,
tenantId, sessionId, capability}`); every node op routes to
`/stacks/{stackId}/tenants/{tenantId}/...` when `stackId` is present and keeps
the legacy tenant-scoped routes otherwise. `updateRootRefs` returns the typed
`{success, idempotent, revision}` response from the canonical
`/stacks/{stackId}/tenants/{tenantId}/root-refs` route. `doctype-server-common`
`CasGateway`/`MemoryCasGateway` and `cas-client` `CasRootRefGateway` were
widened to the richer return type so all structural implementers line up.

Isolation is asserted at the unit level: the tenant-DO suite proves a shared
textual tenant id across two stacks sees no node, no usage, and no GC
cross-talk. Plan Task 8 bullet 1 and Task 9 bullet 3/10 updated; remaining
Task 9 rounds wire `cas-edge` dispatch, register the two stacks in the local
runtime, and run the end-to-end two-stack integration.

## Task 9 execution notes (round 2: edge dispatch + local middleware wiring)

`cas-edge` is now a real front door: `/stacks/...` forwards to the private
canonical tenant worker (stripping `Cookie`, `X-Internal-Token`, and the
audit-reader key), `/admin/...` forwards to the admin BFF (stripping tenant
`Authorization`), `/health` is the edge readiness probe, and everything else
404s — the private `/_internal/audit/*` and `/_internal/health` probes are
never reachable through the public path. Readiness: edge `GET /health`;
tenant worker `GET /_internal/health`; admin BFF `GET /_internal/health`.

The local runtime wires the middleware with `casMiddleware: true`:
`unidocs-cas-middleware` (canonical tenant worker with its own stack-scoped
`CAS_MIDDLEWARE_DB`/bucket, `CAS_DO` + `CAS_DOMAIN_DO`, `CAS_AUDIT_READER_KEY`)
and `unidocs-cas-edge` (the only public socket, port 8794) with
`CAS_TENANT_SERVICE` → middleware and `CAS_ADMIN_SERVICE` → admin BFF. The
admin BFF gains the private `CAS_TENANT_AUDIT_READER` binding (edge → admin →
tenant; acyclic). `seedMiddlewareStacks` migrates `CAS_CONTROL_DB` and
registers the two stacks (issuer + rotation key + refDomains); callers keep
the private keys and issue stack capabilities with service-auth.

`middleware-e2e.test.mjs` drives the full canonical flow through the edge —
lease → read → metadata → updateRootRefs (typed revision + idempotent retry)
→ usage → GC — plus edge isolation, readiness, admin forwarding, and the
cross-stack proof: identical textual tenant ids in `unidocs-cloudflare` and
`unidocs-azure` share no nodes, refs, usage, or GC; cross-stack tokens are
403. The worker module drops all non-handler named exports (workerd
constraint); constants stay in their home modules.

## Task 9 execution notes (round 3: deployment)

The middleware is deployed to Cloudflare (account `92c3c4fd...`,
zone `shazhou.work`): `unidocs-cas-server-cloudflare` and
`unidocs-cas-admin-webui` are live with `workers_dev = false` (private;
reached only through cas-edge service bindings), and `unidocs-cas-edge`
carries the `unicas.shazhou.work` route with the two service bindings.
Infrastructure: D1 `unidocs-cas-control` (dc8090eb…) + `unidocs-cas-db`
(66f8738b…), R2 `unidocs-cas` (+ preview bucket); schemas applied via
`wrangler d1 execute`. Secrets set via `wrangler secret put`: tenant
`CAS_AUDIT_READER_KEY`; admin real Google OIDC client id/secret and a fresh
`SESSION_ENCRYPTION_KEYS` map.

`scripts/provision-cas-middleware.mjs` bootstraps the two stacks into the
production CAS_CONTROL_DB (issuer + ES256 rotation key + active refDomains);
private keys stay under gitignored `.wrangler/cas-deploy/`. The deployed
tenant worker already authorizes the provisioned cloudflare-stack
capabilities (verified end-to-end against production D1/R2 through a
`wrangler dev --remote` tunnel — `cas_stack_authorization authorized
leaseNode` with the seeded key; DO dispatch is not exercisable through
remote dev, which is a wrangler limitation, not a worker one).
`scripts/cas-middleware-smoke.mjs` runs the full canonical flow against any
base URL.

Blocked: the `unicas.shazhou.work` DNS record (custom-domain and manual
CNAME) is created in the zone but the authoritative nameservers are not
serving it yet — Cloudflare-side propagation; the final live-edge smoke and
the admin-console onboarding depend on it.

Resolved: DNS propagated (~10 min) after switching the edge to a classic
`unicas.shazhou.work/*` route plus a proxied CNAME to
`unidocs-cas-edge.shazhou.workers.dev` (the auto custom-domain AAAA 100::
record was stuck). The LIVE smoke now passes end-to-end over HTTPS: edge
/health 200 and /_internal/health 404, lease/read/metadata/root-refs
(revision 1, idempotent retry)/usage/GC, cross-stack read 403, azure usage 0
under the same tenant id, and /admin 302/401 through the edge to the BFF.

## Task 9 execution notes (round 4: Cloudflare stack-mode migration)

`internalAuthMode: "stack"` is a new local-runtime mode (legacy/dual/
capability stay intact for the compatibility window):

- `GatewayCapabilityAuthority` signs delegated-cas and gateway-cas
  capabilities with a separate `casIssuer` (the registered stack identity)
  carrying `casStackId` + `casRefDomain`; the doc capability keeps the
  doc-service issuer.
- The gateway handler forwards public CAS routes to canonical
  `/stacks/{stackId}/tenants/{tenantId}/cas/...` paths in stack mode.
- Doc workers verify the delegated capability against the stack issuer/JWKS
  (new `CAS_STACK_ISSUER`/`CAS_STACK_TRUSTED_JWKS` bindings) and the editor DO
  adds `CAS_STACK_ID` to its CasClient, routing every CAS call to the
  middleware worker.
- The runtime wires CAS_SERVICE → `unidocs-cas-middleware`, seeds
  `unidocs-cloudflare` (issuer/keys/refDomains identical to the gateway's
  signing key) into the local CAS_CONTROL_DB, and exposes
  `startLocalMiddleware({stacks, ports})` for the dev command and the Azure
  round.

`stack-mode.test.mjs` proves the whole markdown doc flow (create → apply →
query → history → rollback) through the middleware with stack-authorization
events for lease/leaseExisting/updateRootRefs, and asserts the middleware
retains exactly the current delta + snapshot. Fixes along the way:
`validateConfig` accepted "stack" (it previously threw "mode must be
explicit" → the doc worker 500'd).

## Task 9 execution notes (round 5: Azure stack-mode migration)

`startAzureRuntime({ internalAuthMode: "stack" })` embeds the local CAS
middleware via `startLocalMiddleware` (registered `unidocs-azure`, ports
37791-37793 + edge 36894 so it coexists with a running `pnpm dev`), and
passes the middleware edge URL as `CAS_BASE_URL` plus the azure stack
identity (`CAS_STACK_ID/ISSUER/KEY_ID/PRIVATE_KEY_PKCS8/REF_DOMAIN`) to the
azure gateway and services. The azure gateway builds the stack `casIssuer`
and `casStackId`; the azure doc services' CasClient carries `stackId` and
routes canonical `/stacks/unidocs-azure/tenants/{tenant}/...` to the
middleware — the transitional cf legacy-CAS/shared-key wiring is gone from
the azure tests.

Validation (all green): `azure-docx-image` now runs in stack mode — image
upload through the azure gateway's canonical CAS route, apply's
leaseOpRefs/commitRootRefsOrRollback through the middleware, and the
middleware retains the blob root under `unidocs-azure`; `azure-stack-mode`
proves the markdown flow plus a direct edge capability probe (and that
blob-less markdown legitimately writes no CAS roots). Full azure suite: 6
files / 29 tests. Environment fixes along the way: azure `run()` spawns
pnpm via shell on Windows (.cmd shim), and the cf-runtime default
admin/cas/mockOidc ports in the cf + azure integration tests got explicit
overrides so the suites run alongside the user's `pnpm dev`.

## Task 9 execution notes (round 6: stack mode is the default)

`startLocalRuntime` now defaults to `internalAuthMode: "stack"` — the
Cloudflare application stack runs on the canonical middleware by default,
with legacy/dual/capability kept as explicit opt-ins for the compatibility
window. The storage probe's `blobExists` checks the middleware bucket in
stack mode; the fault worker wraps the middleware and recognizes the
canonical `/stacks/.../root-refs` route (Task 8 bullet 9); `seedMiddlewareStacks`
upserts the stack issuer on conflict so a persisted-DB restart with a fresh
ephemeral fixture re-registers correctly (fixes the DOCX restart 401).

The legacy worker emits `cas_legacy_surface` telemetry (sharedKey /
rootAssignments / portableNode) for the compatibility-phase decision
(Task 9 bullet 11). Fixes along the way: the gateway's capability authority
is env-keyed (a bare module cache leaked across Miniflare runtimes in one
process), the stack-mode gateway-cas capability uses the stack-scoped
permission names (cas:usage / cas:gc) instead of the retired cas:admin, and
lease immutability is checked before the digest so re-leasing a ready node
returns 409 like the legacy runtime. `azure-psd` also migrated to stack mode
(no cf legacy CAS dependency). Validation: test:local 396, test:azure 29,
pnpm test, typecheck, and the dependency guard all green.

## Task 9 execution notes (round 7: app-stack handoff + rollback drill)

The four application-stack `wrangler.toml` files (cloudflare-gateway,
cloudflare-markdown, cloudflare-docx, cloudflare-psd) are rewritten to stack
mode with real production values: `INTERNAL_AUTH_MODE="stack"`,
`CAS_STACK_ID="unidocs-cloudflare"`, `CAS_STACK_ISSUER`
(`https://unicas.shazhou.work/cas/issuer/cloudflare`), `CAS_CAPABILITY_AUDIENCE`
(`unidocs-cas-cloudflare`), `CAS_SERVICE` → `unidocs-cas-server-cloudflare`,
plus `[exports.*]` durable-object declarations. The legacy
`[durable_objects]` bindings + `[[migrations]]` blocks were removed from the
doc workers — wrangler rejects `migrations` and `exports` together
("mutually exclusive"), and with `[exports.*]` the DO lifecycle is declared
by export alone. All four parse: `wrangler deploy --dry-run` exits cleanly
(the gateway first, then the three doc workers).

**App-stack deployment runbook (handed off — OUT OF SCOPE here):** how the
full UniDocs application stack is organized is a separate plan; this CAS
plan covers only the middleware itself plus the local stack-mode migration.
The tomls are the hand-off artifact (parse-verified, never deployed — the
app stack shows "This Worker does not exist"), and the runbook below is
carried into the application-stack plan. Note the gateway currently has only
`createInsecureTenantIdentityResolver`, so a deployed gateway has no
production identity/auth mechanism and 401s every request — application
identity auth must land before any app-stack deploy (the capability
authority must verify doc-service identity JWTs per `CAPABILITY_ISSUER` /
`CAPABILITY_TRUSTED_JWKS`). When unblocked, deploy order is doc workers
first, gateway last (the gateway depends on the registered stack and the doc
workers' identity keys); secrets to set via `wrangler secret put` before
each deploy:

- doc workers: `CAPABILITY_ISSUER`, `CAPABILITY_TRUSTED_JWKS` (doc-service
  identity), `CAS_STACK_TRUSTED_JWKS` (the `unidocs-cloudflare` stack public
  JWKS), `SERVICE_ACCESS_KEY` (legacy fallback, unused in stack mode).
- gateway: `CAS_STACK_PRIVATE_KEY_PKCS8` (the `cf-rotate-1` stack signing
  key — the private half lives in `.wrangler/cas-deploy/`, gitignored),
  `DOC_SERVICES_JSON` (doc-service identity credentials).

The deployed middleware's private keys are provisional bootstrap keys —
rotate them via the possession-proof console once identity auth exists.

**Rollback drill (verified live, 2026-08-26):** `wrangler deployments list`
on the admin worker showed a single 100% version (`aac4ce3f`); `wrangler
rollback` from `packages/cas-admin-webui` moved traffic to the retained prior
version `8dd1baee`, `GET https://unicas.shazhou.work/admin/me` still answered
401 (correct unauthenticated BFF response through the edge), and `wrangler
deploy` restored the current version (`7e7668b9`, 100%). Retained prior
versions + forward/backward rollback on the deployed middleware are proven.

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
- [x] Phase D — full validation: typecheck + unit suites across
  `protocol-cas-admin` (36), `cas-control-plane` (36 incl. JWKS assembly),
  `cas-admin-webui` (33), workspace dependency guard (150), local runtime
  smoke (standalone + full stack + Vite proxy chain). Playwright remains
  deferred to Task 9 per decision.

## Local development

The CAS middleware runs standalone (no gateway / doc type workers) — the
independent-deployment boundary. **One command** starts the backend (tenant
CAS 8791 + admin BFF 8792 + mock OIDC 8793) and spawns the console frontend
(Vite dev on 4070):

```text
pnpm dev:cas-admin                    # -> http://localhost:4070/admin/
```

`pnpm dev` (full UniDocs stack) also includes the admin BFF, mock OIDC, and
the console — but the middleware itself does not depend on the application
stack. Either frontend can also be started separately:

```text
pnpm --filter @unidocs/cas-admin-webui dev:ui
```

With the local mock OIDC provider, **no Google configuration is needed**: no
client id/secret and no registered redirect URI (the mock provider accepts
any redirect_uri). The Google-console redirect URI
`http://localhost:4070/admin/auth/callback` only applies when running against
the real Google issuer locally:

```text
GOOGLE_OIDC_CLIENT_ID=<client id> GOOGLE_OIDC_CLIENT_SECRET=<secret> pnpm dev:cas-admin
```

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
