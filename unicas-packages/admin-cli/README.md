# @unicas/admin-cli

Unicas control-plane management CLI. Logs in by performing its own Google OIDC
authorization-code flow (S256 PKCE) with a local callback, then exchanges the
verified id_token with the control-plane BFF (`/admin/auth/exchange`) for a
session cookie + CSRF token, persisted locally. Commands call the typed
`@unicas/admin-client` over the `/admin` HTTP API; `unicas mcp` exposes the
same 18-tool contract as `@unicas/control-plane-mcp` as a stdio MCP server
backed by that client (for clients whose MCP support cannot do OAuth, for
example DeepSeek Harness).

```
https://unicas.shazhou.work/admin  <- /admin control-plane API (BFF session)
        ^
        | session cookie + CSRF (via @unicas/admin-client)
unicas CLI  <- Google OIDC dance -> /admin/auth/exchange, persists ~/.unicas/session.json
        |
        +-- plain commands:   unicas whoami / unicas stacks list ...
        `-- stdio MCP server: unicas mcp   (DSH: command "unicas", args ["mcp"])
```

## Requirements

- Node.js >= 24
- pnpm (workspace package; build with `tsc`)

## Build

```powershell
pnpm install
pnpm --filter @unicas/admin-cli build
```

This produces `dist/cli.js` (the `unicas` bin target).

## Log in

```powershell
pnpm --filter @unicas/admin-cli unicas login
```

`login` performs a Google OIDC authorization-code flow with S256 PKCE, then
exchanges the verified id_token for a `/admin` BFF session:

1. Google OIDC discovery against the configured issuer (default
   `accounts.google.com`) with the CLI's registered Google OAuth client
   (`UNICAS_GOOGLE_CLIENT_ID`).
2. Opens the browser at Google's authorize endpoint, receives the callback on
   the local `127.0.0.1` loopback server, validates `state`, and exchanges the
   code for an id_token (nonce verified).
3. POSTs `{ idToken, nonce }` to `${UNICAS_ADMIN_URL}/admin/auth/exchange`;
   the BFF verifies the token + email allowlist and returns a session cookie
   and CSRF token.
4. Persists the session to `~/.unicas/session.json` (created `0600`, atomic
   writes).

## Commands

| Command | MCP tool |
| --- | --- |
| `unicas whoami` | `whoami` |
| `unicas stacks list [--limit N] [--cursor C]` | `list_stacks` |
| `unicas stacks get <stackId>` | `get_stack` |
| `unicas stacks create <displayName> [--idempotency-key K]` | `create_stack` |
| `unicas stacks update <stackId> [displayName] [--description D] [--etag E]` | `update_stack` |
| `unicas members list <stackId> [--limit N] [--cursor C]` | `list_members` |
| `unicas members invite <stackId> <email> [--idempotency-key K]` | `invite_member` |
| `unicas members remove <stackId> --identity-issuer <url> --subject <sub> [--etag E] [--confirm-subject S]` | `remove_member` |
| `unicas issuer get <stackId>` | `get_issuer` |
| `unicas issuer set <stackId> <issuer> <audience> [--etag E] [--confirm-issuer I]` | `set_issuer` |
| `unicas keys list <stackId>` | `list_issuer_keys` |
| `unicas keys challenge <stackId> <kid> <ES256\|RS256\|EdDSA>` | `create_issuer_key_challenge` |
| `unicas keys add <stackId> <kid> <ES256\|RS256\|EdDSA> --public-jwk <json> --possession-proof <jws> [--idempotency-key K]` | `add_issuer_key` |
| `unicas keys transition <stackId> <kid> <retiring\|revoked> [--etag E] [--confirm-kid K] [--confirm-state S]` | `transition_issuer_key` |
| `unicas ref-domains list <stackId>` | `list_ref_domains` |
| `unicas audit control <stackId> [--limit N] [--cursor C] [--after ID]` | `list_control_audit_events` |
| `unicas audit root-domain-refs <stackId> <refDomain> [--tenant-id T] [--limit N] [--cursor C]` | `list_root_domain_refs` |
| `unicas audit root-domain-events <stackId> <refDomain> [--tenant-id T] [--after N] [--limit N]` | `list_root_domain_events` |
| `unicas logout` | RFC 7009 revocation + clears the session |
| `unicas status` | Local session summary (no network) |
| `unicas mcp` | Run as a stdio MCP server |

Plain commands print the tool's `structuredContent` as JSON on stdout;
diagnostics go to stderr.

## Guardrails

- **ETags.** `update_stack`, `remove_member`, `set_issuer`, and
  `transition_issuer_key` need the current ETag. When `--etag` is omitted the
  CLI reads it first (`get_stack` / `get_issuer` / `list_issuer_keys`).
  `set_issuer` uses `*` only when no issuer exists yet.
- **Confirmations.** Destructive operations require their `--confirm-*` flag
  to exactly match the target. Without the flag and a TTY, the CLI prompts;
  without the flag and no TTY (scripts), the command fails.
- **Idempotency.** `create_stack`, `invite_member`, and `add_issuer_key`
  auto-generate a stable `unicas-cli:<uuid>` idempotency key when
  `--idempotency-key` is omitted.
- **Never secrets on the wire to the CLI.** Issuer keys accept only public JWK
  + a compact-JWS possession proof; private key material is never a CLI input.

## stdio MCP server (`unicas mcp`)

Spawns a stdio MCP server that advertises the exact same 18 tools as the remote
control plane and forwards each `tools/call` over the authenticated Streamable
HTTP connection. Only MCP protocol frames go to stdout.

```json
{
  "mcpServers": {
    "unicas-control-plane": {
      "command": "unicas",
      "args": ["mcp"]
    }
  }
}
```

To expose the `unicas` command on PATH from this checkout:

```powershell
pnpm --filter @unicas/admin-cli build
# pnpm 10+ removed `pnpm link --global`; install the local package globally instead:
pnpm install --global ./unicas-packages/admin-cli
# or point the MCP client directly at the built script:
#   node D:\Code\unidocs-cli\unicas-packages\cli\dist\cli.js mcp
```

Alternatively run any command in-process:
`pnpm --filter @unicas/admin-cli unicas stacks list`.

> Windows note: pnpm's global bin is a `.CMD` shim. A Node-based MCP client
> spawning `unicas mcp` must either use `shell: true`, point at the shim path
> (`%LOCALAPPDATA%\pnpm\bin\unicas.CMD`), or use
> `command: "node"` with `args: ["<checkout>/unicas-packages/admin-cli/dist/cli.js",
> "mcp"]` — a plain `spawn("unicas", …)` fails with `ENOENT`/`EINVAL` because
> Node does not resolve `.CMD` files.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNICAS_ADMIN_URL` | `https://unicas.shazhou.work` | `/admin` API origin |
| `UNICAS_GOOGLE_CLIENT_ID` | built-in Desktop client | Google OAuth client id for `unicas login` (public, no secret) |
| `UNICAS_CONFIG_DIR` | `~/.unicas` | Directory holding `session.json` |

## Security notes

- The session cookie is stored locally with `0600` permissions; the directory
  is created on demand.
- No long-lived bearer tokens are stored: the CLI holds only the BFF session
  cookie (server-side session, TTL enforced by the BFF) plus the CSRF token.
- `unicas logout` ends the BFF session server-side (`POST /admin/auth/logout`)
  and always clears the local session.
- The id_token is exchanged once and never persisted; the session fails closed
  with a re-login prompt when the BFF rejects the cookie.

## Tests

```powershell
pnpm --filter @unicas/admin-cli test
pnpm --filter @unicas/admin-cli typecheck
```

Tests run against an in-memory fake of the `/admin` BFF API plus a mock
Google OIDC provider — no network, no real OAuth. A live `unicas login` +
`unicas whoami` against production is a manual verification step because it
requires a real browser Google sign-in.
