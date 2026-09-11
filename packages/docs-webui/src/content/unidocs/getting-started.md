# UniDocs Admin control plane

The UniDocs Admin API configures which document experiences the Platform can safely expose. It owns document type registrations, append-only paired Document Contracts, immutable presentation bundles, validated Operators, the administrator allowlist, and control-plane audit events.

> This section documents the target Admin v1 contract. It does not claim that every handler or persistence adapter is already deployed.

## Configuration workflow

1. Create a disabled document type draft with its stable `documentType` and internal name.
2. Append the first Document Contract that pairs valid snapshot and location schemas.
3. Upload a localized Type Card bundle and a browser View bundle.
4. Inspect an Operator endpoint, then persist the successful validation as an Operator.
5. Atomically bind the current bundles and Operator to the document type.
6. Enable the type after the View and Operator share at least one supported Document Contract revision.

## Candidate versus current configuration

Uploads and validations create reusable candidates. They do not silently alter a document type. Binding is an explicit conditional update, so administrators can inspect candidates before selecting them and concurrent changes cannot overwrite each other.

## API boundary

The Admin API supports either a Bearer token or a same-origin administrator session. It is separate from public document, View Host RPC, Agent, and Operator runtime APIs. This portal currently publishes only the contract from `@unidocs/protocol-admin-portal`.
