---
description: "Use when editing UniCAS packages, access-plane protocols, clients, CLIs, WebUIs, or server deployment boundaries."
applyTo: "unicas-packages/**,stacks/unicas/**"
---

# UniCAS package boundaries

UniCAS is an independently deployable middleware. Keep `unicas-packages/` movable to a standalone repository and do not introduce runtime dependencies on `@unidocs/*` packages.

## Actor-facing client packages

- Keep the admin and tenant access planes separate. Actor-facing package names use the `admin-` and `tenant-` prefixes respectively.
- Each access plane has four canonical client-side roles: `<actor>-protocol`, `<actor>-client`, `<actor>-cli`, and `<actor>-webui`.
- Keep the client-side dependency direction `[cli, webui] -> client -> protocol`. Do not put HTTP transport or application workflows in protocol packages.
- A protocol package owns that access plane's HTTP interface definitions, the request/response types used by those interfaces, and small pure helpers that accompany those types, such as constructors and type guards.
- Put protocol types shared by both access planes in `@unicas/tenant-protocol`. `@unicas/admin-protocol` may depend on `@unicas/tenant-protocol`; the reverse dependency is forbidden.
- A client package is a thin HTTP API wrapper. Represent each endpoint as a simple `Request -> Promise<Response>` operation, and keep shared transport parameters such as base URL and credentials on the client object.
- Higher-level packages may wrap a client to reduce caller complexity. Keep that business abstraction separate from the transport client; `@unicas/tenant-blob-client` wrapping `@unicas/tenant-client` is the reference pattern.

When restructuring server packages, preserve these protocol and client boundaries. Server implementations and deployment adapters must not become dependencies of protocol or client packages.