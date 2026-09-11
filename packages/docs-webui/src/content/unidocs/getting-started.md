# UniDocs Admin control plane

The UniDocs Admin API configures which document experiences the Platform can safely expose. It owns document type registrations, append-only Snapshot Contracts, immutable presentation bundles, validated Operator candidates, and the administrator allowlist.

> This section documents the target Admin v1 contract. It does not claim that every handler or persistence adapter is already deployed.

## Configuration workflow

1. Create a disabled document type draft with its stable `documentType` and internal name.
2. Append the first Snapshot Contract that defines valid SValue snapshots.
3. Upload a localized Type Card bundle and a browser View bundle.
4. Inspect an Operator endpoint, then persist the successful validation as a candidate.
5. Atomically bind the current bundles and Operator to the document type.
6. Enable the type only after every required resource supports the latest Snapshot Contract.

## Candidate versus current configuration

Uploads and validations create reusable candidates. They do not silently alter a document type. Binding is an explicit conditional update, so administrators can inspect candidates before selecting them and concurrent changes cannot overwrite each other.

## API boundary

The Admin API uses a same-origin administrator session. It is separate from public document, View Host RPC, Agent, and Operator runtime APIs. This portal currently publishes only the contract from `@unidocs/protocol-admin`.
