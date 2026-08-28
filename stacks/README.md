# Stack registry

Each first-level directory is one independently runnable and deployable stack.
The directory name is its CLI selector; provider is an implementation detail,
not the first classification level.

```text
stacks/
  unicas/
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
pnpm run deploy <stack> [...args]
pnpm smoke <stack> [...args]
```

`pnpm run deploy` must include `run`: bare `pnpm deploy` is a pnpm built-in
command and does not invoke the repository script.

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

See [UniCAS](unicas/README.md), [Azure UniDocs](unidocs-azure/README.md), and
[Cloudflare UniDocs](unidocs-cloudflare/deploy/README.md). Deployment identity,
runtime secrets, and local variables are documented in
[Deployment and local configuration](../docs/deployment-and-local-configuration.md).
