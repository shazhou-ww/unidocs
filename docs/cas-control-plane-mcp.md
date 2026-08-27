# CAS Control-Plane MCP

The private `@unicas/control-plane-mcp` Worker exposes the Unicas control plane
to GitHub Copilot and other remote MCP clients at:

```text
https://unicas.shazhou.work/mcp
```

`cas-edge` is the only public Worker. It forwards an exact allowlist of `/mcp`,
OAuth discovery, authorization, token, and registration paths to the private MCP
Worker. It does not expose an arbitrary `/oauth/*` prefix. A present browser
`Origin` on `/mcp` must exactly match the configured `CAS_PUBLIC_ORIGIN`; requests
without `Origin` remain valid for non-browser MCP clients.

## GitHub Copilot configuration

No API key or OAuth client secret belongs in MCP configuration:

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

On first use, the client discovers Unicas OAuth, opens Google sign-in, and shows
the Unicas consent page. The resulting access and refresh tokens are Unicas
tokens. Google tokens are discarded after identity verification and are never
accepted by `/mcp`.

## Authorization scopes

| Scope | Operations |
| --- | --- |
| `control:read` | Identity, stacks, membership, public issuer configuration, observed refDomains, and audit reads |
| `control:write` | Stack creation and stack metadata updates |
| `control:security` | Member invitation/removal and issuer/key lifecycle operations |

Scopes do not imply each other. Current stack membership is checked during each
tool call, so removing a member takes effect without waiting for token expiry.
`ADMIN_EMAIL_ALLOWLIST`, when configured, is also checked during every MCP call.

Access tokens expire after 15 minutes. Refresh grants expire after 8 hours and
refresh tokens rotate. Tokens are audience-bound to the canonical `/mcp`
resource. The token endpoint also implements RFC 7009 revocation.

## Tools

Read tools:

- `whoami`
- `list_stacks`
- `get_stack`
- `list_members`
- `get_issuer`
- `list_issuer_keys`
- `list_ref_domains`
- `list_control_audit_events`
- `list_root_domain_refs`
- `list_root_domain_events`

Ordinary write tools:

- `create_stack`
- `update_stack`

Security tools:

- `invite_member`
- `remove_member`
- `set_issuer`
- `create_issuer_key_challenge`
- `add_issuer_key`
- `transition_issuer_key`

The possession-challenge tool is required because `add_issuer_key` accepts only
public JWK material and a compact-JWS proof made with the private key. Private key
material is never a valid MCP input.

Creation tools require an idempotency key. Existing-resource mutations require a
current ETag. Member invitations are email-bound and require the email twice.
Member removal and key/issuer transitions require explicit target confirmation.
Destructive annotations are advisory metadata; the server always
enforces scopes, membership, ETags, confirmations, and service invariants.

`list_ref_domains` is an audit discovery tool. It lists domains observed in
successful Root Ref writes; domains are not pre-registered or lifecycle-managed
through MCP.

## Worker configuration

Required bindings:

```text
CAS_CONTROL_DB             shared Unicas control D1
OAUTH_KV                   dedicated OAuth clients/grants/token hashes
CAS_TENANT_AUDIT_READER    private Root Ref audit-reader service
```

Required secrets:

```text
GOOGLE_OIDC_CLIENT_ID
GOOGLE_OIDC_CLIENT_SECRET
OAUTH_STATE_ENCRYPTION_KEY   base64url-encoded 32-byte AES key
```

Variables:

```text
PUBLIC_ORIGIN=https://unicas.shazhou.work
MCP_MUTATIONS_ENABLED=true
MCP_ALLOWED_ORIGIN_HOSTNAMES=
ADMIN_EMAIL_ALLOWLIST=...       optional, same policy as CAS Admin
OIDC_ISSUER=...                 optional, defaults to Google
OIDC_DISCOVERY_URL=...          optional test/local override
CAS_AUDIT_READER_KEY=...        required when the private reader enforces it
```

`MCP_MUTATIONS_ENABLED` is the emergency and rollout kill switch. An absent or
non-`true` value fails closed; read tools remain available while all
write/security handlers reject mutations. Production enables it explicitly
after read-only telemetry and cross-stack
isolation checks pass.

Replace the zero placeholder `OAUTH_KV` ID in
`unicas-packages/control-plane-mcp/wrangler.toml` before deployment. OAuth KV is
not a control-data backup: business state remains in `CAS_CONTROL_DB`. KV stores
client registrations, grants, and token hashes; deleting a client or revoking a
grant invalidates its tokens.

## Build and validation

```text
pnpm --filter @unicas/control-auth test
pnpm --filter @unicas/control-plane-mcp test
pnpm --filter @unicas/control-plane-mcp typecheck
pnpm --filter @unicas/control-plane-mcp build
pnpm --filter @unicas/control-plane-mcp exec wrangler deploy --dry-run
pnpm --filter @unicas/edge test
pnpm --filter @unicas/control-plane test
pnpm --filter @unicas/admin-webui test
```

The release gate additionally requires a real GitHub Copilot flow through the
custom domain: discovery, Google login, consent, `whoami`, a paginated read,
refresh, revoke, and reauthorization. A manually injected bearer token does not
replace that test.

## Rollout and incident response

1. Create the dedicated production OAuth KV namespace and replace its binding ID.
2. Register `https://unicas.shazhou.work/oauth/google/callback` with Google.
3. Set Worker secrets and deploy the private MCP Worker.
4. Deploy edge with `CAS_MCP_SERVICE`, leaving mutations disabled.
5. Validate OAuth discovery and read tools from GitHub Copilot.
6. Observe authorization failures, scope/member denials, D1/KV errors, and audit
   attribution before enabling mutations.
7. Enable ordinary and security operations in a controlled maintenance window.

For suspected token theft, keep mutations disabled, revoke the affected grant or
delete the OAuth client, and review `cas_control_audit_events` by client handle
and tool name. Rotate Google credentials or the state-encryption key only through
Worker secret management. Rotating the state key invalidates in-flight login and
consent transactions but does not decrypt or expose existing OAuth tokens.