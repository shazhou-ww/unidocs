---
name: unicas-cli
description: Use when operating the Unicas control plane through the `unicas` CLI — OAuth login/refresh, stacks/members/issuer/keys/refDomains/audit commands, and stdio MCP for agents that cannot complete OAuth MCP themselves
---

# Operating the Unicas control plane with `unicas`

The `unicas` CLI owns the OAuth session for the control-plane MCP endpoint
(`https://unicas.shazhou.work/mcp`). Run `unicas login` once in a browser
(Google sign-in + UniCAS consent), and every command and the stdio MCP mode
reuse the persisted session (`~/.unicas/token.json`, auto-refreshed). Use it
instead of raw MCP when the agent cannot complete OAuth in a browser — e.g.
DeepSeek Harness stdio MCP (`unicas mcp`) or plain shell commands.

## Sources of truth

- `docs/cas-control-plane-cli.md` — CLI overview and DSH integration.
- `unicas-packages/cli/README.md` — full command reference and guardrails.
- `unicas-packages/cli/src/mcp/catalog.ts` — the exact 18-tool contract
  (names, schemas, annotations) mirrored from the remote control plane.

## First run

```powershell
pnpm --filter @unicas/cli build
pnpm install --global ./unicas-packages/cli    # pnpm 10+: pnpm link --global is removed
unicas login                                   # browser OAuth + consent; persists tokens
```

`unicas status` reports the local session (logged in, scopes, expiry) without
network traffic. If a command says "Not logged in. Run `unicas login` first",
run `unicas login` (exit code 2).

## Command surface

Read (`control:read`): `unicas whoami`, `unicas stacks list|get`,
`unicas members list`, `unicas issuer get`, `unicas keys list`,
`unicas ref-domains list`, `unicas audit control|root-domain-refs|root-domain-events`.

Write (`control:write`): `unicas stacks create <displayName>`
(auto-generates an idempotency key, or pass `--idempotency-key`),
`unicas stacks update <stackId> <displayName>`.

Security (`control:security`): `unicas members invite|remove`,
`unicas issuer set`, `unicas keys challenge|add|transition`.

All commands print the tool's `structuredContent` as JSON on stdout;
diagnostics go to stderr.

## Guardrails to respect

- **ETags**: `update_stack`, `remove_member`, `set_issuer`,
  `transition_issuer_key` need the current ETag; the CLI reads it first when
  `--etag` is omitted. `set_issuer` uses `*` only when no issuer exists yet.
- **Confirmations**: destructive operations require `--confirm-*` flags that
  exactly match the target when run non-interactively; without them and no TTY
  the command fails rather than guessing.
- **Idempotency**: creation commands auto-generate `unicas-cli:<uuid>` keys;
  pass your own key to make retries deterministic.
- **Secrets**: `unicas keys add` accepts only a public JWK plus a compact-JWS
  possession proof — never pass private key material.
- **No stack deletion** exists on the control plane; do not invent one.

## stdio MCP mode (`unicas mcp`)

Spawns a stdio MCP server with the same 18 tools, forwarding each call over the
authenticated connection — this is how DeepSeek Harness connects:

```json
{ "transport": "stdio", "serverName": "unicas", "command": "unicas", "args": ["mcp"] }
```

On Windows the global bin is a `.CMD` shim; Node-based clients must spawn with
`shell: true`, use the shim path (`%LOCALAPPDATA%\pnpm\bin\unicas.CMD`), or
invoke `node <checkout>/unicas-packages/cli/dist/cli.js mcp` directly.

## Environment

`UNICAS_SERVER_URL` (default `https://unicas.shazhou.work/mcp`) and
`UNICAS_CONFIG_DIR` (default `~/.unicas`) override the endpoint and session
location. `unicas logout` revokes the refresh token (RFC 7009) and clears the
local session.

## Failure modes

- Browser shows `AUTHORIZATION_FAILED client_id is required` after `unicas
  login`: the authorize URL was truncated — re-run `unicas login` (the CLI now
  quotes the URL on Windows) or copy the printed URL completely.
- A revoked grant or expired registration fails closed with the re-login
  prompt; run `unicas login` again.
