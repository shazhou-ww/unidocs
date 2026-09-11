# Define a Document Contract

A Document Contract pairs the complete snapshot schema and document-location schema under one `DocumentContractIdx`. For a new `diagram` format, the first index is 0.

## Paired schemas

The append request atomically contains:

```json
{
  "formatVersion": 1,
  "snapshot": { "schema": { "$schema": "https://schemas.unidocs.dev/svalue/v1" } },
  "location": { "schema": { "$schema": "https://schemas.unidocs.dev/svalue/v1" } },
  "reason": "Initial Diagram contract"
}
```

The snapshot schema validates complete document state. The location schema validates format-specific anchors used to associate comments, selections, or navigation with document content. If either schema fails validation, no revision is appended.

## Format version and media types

`formatVersion` describes wire encoding. Version 1 derives fixed document-type-specific snapshot CBOR and location JSON media types. It is independent from `DocumentContractIdx`, which identifies schema evolution.

## Append-only revisions

Revisions cannot be edited, deleted, deprecated, reordered, or manually selected as current. The highest index means “last appended”, not “the only writable revision”. Historical versions permanently retain their original contract index.

## Compatibility set

The current View and Operator each advertise supported contract revisions. Their intersection is the set that can be used for new snapshots and locations. Appending a new contract does not invalidate older compatible revisions and is allowed while a type is enabled.

## SValue blobs

Use `x-unidocs-sblob: true` for atomic blob references and `x-unidocs-blob-content-types` to constrain media types. Blob size limits are enforced by UniCAS and cannot be declared with `x-unidocs-blob-max-size`.
