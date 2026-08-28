# Unicas Control-Plane CLI

`@unicas/admin-cli` (bin `unicas`) is the operator-facing command line for UniCAS
control plane. It exists because DeepSeek Harness's MCP client only supports
static headers and therefore cannot complete the OAuth authorization-code flow
that protects `https://unicas.shazhou.work/mcp`. The CLI performs that flow
itself — discovery, dynamic client registration, PKCE, a local `127.0.0.1`
callback, refresh-token rotation, and RFC 7009 revocation — and persists the
session in `~/.unicas/token.json` (0600). Every other command then talks to the
remote MCP endpoint with the stored bearer token, refreshing automatically on
`401`.

See `unicas-packages/admin-cli/README.md` for the full command reference.

## Quick start

```powershell
pnpm --filter @unicas/admin-cli build
pnpm --filter @unicas/admin-cli unicas login        # browser: Google sign-in + consent
pnpm --filter @unicas/admin-cli unicas whoami
pnpm --filter @unicas/admin-cli unicas stacks list
pnpm --filter @unicas/admin-cli unicas stacks create "Operations" --idempotency-key create-ops-1
pnpm --filter @unicas/admin-cli unicas logout       # RFC 7009 revoke + clear session
```

## DSH integration (stdio MCP)

Configure DeepSeek Harness's mcp-client with a stdio server:

```json
{
  "transport": "stdio",
  "serverName": "unicas",
  "command": "unicas",
  "args": ["mcp"]
}
```

`unicas mcp` advertises the identical 18-tool contract as the remote control
plane and forwards calls over the authenticated connection, so DSH can read and
operate the control plane without any OAuth implementation of its own. To put
`unicas` on PATH from the checkout, run `pnpm --filter @unicas/admin-cli build` and
then `pnpm install --global ./unicas-packages/admin-cli` (pnpm 10+ removed
`pnpm link --global`), or configure the client with `command: "node"` and
`args: ["<checkout>/unicas-packages/admin-cli/dist/cli.js", "mcp"]`.

On Windows the global bin is a `.CMD` shim; a Node-based MCP client must spawn
it with `shell: true`, reference the shim path directly, or use the `node` +
`dist/cli.js` form above (a plain `spawn("unicas")` fails with `ENOENT`).

Alternatively, skip MCP entirely and have DSH run plain shell commands
(`unicas stacks list`, `unicas whoami`, …); the CLI prints JSON on stdout.

## Command surface = control-plane MCP tool set

| Group | Commands |
| --- | --- |
| Read (`control:read`) | `whoami`, `stacks list/get`, `members list`, `issuer get`, `keys list`, `ref-domains list`, `audit control/root-domain-refs/root-domain-events` |
| Write (`control:write`) | `stacks create` (idempotency key), `stacks update` (ETag) |
| Security (`control:security`) | `members invite/remove`, `issuer set`, `keys challenge/add/transition` |

Creation tools take or auto-generate an idempotency key; mutations on existing
resources resolve the current ETag when none is passed; destructive operations
require an explicit `--confirm-*` flag matching the target (or a TTY prompt).
`keys add` accepts only a public JWK plus a compact-JWS possession proof —
private key material is never a valid input.

## Testing

```powershell
pnpm --filter @unicas/admin-cli test
pnpm --filter @unicas/admin-cli typecheck
pnpm exec vitest run tests/unit/workspace/package-deps.test.mjs
```

Unit tests mock the discovery/token/registration/revocation endpoints and a
stateless MCP server; they never touch production. A real
`unicas login` + `unicas whoami` against `https://unicas.shazhou.work/mcp` is a
manual verification step (browser Google sign-in + Unicas consent required).
