---
name: unicas-cli
description: Use whenever a task involves operating the Unicas CAS control plane — listing or creating stacks, managing stack administrators (invite/remove), viewing or changing the tenant JWT issuer, adding or transitioning issuer keys, or reading refDomains and control-plane audit — and the agent should drive it through the `unicas` CLI or its stdio MCP mode (for example from DeepSeek Harness, which cannot complete OAuth MCP itself)
---

# Using the `unicas` CLI

This skill teaches an agent to operate the Unicas control plane with the
`unicas` command-line tool. The CLI is the supported path for agents that
cannot complete OAuth in a browser: it performs the OAuth dance itself, stores
the session, and exposes the same 18 tools as the control-plane MCP endpoint
as plain shell commands and as a stdio MCP server.

## When to use this skill

Load and follow this skill when the task involves any of these:

- Stack administration: list stacks, show one stack, create a stack
  (`control:read` / `control:write`).
- Member management: list a stack's administrators, invite a member, remove a
  member (`control:security`).
- Issuer configuration: read or set a stack's tenant JWT issuer and audience
  (`control:read` / `control:security`).
- Issuer key lifecycle: list keys, create a possession challenge, add a public
  key with a signed proof, transition a key to retiring/revoked
  (`control:security`).
- Audit and observability: refDomains catalog, control-plane audit events,
  Root Ref balances and events (`control:read`).

Do **not** use this skill for tenant data-plane operations (Root Ref writes,
CAS capability checks), for admin WebUI-only flows (invitation acceptance in a
browser, OIDC session management), or for changing the control-plane MCP
deployment itself.

## How the CLI works

- One-time interactive login: `unicas login` opens a browser (Google sign-in +
  UniCAS consent), performs RFC 9728/8414 discovery, dynamic client
  registration, and PKCE, then persists the session to `~/.unicas/token.json`
  (0600). Access tokens live 15 minutes; refresh tokens rotate and are renewed
  automatically on `401`.
- Every command and `unicas mcp` reuse the persisted session. No API keys.
- All commands print JSON on stdout; diagnostics go to stderr.
- Exit codes: `0` success, `1` error (including remote tool errors), `2` not
  logged in / authorization required.

## First run (once per machine)

```powershell
pnpm --filter @unicas/admin-cli build
pnpm install --global ./unicas-packages/admin-cli   # pnpm 10+: pnpm link --global is removed
unicas login                                  # browser OAuth + consent
```

Check state without network: `unicas status` (logged in? scopes? expiry?).
If a command reports "Not logged in. Run `unicas login` first", run
`unicas login` before retrying.

## Command catalog

Read (`control:read`):

```text
unicas whoami
unicas stacks list [--limit N] [--cursor C]
unicas stacks get <stackId>
unicas members list <stackId> [--limit N] [--cursor C]
unicas issuer get <stackId>
unicas keys list <stackId>
unicas ref-domains list <stackId>
unicas audit control <stackId> [--limit N] [--cursor C] [--after ID]
unicas audit root-domain-refs <stackId> <refDomain> [--tenant-id T] [--limit N] [--cursor C]
unicas audit root-domain-events <stackId> <refDomain> [--tenant-id T] [--after N] [--limit N]
```

Write (`control:write`):

```text
unicas stacks create <displayName> [--idempotency-key K]
unicas stacks update <stackId> [displayName] [--description D] [--etag E]
```

Security (`control:security`):

```text
unicas members invite <stackId> <email> [--idempotency-key K]
unicas members remove <stackId> --identity-issuer <url> --subject <sub> [--etag E] [--confirm-subject S]
unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I]
unicas keys challenge <stackId> <kid> <ES256|RS256|EdDSA>
unicas keys add <stackId> <kid> <ES256|RS256|EdDSA> --public-jwk <json> --possession-proof <jws> [--idempotency-key K]
unicas keys transition <stackId> <kid> <retiring|revoked> [--etag E] [--confirm-kid K] [--confirm-state S]
```

Session: `unicas login`, `unicas logout` (RFC 7009 revocation), `unicas status`.
MCP: `unicas mcp` (stdio server).

## Guardrails an agent must respect

- **ETags**: `stacks update`, `members remove`, `issuer set`, and
  `keys transition` need the current ETag. If `--etag` is omitted the CLI
  reads it first (`get_stack` / `get_issuer` / `list_issuer_keys`); `issuer
  set` uses `*` only when no issuer exists yet. A stale ETag fails with
  `REVISION_MISMATCH` — re-read and retry.
- **Confirmations**: destructive operations require `--confirm-*` values that
  exactly match the target. Non-interactively (no TTY) the CLI refuses without
  them — always pass explicit flags, never guess.
- **Idempotency**: creation commands auto-generate `unicas-cli:<uuid>` keys;
  pass `--idempotency-key` for deterministic retries.
- **Secrets**: `keys add` accepts only a public JWK plus a compact-JWS
  possession proof signed with the private key elsewhere (see
  `scripts/cas-possession-sign.mjs`). Never pass private key material.
- **No stack deletion** exists on the control plane; do not invent or suggest
  one.

## Common workflows

Create a stack:

```powershell
unicas stacks create "Operations" --idempotency-key create-ops-1
# -> { stackId, displayName, revision, etag }
```

Invite a member (email bound; equal administrator authority):

```powershell
unicas members invite <stackId> ops@example.com --idempotency-key invite-ops-1
# returns an acceptUrl to share once
```

Rotate an issuer key (challenge -> sign -> add -> transition):

```powershell
unicas keys challenge <stackId> key-2026 ES256      # sign the nonce off-band
unicas keys add <stackId> key-2026 ES256 --public-jwk '{...}' --possession-proof '<jws>' --idempotency-key add-key-2026
unicas keys transition <stackId> key-2025 retiring --confirm-kid key-2025 --confirm-state retiring
```

Read the audit trail after a mutation:

```powershell
unicas audit control <stackId> --limit 20
```

## stdio MCP mode (DeepSeek Harness)

`unicas mcp` spawns a stdio MCP server advertising the same 18 tools,
forwarding calls over the authenticated connection:

```json
{ "transport": "stdio", "serverName": "unicas", "command": "unicas", "args": ["mcp"] }
```

On Windows the global bin is a `.CMD` shim; a Node-based client must spawn with
`shell: true`, use the shim path (`%LOCALAPPDATA%\pnpm\bin\unicas.CMD`), or
invoke `node <checkout>/unicas-packages/admin-cli/dist/cli.js mcp` directly.

## Troubleshooting

- "Not logged in. Run `unicas login` first" → run `unicas login`.
- Browser shows `AUTHORIZATION_FAILED client_id is required` → the authorize
  URL was truncated (usually a copy/paste from a wrapped terminal line);
  re-run `unicas login` or copy the printed URL completely.
- A revoked grant or expired client registration fails closed with the
  re-login prompt → run `unicas login` again.
- `REVISION_MISMATCH` → the resource changed; re-read to obtain the fresh ETag.

## Sources of truth

- `docs/cas-control-plane-cli.md` — CLI overview and DSH integration.
- `unicas-packages/admin-cli/README.md` — full command reference and guardrails.
- `unicas-packages/admin-cli/src/mcp/catalog.ts` — the exact 18-tool contract
  mirrored from the remote control plane.
