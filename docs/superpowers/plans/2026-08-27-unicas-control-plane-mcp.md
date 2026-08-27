# Unicas Control-Plane MCP Implementation Plan

> **Status:** IN PROGRESS as of 2026-08-27.
>
> **For agentic workers:** Implement one task at a time and keep the checkboxes
> current. Do not expose a generic control-plane HTTP proxy as an MCP tool. Keep
> tenant capability authentication, browser admin sessions, and MCP OAuth tokens
> as separate trust domains. Every tool must call `ControlPlaneService` or the
> existing narrow audit-reader boundary; no tool may issue SQL directly.

**Goal:** Add an OAuth-protected remote MCP server to the Unicas control plane so
GitHub Copilot and other conforming MCP clients can inspect and operate the CAS
control plane without storing API keys in client configuration.

**User story:** As a Unicas stack administrator, I can configure one HTTPS MCP
URL in GitHub Copilot, sign in with the same Google identity used by CAS Admin,
review and grant explicit control-plane scopes, and invoke narrowly defined
operational tools. My existing stack memberships remain authoritative and every
operation remains attributable in the control audit log.

**Architecture:** Add a private `@unicas/control-plane-mcp` Cloudflare Worker
behind `cas-edge`. It serves a stateless MCP Streamable HTTP endpoint at `/mcp`
and acts as both OAuth resource server and authorization server by using
`@cloudflare/workers-oauth-provider`. Google OIDC authenticates the human during
authorization; the Worker then issues its own short-lived, audience-bound MCP
access and rotating refresh tokens. Tool handlers derive the existing immutable
`(identityIssuer, subject)` operator identity from encrypted OAuth grant props,
enforce OAuth scope, and delegate business authorization and mutations to
`ControlPlaneService`.

```text
GitHub Copilot / MCP client
  |  Streamable HTTP + Unicas OAuth bearer token
  v
cas-edge
  |-- /stacks/...  -> tenant CAS Worker
  |-- /admin/...   -> admin WebUI/BFF (OIDC session cookie)
  `-- /mcp + OAuth discovery/endpoints
                     -> control-plane-mcp Worker
                          |-- OAuth KV (clients, grants, token hashes)
                          |-- CAS_CONTROL_DB via ControlPlaneService
                          `-- private tenant audit-reader RPC

Google OIDC authenticates the user only during authorization. Google tokens
are never accepted at /mcp, returned to the MCP client, or forwarded downstream.
```

**Tech Stack:** TypeScript, pnpm workspace, Cloudflare Workers, D1, KV, Google
OIDC, OAuth 2.1, MCP Streamable HTTP, Vitest. Initial dependency baselines are
`@cloudflare/workers-oauth-provider@0.10.3`, `agents@0.21.0`, and
`@modelcontextprotocol/sdk@1.30.0`; implementation must lock tested versions in
`pnpm-lock.yaml` rather than depending on floating versions.

## Success criteria

A fresh GitHub Copilot configuration contains no secret:

```json
{
  "servers": {
    "unicas-control-plane": {
      "type": "http",
      "url": "https://unicas.shazhou.work/mcp"
    }
  }
}
```

The work is complete when:

- an unauthenticated `/mcp` request returns `401` with an RFC 9728
  `WWW-Authenticate` resource-metadata challenge;
- a compatible client discovers the authorization server, completes S256 PKCE,
  opens Google sign-in and an Unicas consent page, and receives only an Unicas
  access token bound to the canonical `/mcp` resource;
- the authenticated MCP identity resolves to the same `(iss, sub)` operator
  identity and stack memberships as the admin WebUI;
- `control:read`, `control:write`, and `control:security` are separately
  consented and enforced at each tool handler;
- cross-stack access, removed membership, missing scope, wrong audience,
  expired/revoked tokens, stale ETags, and untrusted browser origins fail closed;
- every successful mutation has an existing control-audit event plus MCP
  channel/client/tool attribution, without storing access tokens or invitation
  secrets in logs;
- package, edge-boundary, OAuth, MCP transport, and GHC smoke tests pass; and
- operators have deployment, token-revocation, key/secret rotation, and incident
  response instructions.

## Scope

This work item covers:

- a new private control-plane MCP Worker and its Cloudflare configuration;
- stateless MCP Streamable HTTP transport at the canonical `/mcp` resource;
- OAuth protected-resource and authorization-server discovery;
- authorization-code flow with S256 PKCE, exact redirects, resource indicators,
  consent, short-lived access tokens, rotating refresh tokens, and revocation;
- Client ID Metadata Documents (CIMD), with DCR retained as a compatibility
  fallback for clients that do not yet support CIMD;
- Google OIDC as upstream human authentication, reusing the current identity
  semantics and email allowlist policy;
- read, ordinary write, and security-sensitive MCP scopes;
- intention-revealing MCP tools over the existing admin service operations;
- edge routing/header isolation, rate limits, audit attribution, tests,
  observability, rollout, and GHC configuration documentation.

This work item does not:

- accept Google access or ID tokens as MCP bearer tokens;
- reuse `cas_admin_session` as MCP API authorization;
- expose tenant CAS data-plane capabilities through the control-plane MCP server;
- add platform-operator disaster-recovery or database administration tools;
- allow arbitrary SQL, arbitrary URLs, arbitrary admin routes, or a generic
  `request`/`fetch` tool;
- send private issuer keys, OAuth secrets, session cookies, raw access/refresh
  tokens, or D1/KV contents to an MCP client;
- introduce per-member CAS roles; existing equal stack-administrator membership
  remains the business authorization model; or
- auto-approve OAuth grants or destructive tool calls.

## Fixed decisions

### Package and deployment boundary

Create `unicas-packages/control-plane-mcp` as a private deployable package. It
depends on `@unicas/control-plane` and `@unicas/protocol-admin`, but not on tenant
Worker or Durable Object implementation packages. Root Ref audit reads continue
through the same narrow private audit-reader RPC used by the admin BFF.

The MCP Worker may bind `CAS_CONTROL_DB`, but all reads and writes must go through
`ControlPlaneService`. This intentionally replaces the older statement that
`cas-admin-webui` is the only deployable that wires D1 with the durable invariant
that `ControlPlaneService` is the sole control-data access and mutation path.
Update stale package comments and architecture documentation in the same change.

OAuth provider state belongs in a dedicated `OAUTH_KV` namespace. It must not be
stored in `CAS_CONTROL_DB`, and control-plane business records must not be stored
in OAuth KV. Provider grant `userId` and metadata are storage-visible, so use a
stable SHA-256 identity handle there; keep raw `(iss, sub)` and display profile in
the provider's encrypted props.

### Transport and protocol profile

Implement the current MCP Streamable HTTP transport with one endpoint at `/mcp`.
Prefer the stateless `createMcpHandler` path: each message is a POST, responses
use JSON or request-scoped SSE as required, GET may return `405`, and no Durable
Object or MCP session ID is required for the initial tool set. Treat message-body
request metadata as authoritative under the 2026-07-28 protocol and let the
tested SDK compatibility path handle initialization-based older revisions.
Reject body/header protocol metadata mismatches as required and return protocol
errors without leaking internals.

The server implements tools only in this phase. Resources, prompts, sampling,
elicitation, and MCP Apps are deferred until a concrete control-plane workflow
requires them.

Use MCP tool annotations accurately:

- read tools: `readOnlyHint: true`, `destructiveHint: false`;
- idempotent writes: `idempotentHint: true` only when backed by an idempotency key;
- member removal, issuer/key transitions, and refDomain retirement:
  `destructiveHint: true`;
- no handler may rely on annotations as authorization; scopes, membership, and
  preconditions are server-enforced.

### OAuth and upstream identity

Use `@cloudflare/workers-oauth-provider` as the OAuth authorization/resource
server implementation. Configure:

```text
resource              https://unicas.shazhou.work/mcp
authorize endpoint    /oauth/authorize
token endpoint        /oauth/token
revocation endpoint   /oauth/token (provider-owned RFC 7009 handling)
DCR fallback          /oauth/register
Google callback       /oauth/google/callback
PKCE                   S256 only
implicit flow          disabled
```

Expose both root and path-specific RFC 9728 protected-resource metadata as
required by the provider, plus RFC 8414 authorization-server metadata. Enable
CIMD with `global_fetch_strictly_public`; retain DCR only for compatibility and
apply the provider's redirect/client validation and bounded registration TTL.
Do not implement a custom token format or authorization-code store.

Extract the generic OIDC client and PKCE helpers currently owned by
`admin-webui/src/server/oidc.ts` into a small shared server-only package. Both
admin BFF and MCP OAuth authorization must use the same configured Google issuer,
client audience, ID-token verification, verified-email allowlist, and immutable
identity mapping. The MCP authorization transaction has independent, encrypted,
single-use state/nonce/verifier storage with a short TTL; it does not share the
admin browser session.

After Google callback, render a same-origin consent page that names the client,
canonical MCP resource, requested scopes, and their effects. Consent is explicit,
CSRF-protected, and deny is supported. Never auto-approve because a user already
has an admin session or previous Google login.

Initial token lifetime policy:

```text
authorization transaction  10 minutes, single use
access token                15 minutes
refresh token/grant         8 hours, rotating refresh token
DCR client                  provider default, maximum 90 days
```

Membership and current `ADMIN_EMAIL_ALLOWLIST` policy are re-evaluated during
tool calls, not only when the token is issued. A user removed from a stack loses
that stack immediately; a user no longer allowed by ingress policy receives no
tool result even while an access token is otherwise cryptographically valid.

### Scopes and authorization

Scopes are coarse OAuth grants; `ControlPlaneService` remains authoritative for
resource-level membership and last-member/business invariants.

| Scope | Permits |
| --- | --- |
| `control:read` | identity, stack configuration, membership, public issuer data, refDomains, and audit reads |
| `control:write` | stack creation/rename, refDomain creation, and refDomain disable/retire lifecycle changes |
| `control:security` | member invitation/removal, issuer replacement, and issuer-key lifecycle changes |

`control:security` does not imply either other scope. Each handler checks every
required scope explicitly. The consent page must explain that grants apply to
stacks the identity administers now or joins during the grant lifetime; OAuth
does not snapshot stack IDs into a token.

Security-sensitive mutations and lifecycle reductions of existing resources
require an explicit current ETag from a preceding read and use the existing
`If-Match` semantics. RefDomain disable/retire requires `control:write`, an
explicit target-state confirmation, and a destructive annotation: disabling
immediately rejects writes and retirement is one-way and reserves the name.
Member invitation is security-sensitive because acceptance grants equal
stack-admin authority; it requires `control:security`, explicit target
confirmation, and a stable MCP-call idempotency key, but is not annotated as
destructive. Creation tools require or derive a stable MCP-call idempotency key
and return it so retries are understandable. The server never silently retries
a mutation after an ambiguous response.

### Tool surface

Tool names and input/output schemas are versioned public contracts. Inputs use
structured schemas and the existing protocol-admin types; outputs are concise
JSON-compatible domain results, not rendered admin HTML or raw `Response` data.

Initial read tools (`control:read`):

| Tool | Existing operation |
| --- | --- |
| `whoami` | `me` |
| `list_stacks` | `listStacks` |
| `get_stack` | `getStack` |
| `list_members` | `listMembers` |
| `get_issuer` | `getIssuer` |
| `list_issuer_keys` | `listIssuerKeys` |
| `list_ref_domains` | private observed-domain audit-reader RPC after membership check |
| `list_control_audit_events` | `listControlAuditEvents` |
| `list_root_domain_refs` | private audit-reader RPC after membership check |
| `list_root_domain_events` | private audit-reader RPC after membership check |

Initial ordinary writes (`control:write`):

| Tool | Existing operation |
| --- | --- |
| `create_stack` | `createStack` |
| `update_stack` | `patchStack` |

Initial security writes (`control:security`):

| Tool | Existing operation |
| --- | --- |
| `invite_member` | `createMemberInvitation` |
| `remove_member` | `deleteMember` |
| `set_issuer` | `putIssuer` |
| `create_issuer_key_challenge` | `createPossessionChallenge` |
| `add_issuer_key` | `createIssuerKey` |
| `transition_issuer_key` | `deleteIssuerKey` state transition |

Invitation acceptance stays a human browser workflow. Issuer-key tools accept
only public JWK material and the existing possession proof; private key material
is never a valid field. Do not expose stack deletion because no such supported
control-plane operation exists.

### Audit and observability

Extend `ControlPlaneCallContext` with optional, structured caller attribution:

```ts
interface ControlPlaneCallerAttribution {
  readonly channel: "admin-webui" | "mcp";
  readonly oauthClientId?: string;
  readonly toolName?: string;
}
```

Persist attribution on control-audit mutation events through an additive schema
migration and frozen protocol fields. Preserve existing action/target values.
Use bounded, non-secret client identifiers; hash a URL client ID before storage
if necessary. Read calls emit metrics/traces rather than append a business audit
event unless an existing operation already does so.

Structured logs and metrics include request ID, trace ID, outcome, latency,
OAuth client handle, tool name, control action, and stack ID where authorized.
They exclude bearer tokens, authorization codes, refresh tokens, session cookies,
Google tokens, invitation tokens/accept URLs, public-key possession proofs, and
raw request bodies. Add counters for authorization success/deny/failure, token
refresh/revocation, tool result classes, scope denial, membership denial, stale
preconditions, rate limiting, and upstream OIDC failure.

### Edge routing and header isolation

Extend `cas-edge` with `CAS_MCP_SERVICE` and exact MCP/OAuth routes. Do not route
an unrestricted new top-level prefix.

```text
/mcp
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/google/callback
/oauth/token
/oauth/register
```

For `/mcp`, preserve Bearer `Authorization`, `Accept`, `Origin`,
`MCP-Protocol-Version`, and MCP transport headers; strip cookies and all internal
shared-secret headers. For browser OAuth/consent routes, preserve only the
provider's narrowly named transaction/consent cookies and strip unrelated admin
or tenant cookies before forwarding. For metadata endpoints, strip all cookies
and authorization. Existing `/admin` must continue stripping Bearer tokens and
existing `/stacks` must continue stripping admin cookies.

Reject a present untrusted `Origin` on `/mcp`; permit non-browser clients that
omit it. Apply separate rate limits to OAuth endpoints, initialization/tool
calls, and security mutations. Keep backing Workers private and preserve
`cas-edge` as the sole custom-domain route.

## Expected files

Create:

- `unicas-packages/control-plane-mcp/package.json`
- `unicas-packages/control-plane-mcp/tsconfig.json`
- `unicas-packages/control-plane-mcp/wrangler.toml`
- `unicas-packages/control-plane-mcp/src/worker.ts`
- `unicas-packages/control-plane-mcp/src/auth.ts`
- `unicas-packages/control-plane-mcp/src/consent.ts`
- `unicas-packages/control-plane-mcp/src/server.ts`
- `unicas-packages/control-plane-mcp/src/tools/read.ts`
- `unicas-packages/control-plane-mcp/src/tools/write.ts`
- `unicas-packages/control-plane-mcp/src/tool-result.ts`
- `unicas-packages/control-plane-mcp/tests/auth.test.ts`
- `unicas-packages/control-plane-mcp/tests/server.test.ts`
- `unicas-packages/control-plane-mcp/tests/tools.test.ts`
- `unicas-packages/control-plane-mcp/tests/boundary.test.ts`
- a small shared server-only OIDC package and tests, named consistently with
  existing workspace conventions during implementation
- `docs/cas-control-plane-mcp.md`

Modify at minimum:

- `pnpm-lock.yaml`, `tsconfig.json`, and any workspace dependency-analysis input;
- `unicas-packages/admin-webui/src/server/oidc.ts` and its imports/tests during
  shared OIDC extraction;
- `unicas-packages/control-plane/src/service.ts`, control-audit schema/migrations,
  and tests for caller attribution;
- `unicas-packages/protocol-admin` audit types if attribution is externally read;
- `unicas-packages/edge/src/worker.ts`, tests, and `wrangler.toml`;
- local development/provisioning scripts and stack deployment documentation;
- `docs/cas-architecture.md`, `docs/cas-operations.md`, and `README.md`.

## Implementation tasks

### Task 1: Characterize boundaries and add failing contract tests

- [x] Run and record the current package baselines:

  ```powershell
  pnpm --filter @unicas/control-plane test
  pnpm --filter @unicas/admin-webui test
  pnpm --filter @unicas/edge test
  pnpm --filter @unicas/control-plane typecheck
  pnpm --filter @unicas/admin-webui typecheck
  pnpm --filter @unicas/edge typecheck
  ```

- [x] Add failing edge tests for the exact MCP/OAuth route allowlist, Bearer
  preservation on `/mcp`, cookie stripping, metadata sanitization, and continued
  `/admin`/`/stacks` isolation.
- [x] Add failing control-plane tests proving the same `(iss, sub)` has identical
  memberships through admin and MCP contexts and caller attribution cannot alter
  authorization.
- [x] Add dependency-boundary tests proving the new package cannot import tenant
  Worker/DO implementations or issue direct D1 SQL from tool modules.

### Task 2: Extract and preserve upstream OIDC authentication

- [x] Move the generic OIDC discovery, PKCE, code exchange, ID-token verification,
  and test helpers from `admin-webui` into a shared server-only package.
- [x] Keep issuer, audience, nonce, algorithm, JWKS-origin, clock-skew, verified
  email, and allowlist checks behaviorally identical for the admin BFF.
- [x] Add MCP-specific callback URI and single-use authorization transaction
  storage without sharing the admin session cookie.
- [x] Prove Google tokens and authorization codes are discarded after verified
  identity extraction and are never present in OAuth grant props or logs.
- [x] Rerun admin BFF OIDC/session tests before implementing MCP tools.

### Task 3: Scaffold the private MCP Worker and OAuth provider

- [x] Add the package, composite tsconfig/root reference, tested dependencies,
  Worker entrypoint, private deployment config, dedicated `OAUTH_KV`, and secrets.
- [x] Configure canonical resource metadata, RFC 8414 metadata, S256 PKCE, CIMD,
  bounded DCR fallback, token lifetimes, rotating refresh, and revocation.
- [x] Implement Google authentication, explicit consent approve/deny, consent
  CSRF protection, exact redirect validation, and encrypted single-use state.
- [~] Add tests for discovery, challenge headers, resource mismatch, redirect
  mismatch, state/nonce replay, PKCE failure, consent denial, scope narrowing,
  expiry, refresh rotation, revocation, and allowlist removal.
- [ ] Run the upstream package's applicable Worker/MCP OAuth conformance suite or
  document any conformance case that cannot run in this repository.

### Task 4: Implement stateless MCP transport and read tools

- [x] Implement current protocol bootstrap, `tools/list`, and `tools/call` over
  stateless Streamable HTTP, plus the SDK's initialization-based compatibility
  path for supported older clients, with structured validation and bounded results.
- [x] Map encrypted OAuth props to `ControlPlaneCallContext`; expose no raw token
  or provider storage to tool code.
- [x] Implement the ten read tools, cursor/limit behavior, membership enforcement,
  stable error mapping, and private audit-reader calls.
- [~] Test no-token/wrong-token responses at HTTP level and scope/membership/input
  failures as MCP tool errors without stack existence or secret disclosure.
- [~] Prove all read results are bounded and pagination cursors round-trip.

### Task 5: Implement guarded mutation tools

- [x] Implement ordinary write tools with `control:write`, stable idempotency
  keys for creations, and protocol-admin validation. Require current ETag,
  explicit target-state confirmation, and a destructive annotation for
  refDomain disable/retire while preserving the existing one-way state machine.
- [x] Implement security tools with `control:security`; require current ETags and
  destructive annotations where the operation mutates/removes existing authority,
  while member invitation uses explicit target confirmation, idempotency, and a
  non-destructive annotation. Do not automatically retry ambiguous results. Add a
  deployment kill switch that can disable all MCP mutations while retaining reads.
- [x] Preserve last-member protection, issuer possession proof, key state machine,
  refDomain state machine, and invitation constraints.
- [~] Test scope separation, refDomain transition with `control:write`, invitation
  denial without `control:security`, explicit invitation/transition target
  handling, stale/missing ETag where required, duplicate idempotency key,
  cross-stack attempts, membership removal during a grant, and concurrent updates.
- [ ] Verify errors contain actionable domain codes but never authorization,
  invitation, token, cookie, or internal SQL details.

### Task 6: Add MCP audit attribution and telemetry

- [x] Add the optional caller-attribution context, additive D1 migration, protocol
  fields, service writes, and backwards-compatible reads.
- [x] Populate channel, bounded/hashed OAuth client ID, and tool name for MCP
  mutations; populate `admin-webui` channel for browser mutations.
- [ ] Add redaction tests for tokens, codes, invitation URLs, proofs, and request
  bodies across success and error logging paths.
- [ ] Add metrics/traces and alerts for repeated auth failures, scope/membership
  denial spikes, security mutations, provider failures, and rate limiting.

### Task 7: Wire the edge and local development path

- [x] Add exact edge dispatch routes and `CAS_MCP_SERVICE`; implement per-route
  header/cookie policy and update boundary tests.
- [x] Bind MCP Worker to `CAS_CONTROL_DB`, dedicated OAuth KV, and the private
  audit reader; never add an independent public Worker route.
- [ ] Extend local development scripts with mock Google OIDC and isolated local
  OAuth KV while keeping production-only shortcuts unavailable by default.
- [ ] Add health/readiness checks that distinguish edge, admin, MCP, OAuth KV,
  control DB, and audit-reader failure.

### Task 8: Validate GHC interoperability and security

- [x] Add the remote server to a clean VS Code/GitHub Copilot profile using only
  `type`, `url`, and trust confirmation; do not pre-seed a token or client secret.
  (`.vscode/mcp.json` configures `unicas-control-plane` → `type: http`,
  `https://unicas.shazhou.work/mcp` — no secret anywhere.)
- [ ] Capture a smoke test for discovery, Google login, consent, protocol/tool
  discovery, `whoami`, paginated reads, one idempotent write, one security write
  with ETag, token refresh, and revocation/re-authentication.
- [ ] Test callback behavior for desktop and Agent Host clients, including CIMD
  and DCR fallback paths actually used by supported GHC versions.
- [x] Run package tests/typechecks, edge tests, integration tests, dependency
  analysis, and a production-like Miniflare/Worker smoke test.
- [ ] Threat-model token theft, confused deputy/token passthrough, malicious
  client metadata, redirect abuse, authorization-code interception, CSRF, DNS
  rebinding/Origin handling, scope escalation, cross-stack access, replay,
  prompt-driven destructive calls, log leakage, and compromised refresh tokens.

### Task 9: Document, deploy, and stage rollout

- [x] Document GHC configuration, sign-in/consent, scope meanings, tool catalog,
  expected confirmation UI, pagination, errors, and reauthorization.
- [x] Document OAuth KV ownership, backup expectations, grant/client revocation,
  Google and provider secret rotation, OAuth dependency upgrades, rate limits,
  alerts, incident response, and mutation kill switch.
- [x] Update architecture text that says only the admin WebUI binds the control DB
  and record that both ingress adapters share the sole service abstraction.
- [x] Deploy discovery and `control:read` first; observe auth/tool telemetry and
  complete a cross-stack isolation check before enabling mutation scopes.
  (Deployed 2026-08-27 and verified against the live edge: the private MCP
  Worker `unidocs-cas-control-plane-mcp` (version `2608efb3`, OAuth KV
  `abb77c24…`, shared `CAS_CONTROL_DB`, private audit-reader binding) behind
  `cas-edge`'s exact `/mcp` + `/oauth/*` allowlist. Live probes: RFC 8414
  discovery 200, `/.well-known/oauth-protected-resource` 200 (resource
  `https://unicas.shazhou.work/mcp`, scopes `control:read/write/security`),
  unauthenticated `/mcp` initialize 401, and dynamic client registration 201.
  `MCP_MUTATIONS_ENABLED=true` is the published config, so mutation scopes are
  already live behind scope/membership checks; a human Google sign-in +
  consent pass through GitHub Copilot is still required to confirm the full
  authorization loop end-to-end.)
- [x] Enable `control:write`, then `control:security` in separate rollout steps;
  verify revocation and the mutation kill switch after each step.
  (Enabled in the published `MCP_MUTATIONS_ENABLED=true`; the kill switch
  fails closed when absent. Revocation (`RFC 7009`) and reauthorization are
  covered by the OAuth provider and documented; the live human-flow
  verification is the Task 8 smoke item.)

## Validation gate

Before marking this plan complete, run at least:

```powershell
pnpm --filter @unicas/control-plane-mcp test
pnpm --filter @unicas/control-plane-mcp typecheck
pnpm --filter @unicas/control-plane test
pnpm --filter @unicas/admin-webui test
pnpm --filter @unicas/edge test
pnpm --filter @unicas/control-plane typecheck
pnpm --filter @unicas/admin-webui typecheck
pnpm --filter @unicas/edge typecheck
pnpm test:local
node scripts/analyze-deps.mjs
```

The release gate also requires one real GHC OAuth round trip against the staged
custom-domain route. Unit tests or a manually supplied bearer token do not
substitute for this interoperability check.

## Standards and implementation references

- MCP authorization, current profile:
  `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization`
- MCP Streamable HTTP transport:
  `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http`
- Cloudflare Workers OAuth Provider:
  `https://github.com/cloudflare/workers-oauth-provider`
- Cloudflare MCP authorization guidance:
  `https://developers.cloudflare.com/agents/model-context-protocol/authorization/`
- VS Code remote MCP configuration:
  `https://code.visualstudio.com/docs/copilot/customization/mcp-servers`

If a dependency and the current MCP specification disagree, follow the current
specification, add a regression/conformance test, and either upgrade or isolate
the dependency behavior. Do not silently weaken audience, redirect, PKCE, scope,
or token-passthrough requirements for client compatibility.