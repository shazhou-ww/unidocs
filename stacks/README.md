# Stack registry

Each first-level directory is one independently runnable and deployable stack.
The directory name is its CLI selector; provider is an implementation detail,
not the first classification level.

```text
stacks/
  unicas/
  docs/
  unidocs-cloudflare/
  unidocs-azure/
```

Every stack exposes the same entries:

```text
stacks/<stack>/local/dev.mjs
stacks/<stack>/deploy/deploy.mjs
stacks/<stack>/deploy/smoke.mjs
```

The root dispatcher maps commands directly to those files:

```text
pnpm dev <stack> [...args]
pnpm stack:deploy <stack> [...args]
pnpm smoke <stack> [...args]
```

The deploy script is named `stack:deploy`, not `deploy`, and must stay that
way. A script in the workspace ROOT that shares a name with a pnpm built-in
overrides that built-in everywhere in the repo — pnpm refuses to run the
built-in even from a subdirectory (`ERR_PNPM_SCRIPT_OVERRIDE_IN_WORKSPACE_ROOT`),
and there is no flag to opt out. `stacks/unidocs-azure/deploy/Dockerfile` needs
the built-in `pnpm deploy` to prune one workspace package into a deployable
`/out`, so the root must leave that name alone. (pnpm 10 resolved the clash the
other way — built-in wins — which is why a root `deploy` script looked harmless
when it was added and only broke the image build later.)
`tests/unit/scripts/root-script-names.test.mjs` pins this.

## Local execution

`local/dev.mjs` is the stable interface. Its implementation may use Node,
Miniflare, Docker Compose, or a combination. Cloudflare-based stacks accept
`--docker` to run their complete local runtime in Compose:

```text
pnpm dev unicas --docker
pnpm dev unidocs-cloudflare --docker
```

The Azure runtime already uses Docker Compose for Postgres and runs application
processes on the host, so `pnpm dev unidocs-azure --docker` is equivalent to its
normal local command.

Interactive UniDocs development defaults to an embedded, hermetic UniCAS — the
same mode automated tests use. Pass `--cas remote` for a UniCAS edge, which
needs a registered stack credential.

## The portal dev target

`pnpm dev` selects *targets* positionally. A target is usually a document type,
but `portal` is a **service** target — it is not a document type, does not
appear in the gateway registry, and does not participate in `docType` routing,
which is why the terminal announces it on its own `Services:` line:

```text
pnpm dev portal          # the portal alone, on http://127.0.0.1:8795
pnpm dev portal psd      # the portal and the psd document type together
```

Mixing the two kinds is the point; `pnpm dev portal psd` prints both a
`Static registrations: psd` line and a `Services: portal` line. Either line is
omitted entirely when its list is empty, so `pnpm dev portal` shows no
`Static registrations:` line at all — an empty list would read as "started and
failed".

`portal` is an **umbrella target**, not a single process, but today everything
it owns runs inside one worker:

```text
http://127.0.0.1:8795/admin/    administrator console (packages/admin-portal-webui)
http://127.0.0.1:8795/portal/   tenant console        (packages/tenant-portal-webui)
http://127.0.0.1:8796/          type-card bundle objects
```

Neither WebUI is a Vite dev server of its own. `pnpm --filter
@unidocs/cloudflare-portal build:webui` builds both and writes them into
`src/ui-assets.generated.ts` and `src/tenant-ui-assets.generated.ts`, which the
worker serves from its own origin. That is not a packaging preference: the
admin OAuth callback is pinned to `PORTAL_ORIGIN`, so a UI on another port
would be cut out of the login round trip. **Rebuild after changing either
WebUI** — the running worker serves the generated files, not your sources.

Port 8796 is a second port on the same worker, not a second worker.
`worker.ts` decides a request is a bundle fetch by comparing its origin against
`BUNDLE_ORIGIN`, so the two must differ; in production it is a separate
hostname.

Two things are still missing behind the tenant console. It renders against an
in-memory fixture (`tenant-portal-webui/src/main.tsx` injects
`createMemoryTransport`), because the tenant business core in
`@unidocs/portal-service` has no HTTP adapter yet; and it has no sign-in, so
`serveTenantWebUi` runs ahead of the admin-shaped BFF rather than through it.
Both change together when the tenant API lands.

### `wrangler dev` inside `packages/cloudflare-portal` does not work

Run it there and workerd refuses to start:

```text
✘ [ERROR] service core:user:unidocs-portal-local: This Worker requires
  compatibility date "2026-09-10", but the newest date supported by this server
  binary is "2026-08-18".
```

`wrangler.jsonc` carries the **deployment** compatibility date, which is ahead
of the workerd binary this repository's lockfile pins. The local runtime does
not read that file: it supplies its own `COMPATIBILITY_DATE`
(`stacks/unidocs-cloudflare/local/doc-types.mjs`) alongside the worker's
`nodejs_compat` flag, which is why `pnpm dev portal` boots the identical entry
point without complaint. Use `pnpm dev portal`; resolving the mismatch properly
means moving the lockfile past what the company registry currently carries.

### Google sign-in is not needed to run it

The portal boots and serves with no Google configuration at all. The runtime
binds placeholder credentials, the config check only requires them to be
non-empty, and every route behaves normally:

```text
GET /admin/auth/session            401
GET /admin/auth/login              303 → https://accounts.google.com/o/oauth2/v2/auth?...
GET /admin/api/v1/document-types   401
```

That 303 is the success case. It points at the **real** Google — not a loopback
mock — because the portal requires `auth_time` and `email_verified`, which the
local mock provider does not issue. Only *completing* a sign-in needs real
credentials:

- a Google OAuth client, configured in **either** place below, and
- `http://127.0.0.1:8795/admin/auth/callback` registered as an authorized
  redirect URI on that same client.

**Preferred: `packages/cloudflare-portal/.dev.vars`** (gitignored; copy
`.dev.vars.example` next to it and fill in the two empty values). The runtime
merges it into the portal worker's bindings and nothing else. A key the file
names but leaves empty reads as "not configured" and falls back to the
placeholder, so copying the example without filling it in leaves a working
portal rather than a 503.

**Or `GOOGLE_OIDC_CLIENT_ID` / `GOOGLE_OIDC_CLIENT_SECRET` in the
environment**, which override the file — but read the side effect below before
choosing them.

Without them `/admin/auth/login` still redirects, and Google rejects the
placeholder client id when the browser arrives.

### Signing in needs a bootstrap administrator too

A real Google client gets you *through* Google and then refused by the portal —
the console says you have no permission. Nobody is an administrator on a fresh
database, so `completeLogin` has no bound member and no invitation to match, and
falls through to `requireBootstrapIdentity`, which refuses every identity until
one address is designated. Set `PORTAL_BOOTSTRAP_EMAIL` (in the same
`.dev.vars`, or `UNIDOCS_PORTAL_BOOTSTRAP_EMAIL` in the environment) to the
Google account you sign in with.

It is consumed once: the first successful sign-in claims the `portal_bootstrap`
row, after which the setting does nothing and further administrators are added
through the console. To hand it to a different account instead, stop the dev
server and delete `.wrangler/miniflare` — the local D1 database.

**The environment variables are not portal-local.** (The `.dev.vars` file is —
this whole paragraph is the reason to prefer it.) The same two variables are
read once, in `runtime.mjs`, and handed to both the portal *and* the CAS admin
BFF. Setting either one (`buildWorkers` checks them with `||`, not `&&`) flips the admin
BFF's `OIDC_ISSUER` off the local mock provider on :8793 and onto
`https://accounts.google.com` — or onto `GOOGLE_OIDC_ISSUER`, if that is set
too — and gives it the portal's client id and secret in place of its own
`unidocs-local-admin` placeholders. So the CAS admin UI on :4070 will start
redirecting to Google as well, and signing into it then requires a *second*
redirect URI on that same Google client:
`http://localhost:4070/admin/auth/callback` (its `PUBLIC_ORIGIN`, overridable
with `UNIDOCS_CAS_ADMIN_ORIGIN`). If you only want to exercise the portal,
expect that side effect; to put the CAS admin UI back on the mock provider,
unset both variables.

## Code boundary

`packages/` and `unicas-packages/` contain implementation code. `stacks/`
contains orchestration, deployment assets, environment projection, and local
composition. Dependencies point from `stacks/` to packages, never the reverse.

See [UniCAS](unicas/README.md), [Shared documentation](docs/README.md),
[Azure UniDocs](unidocs-azure/README.md), and
[Cloudflare UniDocs](unidocs-cloudflare/deploy/README.md). Deployment identity,
runtime secrets, and local variables are documented in
[Deployment and local configuration](../docs/deployment-and-local-configuration.md).
