# Deployment and local configuration

This repository keeps three kinds of configuration separate:

1. Deployment identity authenticates Wrangler or Azure CLI to the provider.
2. Runtime secrets are stored by Cloudflare Workers or Azure Key Vault.
3. Local settings come from the current process, gitignored files, or Docker
   Compose interpolation.

Never commit tokens, private keys, `.dev.vars`, `.env`, or `.wrangler/`.

## Cloudflare deployment identity

Wrangler reads these variables from the process running the stack command:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
$env:CLOUDFLARE_API_TOKEN = "<api-token>"
pnpm exec wrangler whoami
```

Use a dedicated token per developer or CI environment. The token needs Account
Workers Scripts Edit for deploy/secrets, D1 Edit for migrations, R2 Edit when
provisioning buckets, and Zone Workers Routes Edit for the UniCAS custom route.
Scope it to the specific account and `shazhou.work` zone. Store CI values in the
CI secret store and project them into these two environment variables.

Current Wrangler files contain the production resource IDs and base names.
There are no `[env.staging]` sections yet, so do not pass `--env staging` until
that environment and its isolated D1/R2/Worker names have been declared.

### UniCAS Worker secrets

Set secrets before `pnpm run deploy unicas`. `wrangler secret put` prompts for
the value, so it does not need to appear in the command line:

```powershell
pnpm --filter @unicas/server-cloudflare exec wrangler secret put CAS_AUDIT_READER_KEY
pnpm --filter @unicas/admin-webui exec wrangler secret put CAS_AUDIT_READER_KEY
pnpm --filter @unicas/admin-webui exec wrangler secret put GOOGLE_OIDC_CLIENT_ID
pnpm --filter @unicas/admin-webui exec wrangler secret put GOOGLE_OIDC_CLIENT_SECRET
pnpm --filter @unicas/admin-webui exec wrangler secret put ADMIN_EXCHANGE_CLIENT_ID
pnpm --filter @unicas/admin-webui exec wrangler secret put SESSION_ENCRYPTION_KEYS
```

`ADMIN_EXCHANGE_CLIENT_ID` is the Google OAuth client id of the **admin CLI**
(an "Desktop app" client, separate from the browser-login
`GOOGLE_OIDC_CLIENT_ID`). It enables `POST /admin/auth/exchange`, which
`unicas login` uses to turn its own Google id_token into a `/admin` BFF
session. Create it in Google Cloud Console as a Desktop application client
(loopback redirect, public client, PKCE) and register the same id in the
CLI's environment as `UNICAS_GOOGLE_CLIENT_ID`. When `ADMIN_EXCHANGE_CLIENT_ID`
is unset, `/admin/auth/exchange` responds 501 and `unicas login` cannot
complete.

Use the same random `CAS_AUDIT_READER_KEY` on tenant and admin. Session keys are
a JSON map such as `{"2026-08":"<base64url-32-byte-key>"}`. The edge Worker
has no runtime secret. Non-secret hostnames, routes, D1/R2 bindings, and policy
values remain in each package's `wrangler.toml`.

### Cloudflare UniDocs secrets

There are two ES256 identities:

- The Gateway capability key signs Gateway-to-Doc capabilities. Gateway gets
  `CAPABILITY_PRIVATE_KEY_PKCS8`; Docs get `CAPABILITY_TRUSTED_JWKS`.
- The registered UniCAS stack key signs CAS capabilities. Gateway gets
  `CAS_STACK_PRIVATE_KEY_PKCS8`; its public JWK is registered in UniCAS and
  projected to Docs as `CAS_STACK_TRUSTED_JWKS`.

Set these Gateway secrets:

```text
DOC_SERVICES_JSON
CAPABILITY_ISSUER
CAPABILITY_KEY_ID
CAPABILITY_PRIVATE_KEY_PKCS8
CAS_STACK_PRIVATE_KEY_PKCS8
```

Set these on each of `@unidocs/cloudflare-markdown`,
`@unidocs/cloudflare-docx`, and `@unidocs/cloudflare-psd`:

```text
CAPABILITY_ISSUER
CAPABILITY_TRUSTED_JWKS
CAS_STACK_TRUSTED_JWKS
```

`SERVICE_ACCESS_KEY` is retired compatibility configuration and is not needed
in `INTERNAL_AUTH_MODE=stack`. PSD chat additionally accepts `LLM_API_KEY`,
`LLM_BASE_URL`, and `LLM_MODEL`; store the API key as a Worker secret.

The application deploy remains blocked until Gateway has a production user
identity resolver. Dry-run is available now:

```text
pnpm run deploy unidocs-cloudflare --dry-run
```

## Azure deployment identity and secrets

The Azure deploy script uses the active `az` CLI identity. For interactive use:

```powershell
az login
az account set --subscription <subscription-id>
```

For CI, prefer Azure workload identity federation and run `az login` with that
federated identity. Do not create a repository `.env` containing a long-lived
client secret. The deployer needs the resource-group deployment permissions
used by the Bicep templates plus Key Vault Secrets Officer on `unidocs-kv`.

The script creates or reuses these Key Vault values:

```text
pg-admin-password
markdown-access-key
docx-access-key
psd-access-key
```

Provision these before capability deployments:

```text
capability-private-key-pkcs8   Gateway private key
capability-trusted-jwks        Doc public JWKS
cas-stack-private-key-pkcs8    Registered Azure stack private key, Gateway only
cas-stack-trusted-jwks         Registered Azure stack public JWKS, Docs only
```

<!-- cas-contract-docs: migration-start -->
Use `az keyvault secret set --vault-name unidocs-kv --name <name>` through an
approved secret-input process. Values are intentionally not accepted as deploy
arguments or printed. `cas-access-key` / `--cas-access-key` remain optional for
a bounded legacy rollout only; stack mode neither requires nor reads them.
<!-- cas-contract-docs: migration-end -->

Non-secret deployment selection is passed as arguments, for example:

```text
pnpm run deploy unidocs-azure --subscription <id> --resource-group <name> \
  --location <region> --cas-base-url https://unicas.shazhou.work \
  --capability-key-id <gateway-kid> \
  --cas-stack-id cas_<control-plane-generated-id> \
  --cas-stack-issuer https://unicas.shazhou.work/cas/issuer/azure \
  --cas-stack-key-id <registered-stack-kid> \
  --cas-capability-audience unidocs-cas-azure \
  --cas-ref-domain doc
```

The stack private key and public JWKS must be the pair registered in UniCAS
under the same stack ID, issuer, and key ID. The stack ID is an opaque value
generated by the control plane and must match `/^cas_[A-Za-z0-9_-]{8,64}$/`;
it is not the human-readable `unidocs-azure` stack selector.

## Local UniDocs configuration

Interactive development defaults to an embedded ephemeral UniCAS, so a fresh
clone needs no configuration at all:

```text
pnpm dev                      # = pnpm dev unidocs-cloudflare
pnpm dev unidocs-azure
```

The stack name is optional for `dev` only, and only when the first argument is
not itself a stack name; `deploy` and `smoke` always require one, because
silently deploying to a guessed stack is not acceptable.

`--cas remote` switches to a UniCAS edge and reads a developer stack credential
from the gitignored `.wrangler/unidocs/stack.json`. Obtain the stack
registration and private key through the UniCAS admin/possession-proof flow,
then write this shape locally:

```json
{
  "stackId": "unidocs-dev-<developer>",
  "issuer": "<registered issuer>",
  "audience": "<registered CAS audience>",
  "kid": "<registered key id>",
  "privateKeyPkcs8": "<PKCS8 PEM>",
  "jwks": { "keys": [{ "kid": "<key id>", "kty": "EC", "crv": "P-256" }] },
  "refDomains": [
    { "refDomain": "doc", "status": "active" },
    { "refDomain": "asset", "status": "active" }
  ]
}
```

Optional process variables:

| Variable | Default | Purpose |
|---|---|---|
| `UNIDOCS_CAS_MODE` | `local` | `remote` or `local` |
| `UNIDOCS_CAS_ORIGIN` | `https://unicas.shazhou.work` | UniCAS edge origin used by `--cas remote`; may point at a locally running `pnpm dev unicas` |
| `UNIDOCS_CAS_STACK_CREDENTIAL` | `.wrangler/unidocs/stack.json` | Credential path |
| `UNIDOCS_LOCAL_HOST` | `127.0.0.1` | Local bind host |
| `LLM_API_KEY` | unset | PSD Operator credential |
| `LLM_BASE_URL` | provider default | PSD provider endpoint |
| `LLM_MODEL` | provider default | PSD model |

Command-line `--cas remote` overrides the default. It does not silently fall
back to local when the credential is missing or the edge is unreachable — it
fails and says which:

```text
pnpm dev --cas remote
pnpm dev unidocs-azure --cas remote
```

For host execution, PSD settings may instead be placed in the gitignored
`packages/cloudflare-psd/.dev.vars`, using its committed `.dev.vars.example`.
Docker execution receives the listed variables from the host and mounts the
repository `.wrangler/` directory so local state and the credential are visible:

```text
pnpm dev unidocs-cloudflare --docker
```

## Local UniCAS configuration

`pnpm dev unicas` uses a mock OIDC provider by default. To use Google locally,
set `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET`, and optionally
`GOOGLE_OIDC_ISSUER`; register
`http://localhost:4070/admin/auth/callback` as the redirect URI. Docker Compose
forwards the same variables. `UNIDOCS_CAS_ADMIN_ORIGIN` defaults to
`http://localhost:4070`.
