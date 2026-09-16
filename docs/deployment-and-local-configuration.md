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

Set secrets before `pnpm stack:deploy unicas`. `wrangler secret put` prompts for
the value, so it does not need to appear in the command line:

```powershell
pnpm --filter @unicas/service-cloudflare exec wrangler secret put CAS_AUDIT_READER_KEY
pnpm --filter @unicas/service-cloudflare exec wrangler secret put GOOGLE_OIDC_CLIENT_SECRET
pnpm --filter @unicas/service-cloudflare exec wrangler secret put SESSION_ENCRYPTION_KEYS
pnpm --filter @unicas/service-cloudflare exec wrangler secret put OAUTH_STATE_ENCRYPTION_KEY
pnpm --filter @unicas/service-cloudflare exec wrangler secret put ADMIN_EMAIL_ALLOWLIST
```

The admin CLI logs in through the BFF (`/admin/auth/cli/authorize`): the BFF
runs the Google OIDC flow with its own confidential client (secret held
server-side in `GOOGLE_OIDC_CLIENT_ID`/`GOOGLE_OIDC_CLIENT_SECRET`) and the
existing email allowlist, then redirects the browser to the CLI's loopback
with a one-time code that the CLI exchanges for a BFF session
(`/admin/auth/cli/exchange`). The CLI never talks to Google and needs no
client id, secret, or environment value; only `UNICAS_ADMIN_URL` (defaults to
the production origin).

Session keys are a JSON map such as
`{"2026-08":"<base64url-32-byte-key>"}`. Non-secret hostnames, routes,
D1/R2/KV/DO bindings, and policy values remain in
`unicas-packages/service-cloudflare/wrangler.toml`.

### Cloudflare UniDocs secrets

UniCAS accepts downstream public HTTPS OAuth issuers without a platform domain
allowlist. `CAS_OAUTH_DISCOVERY_ALLOWED_ORIGINS` is optional: unset/blank enables
public discovery; a nonblank comma-separated list restricts origins. The deployment
must retain `global_fetch_strictly_public` and use global fetch, not private network
bindings, for metadata and JWKS. See [discovery policy and issuer migration](cas-oauth-discovery-and-issuer-migration.md)
for the network boundary and the prerequisites for moving existing Gateway issuers.

There are two ES256 identities:

- The Gateway capability key signs Gateway-to-Doc capabilities. Gateway gets
  `CAPABILITY_PRIVATE_KEY_PKCS8`; Docs get `CAPABILITY_TRUSTED_JWKS`.
- The UniCAS stack issuer key signs CAS capabilities. Gateway gets
  `CAS_STACK_PRIVATE_KEY_PKCS8`; its public JWK is served at the Gateway's
  OAuth `jwks_uri`. Doc workers verify the delegated
  CAS capability against the stack issuer + **live discovered JWKS**: set
  `CAS_STACK_JWKS_URI` to the stack issuer's `jwks_uri` (unknown-`kid`
  refresh is automatic), or to `"discover"` to derive it via RFC 8414 from
  `CAS_STACK_ISSUER`. Without it, docs fall back to the pinned
  `CAS_STACK_TRUSTED_JWKS` snapshot (required for non-URL dev issuers).

Set these Gateway secrets:

```text
DOC_SERVICES_JSON
CAPABILITY_ISSUER
CAPABILITY_KEY_ID
CAPABILITY_PRIVATE_KEY_PKCS8
CAS_STACK_PRIVATE_KEY_PKCS8
```

Production user identity for the data plane uses the Gateway's own OAuth
access tokens: every `/tenants/*` request must present a Bearer token issued
by the Gateway OAuth flow, validated against `GATEWAY_OAUTH_ISSUER` and the
stack JWKS. Browser login runs through an upstream OIDC provider (Google by
default). Set these Gateway secrets:

```text
GATEWAY_OIDC_CLIENT_ID           upstream OIDC client id
GATEWAY_OIDC_CLIENT_SECRET       upstream OIDC client secret
GATEWAY_SESSION_ENCRYPTION_KEY   base64 32-byte key sealing session cookies
```

`GATEWAY_PUBLIC_ORIGIN` (the app/webui origin where the OAuth authorization
surface is served, e.g. `https://unidocs.shazhou.work`), `GATEWAY_OIDC_ISSUER`
(default `https://accounts.google.com`), `GATEWAY_OIDC_REDIRECT_PATH`, and
`GATEWAY_OIDC_SESSION_TTL_SECONDS` are plain vars. The upstream OIDC client's
redirect URI must include `{GATEWAY_PUBLIC_ORIGIN}{GATEWAY_OIDC_REDIRECT_PATH}`
(for the current deployment:
`https://unidocs.shazhou.work/oauth/unidocs-cloudflare/login/callback`). The
issuer claim in issued tokens keeps the registered identifier
(`GATEWAY_OAUTH_ISSUER`); the endpoints themselves are served on the app
origin too. Tenant membership is seeded into the Gateway D1
`gateway_oauth_tenant_memberships` table (one row per `(principal_id,
tenant_id)` with `scopes_json` and optional `ref_domain`); the user's
`principalId` is the upstream OIDC subject (`sub`). Each Google account maps
1:1 to one tenant: an authorize request without a client-supplied `tenant_id`
is resolved server-side from that membership, and the data-plane token carries
the resolved `tenantId` (the webui never asks the user for a tenant).

Set these on each of `@unidocs/cloudflare-markdown`,
`@unidocs/cloudflare-docx`, and `@unidocs/cloudflare-psd`:

```text
CAPABILITY_ISSUER
CAPABILITY_TRUSTED_JWKS
```

with the non-secret vars `CAS_STACK_JWKS_URI` (the stack issuer's `jwks_uri`,
or `"discover"`), `DOC_CAPABILITY_AUDIENCE`, `CAS_CAPABILITY_AUDIENCE`,
`CAS_STACK_ID`, `CAS_STACK_ISSUER`, and the capability policy vars already in
each package's `wrangler.toml`.

`SERVICE_ACCESS_KEY` / `INTERNAL_AUTH_MODE` belonged to the retired legacy runtime
and are gone from the codebase. PSD chat additionally accepts `LLM_API_KEY`,
`LLM_BASE_URL`, and `LLM_MODEL`; store the API key as a Worker secret.

`INSECURE_PATH_IDENTITY=true` remains a local-development-only opt-in; it is
never set in production (production data-plane requests fail closed without a
valid access token).

### PSD fonts

`setText` needs a font index: PSD text layers record a font *name*, never the
font file. The index has two sources, merged by `createFontRegistry`
(`packages/doctype-server-common/src/font-registry.ts`) in that order:

1. **Built-in, shipped inside the package** — `@unidocs/fonts-builtin` carries
   the full Noto Sans (Latin) plus a Noto Sans SC subset covering the 8,105
   characters of 《通用规范汉字表》. Nothing to configure: a brand-new
   environment and a brand-new tenant can run `setText` on day one.
2. **Tenant-registered, seeded by an operator** — optional extras on top.

Later sources win by `postScriptName`, so registering a font under a built-in
name **replaces** it. That is the supported way to swap the CJK subset for the
full `NotoSansSC-Regular`: 30,890 code points against the subset's 8,618 (the
8,105 表 characters plus Latin and punctuation), i.e. Hong Kong/Taiwan glyph
variants, the extension blocks and rare characters.

#### Seeding extra fonts (optional)

`scripts/seed-psd-fonts.mjs` writes the bytes into CAS and registers the parsed
metadata (`unitsPerEm`, `coverage`) into the tenant's `PsdFonts` Durable Object
(Cloudflare) or `font_registry` table (Azure). It is the only entry point for
source 2, and it never touches source 1. Usage, config shape, and the reasoning
live in that file's header comment; `scripts/psd-fonts.example.json` is a
working example. **Skipping it no longer breaks anything** — you lose the extra
glyphs, not `setText`.

Three deployment facts:

- **It does not go through the Gateway.** `matchGatewayRoute` only knows
  `/tenants/{t}/docs/…` and `/tenants/{t}/cas/…`, and CAS root-refs writes are
  deliberately not proxied. The script therefore talks straight to the PSD
  Worker and the CAS service, and needs both signing keys that the deployment
  contract otherwise keeps on the Gateway alone
  (`CAPABILITY_PRIVATE_KEY_PKCS8`, `CAS_STACK_PRIVATE_KEY_PKCS8`). Run it where
  those keys are available and the PSD Worker is reachable. It is an operator
  tool, not an end-user endpoint.
- **Write access reuses the tenant-scoped `sessions:create` permission**
  (ruling R41): anyone who can create a session for a tenant can register fonts
  for it. Deliberate (fonts are additive and never mutate existing documents),
  but do not assume stronger protection.
- **Full font binaries are never committed** (ruling R19, narrowed 2026-09-08 to
  "only subsets with a documented public character list, under about 3 MiB per
  file"). The config holds local paths; the repository-root `fonts/` directory is
  gitignored. Noto Sans / Noto Sans SC are OFL-licensed and available from Google
  Fonts. The built-in set under `packages/fonts-builtin/fonts/` is committed on
  purpose — that is what the narrowing bought: it ships inside the package, so
  seeding is optional rather than a prerequisite.

The script refuses any font over 16 MiB (`MAX_FONT_BYTES`, matching the editor
DO's `MAX_SVALUE_ROOT_BYTES`), and several `notofonts/noto-cjk` files that all
answer to "Noto Sans SC" sit on both sides of that line. Take
`Sans/SubsetOTF/SC/NotoSansSC-Regular.otf` (8,331,336 bytes, PostScript name
`NotoSansSC-Regular`); `Sans/OTC/NotoSansCJK-Regular.ttc` (19,484,784 bytes) is
over the limit, and the language-specific OTF (16,437,364 bytes) clears it by
only ~0.3 MB. Sizes measured 2026-09-03 against `main`; there is no subsetting
tool in this repository, so picking the right file up front is the whole story.

`POST /tenants/{t}/fonts` is a neutral route both stacks mount, so one script
seeds either one — point it at the doc service you mean.

#### `PSD_FONT_FALLBACKS`

The PSD service's `PSD_FONT_FALLBACKS` var (comma-separated, order is priority)
decides which indexed fonts are tried for a code point the layer's own font does
not cover. `parseFontFallbacks`
(`packages/doctype-psd/src/text/font-fallbacks.ts`) distinguishes three states,
and the difference matters:

| State | Chain |
| --- | --- |
| **unset** | `BUILTIN_FALLBACKS` — the two built-in faces. This is the default you want. |
| explicit empty string | empty chain: nothing is tried. An escape hatch, not a default — it is what leaves a CJK layer with no glyphs at all. |
| a list of names | exactly those, in order. Names not present in the index are skipped silently. |

Because seeding a same-named font replaces the built-in one, installing the full
`NotoSansSC-Regular` needs no config change at all. Set this var only to reorder
priority or to point at a font registered under a different name.

Neither stack sets it by default: `packages/cloudflare-psd/wrangler.toml`
deliberately omits the line, and Azure's `service.bicep` skips the env entry when
`--psd-font-fallbacks` is not passed. Override per-developer in
`packages/cloudflare-psd/.dev.vars` on Cloudflare — that is the only door, since
the process-environment layer that outranks `.dev.vars` passes through just
`LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`, so a shell `PSD_FONT_FALLBACKS`
does nothing there. Azure has no bindings layer at all, so set it in the process
environment instead — the shell, or `.env.azure`
(`loadAzureDevEnv` folds that file into `process.env`, shell wins), which
`spawnService` then spreads onto every doc service.

#### Local development

`pnpm dev` (psd selected) additionally seeds the **full** Noto Sans, Noto Sans
SC and Josefin Sans Bold into tenant `u1` on **both** stacks: it reads the tenant
index on startup and downloads only what is missing. Two reasons it still exists
now that the built-ins ship: the sample PSDs name `JosefinSans-Bold` by hand, and
the full `NotoSansSC` adds ~22k code points over the built-in subset. It does not
touch `PSD_FONT_FALLBACKS` — the first two use the built-in names, so the default
chain resolves to the seeded full faces on its own. See
`scripts/psd-font-bootstrap.mjs` and `docs/psd-text-layers.md` §5.4. Opt out with
`--fonts off` (or `UNIDOCS_PSD_FONTS=off`). A failure there only warns; it never
blocks startup.

`UNIDOCS_BUILTIN_FONTS_DIR` overrides where the Azure-side loader
(`packages/azure-psd/src/builtin-fonts.ts`) looks for the built-in font bytes; it
falls back to `require.resolve("@unidocs/fonts-builtin/package.json")`. **The
local Azure stack cannot use that fallback.** pnpm does not hoist workspace links
to the repository root, so once `stacks/unidocs-azure/local/runtime.mjs`
esbuild-bundles each service into `.azure-runtime/bundles/`, the resolve runs
from outside `packages/azure-psd/` and throws `MODULE_NOT_FOUND`. Resolution is
lazy, so the service still starts — the failure lands on the first `setText`
instead, as an error naming `@unidocs/fonts-builtin`. `spawnService` injects the
var automatically, so you set it by hand only when running a bundle from some
other location. Production images do not need it: `pnpm deploy --prod` produces a
real (non-symlink) `node_modules` with the entry point inside the package.

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
cas-stack-private-key-pkcs8    Azure stack issuer private key, Gateway only
cas-stack-trusted-jwks         Azure stack issuer public JWKS, Docs only
```

<!-- cas-contract-docs: migration-start -->
Use `az keyvault secret set --vault-name unidocs-kv --name <name>` through an
approved secret-input process. Values are intentionally not accepted as deploy
arguments or printed. `cas-access-key` / `--cas-access-key` remain optional for
a bounded legacy rollout only; stack mode neither requires nor reads them.
<!-- cas-contract-docs: migration-end -->

Non-secret deployment selection is passed as arguments, for example:

```text
pnpm stack:deploy unidocs-azure --subscription <id> --resource-group <name> \
  --location <region> --cas-base-url https://unicas.shazhou.work \
  --capability-key-id <gateway-kid> \
  --cas-stack-id cas_<control-plane-generated-id> \
  --cas-stack-issuer https://unicas.shazhou.work/issuer/azure \
  --cas-stack-key-id <issuer-jwks-kid> \
  --cas-capability-audience unidocs-cas-azure \
  --cas-ref-domain doc
```

The stack private key must match a public JWK advertised by the discovered
issuer `jwks_uri`. The stack ID is an opaque value generated by the control
plane and must match `/^cas_[A-Za-z0-9_-]{8,64}$/`;
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
from the gitignored `.wrangler/unidocs/stack.json`. Register the stack through
the UniCAS admin CLI and connect its Stack OAuth issuer, then write this shape
locally:

```json
{
  "stackId": "unidocs-dev-<developer>",
  "issuer": "<registered issuer>",
  "audience": "<registered CAS audience>",
  "kid": "<issuer JWKS key id>",
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
| `UNIDOCS_DEV_LOG` | `.dev-cloudflare.log` | Where `pnpm dev` writes its JSONL log (relative to the repo root; absolute paths accepted). `off` disables it. See [observability.md](observability.md#本地日志文件) |
| `LLM_API_KEY` | unset | PSD Operator credential |
| `LLM_BASE_URL` | provider default | PSD provider endpoint |
| `LLM_MODEL` | provider default | PSD model |

`pnpm dev` also writes a `local-credentials.json` (mode 0600) on every start:
the local runtime's two signing keys are generated per run and live only in that
process, so tools that bypass the Gateway (currently `scripts/seed-psd-fonts.mjs`)
have no other way to mint a credential. Each stack writes its own file —
`.wrangler/unidocs/local-credentials.json` for Cloudflare,
`.azure-runtime/local-credentials.json` for Azure — because both stacks can run
at once and a shared path would silently seed the wrong one. The path used for
this run is printed at startup. It is a private key file — gitignored, never
committed.

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

### Tenant console sign-in (`pnpm dev portal`)

The tenant console at `/portal/` needs a tenant session. The tenant plane is
self-service: any Google account can sign in through `/portal/auth/login`, and
a first-time identity is provisioned its own, brand-new tenant on the spot —
`PORTAL_BOOTSTRAP_EMAIL` is **not** required to sign in to the tenant console;
it only designates the first administrator (see below). Locally there are two
ways to get a tenant session:

- **Real Google sign-in (default).** Set the Google client in
  `packages/cloudflare-portal/.dev.vars`. Any Google account can now sign in
  through `/portal/auth/login` and lands in its own tenant. If
  `PORTAL_BOOTSTRAP_EMAIL` is also set, the seed additionally adds that
  address as a member of tenant `t-local` on every boot, purely for
  convenience: it gives that one address a stable, known tenant id (`t-local`)
  across restarts instead of a fresh one each time the local database is
  reset. The Google client must list the loopback callback
  `http://127.0.0.1:<portal port>/portal/auth/callback`.
- **Dev session switch.** Set `PORTAL_TENANT_DEV_SESSION=true` in the same file.
  Any visit without a session cookie is handed a `t-local` / `user-local`
  session. It only works on a loopback `PORTAL_ORIGIN`, and "sign out" does not
  stick while it is on.

Documents written under the dev session belong to `user-local`; signing in with
Google provisions or resumes a different principal, in its own tenant (or in
`t-local` when it was pre-seeded as above), which sees every document in that
tenant.

An administrator can still invite a specific email into an existing tenant
through `POST /admin/api/v1/tenant-members` — that account then joins the
invited tenant on its next sign-in instead of getting a new one. This is
useful for putting several people into one shared tenant; it is no longer
required for anyone to be able to sign in at all.

### Tenant console go-live in production

`wrangler.production.jsonc` routes `/portal`, `/portal/*`, and
`/api/v1/tenants/*` to the portal worker, but sign-in and document creation
only work once the data plane is configured. Do these in order before anyone
is invited:

1. In Google Cloud Console, add
   `https://unidocs.shazhou.work/portal/auth/callback` as an authorized
   redirect URI for `GATEWAY_OIDC_CLIENT_ID`. Without it every callback fails.
2. Configure the tenant's UniCAS values and set the portal secrets:
   `CAS_ORIGIN`/`CAS_STACK_ID`/`CAS_ISSUER`/`CAS_AUDIENCE`/`CAS_REF_DOMAIN`/
   `CAS_SIGNING_KID` as `vars`, then `wrangler secret put AGENT_API_TOKEN` and
   `wrangler secret put CAS_SIGNING_KEY` on the portal worker.
3. Give the production markdown worker its side of the Operator loop:
   `PLATFORM_SERVICE` service binding to `unidocs-portal`, `PLATFORM_ORIGIN`,
   `PLATFORM_AGENT_TOKEN` (same value as the portal's `AGENT_API_TOKEN`), and
   `OPERATOR_CAS_*` for the Operator's own UniCAS credentials.
4. Apply the D1 migrations — `wrangler deploy` does not do this for you:

   ```powershell
   pnpm --filter @unidocs/cloudflare-portal exec wrangler d1 migrations apply unidocs-portal --remote
   ```

5. Deploy the markdown worker first, then the portal worker, so the Operator
   loop is ready before the new routes go live.
6. Have anyone with a Google account sign in at `/portal/auth/login` — the
   tenant plane is self-service, so this alone provisions them a tenant. To
   put someone into an existing tenant instead, invite them first through the
   admin API (`POST /admin/api/v1/tenant-members`).
7. Create a document as that member and confirm the Operator produces its
   first version.
8. Spot-check that `/ui/*` and `/tenants/*` still reach the gateway worker —
   the new routes are more specific and should not have taken anything from
   its catch-all, but this is the moment to confirm it.

Every tenant can go live in the same deploy: the Agent bearer authenticates
for whichever tenant its request path names, not a single preconfigured one.
That is a deliberate trade-off — see "Agent credential: shared token, widened
scope" in the design spec — not a narrowing of who the token can act for.

## Local UniCAS configuration

`pnpm dev unicas` uses a mock OIDC provider by default. To use Google locally,
set `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET`, and optionally
`GOOGLE_OIDC_ISSUER`; register
`http://localhost:4070/admin/auth/callback` as the redirect URI. Docker Compose
forwards the same variables. `UNIDOCS_CAS_ADMIN_ORIGIN` defaults to
`http://localhost:4070`.
