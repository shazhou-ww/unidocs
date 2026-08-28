# @unicas/cli

Unicas control-plane management CLI. Authenticates against the OAuth-protected
control-plane MCP endpoint with a real browser flow (RFC 9728 discovery, RFC
7591 dynamic client registration, RFC 7636 PKCE, rotating refresh tokens, RFC
7009 revocation), persists the session locally, and exposes the same 18-tool
contract as `@unicas/control-plane-mcp` as plain shell commands **and** as a
stdio MCP server for clients whose MCP support cannot do OAuth (for example
DeepSeek Harness).

```
https://unicas.shazhou.work/mcp   <- control-plane MCP (OAuth protected)
        ^
        | Streamable HTTP + Unicas bearer token (refreshed automatically)
unicas CLI  <- does the OAuth dance itself, persists ~/.unicas/token.json
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
pnpm --filter @unicas/cli build
```

This produces `dist/cli.js` (the `unicas` bin target).

## Log in

```powershell
pnpm --filter @unicas/cli unicas login
```

`login` runs the full OAuth authorization-code flow with S256 PKCE:

1. RFC 9728 protected-resource discovery + RFC 8414 authorization-server
   discovery against `https://unicas.shazhou.work/mcp`.
2. Dynamic client registration (public client, `token_endpoint_auth_method:
   none`); every login registers a fresh client bound to the ephemeral
   `127.0.0.1` callback port.
3. Opens the browser at the Unicas authorize endpoint (Google sign-in +
   consent page), receives the callback on the local loopback server, validates
   `state`, and exchanges the code.
4. Persists client registration, tokens, and discovery state to
   `~/.unicas/token.json` (created `0600`, atomic writes).

By default all three scopes are requested:
`control:read control:write control:security`. Narrow with
`--scopes control:read,control:write`.

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
pnpm --filter @unicas/cli build
# pnpm 10+ removed `pnpm link --global`; install the local package globally instead:
pnpm install --global ./unicas-packages/cli
# or point the MCP client directly at the built script:
#   node D:\Code\unidocs-cli\unicas-packages\cli\dist\cli.js mcp
```

Alternatively run any command in-process:
`pnpm --filter @unicas/cli unicas stacks list`.

> Windows note: pnpm's global bin is a `.CMD` shim. A Node-based MCP client
> spawning `unicas mcp` must either use `shell: true`, point at the shim path
> (`%LOCALAPPDATA%\pnpm\bin\unicas.CMD`), or use
> `command: "node"` with `args: ["<checkout>/unicas-packages/cli/dist/cli.js",
> "mcp"]` — a plain `spawn("unicas", …)` fails with `ENOENT`/`EINVAL` because
> Node does not resolve `.CMD` files.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNICAS_SERVER_URL` | `https://unicas.shazhou.work/mcp` | MCP resource URL |
| `UNICAS_CONFIG_DIR` | `~/.unicas` | Directory holding `token.json` |

## Security notes

- Refresh tokens are stored locally with `0600` permissions; the directory is
  created on demand.
- Access tokens live 15 minutes and rotate refresh tokens live 8 hours; the CLI
  refreshes automatically on `401`.
- `unicas logout` revokes the refresh token at the discovered
  `revocation_endpoint` (RFC 7009) and always clears the local session.
- Token refresh and revocation use the stored dynamic client registration; a
  revoked grant or expired registration fails closed with a re-login prompt.

## Tests

```powershell
pnpm --filter @unicas/cli test
pnpm --filter @unicas/cli typecheck
```

Tests run against an in-memory fake of the control-plane edge (discovery, DCR,
token endpoint, revocation, stateless MCP server) — no network, no real OAuth.
A live `unicas login` + `unicas whoami` against production is a manual
verification step because it requires a real browser Google sign-in and Unicas
consent.
