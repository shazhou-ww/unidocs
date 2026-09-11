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

## Code boundary

`packages/` and `unicas-packages/` contain implementation code. `stacks/`
contains orchestration, deployment assets, environment projection, and local
composition. Dependencies point from `stacks/` to packages, never the reverse.

See [UniCAS](unicas/README.md), [Shared documentation](docs/README.md),
[Azure UniDocs](unidocs-azure/README.md), and
[Cloudflare UniDocs](unidocs-cloudflare/deploy/README.md). Deployment identity,
runtime secrets, and local variables are documented in
[Deployment and local configuration](../docs/deployment-and-local-configuration.md).
