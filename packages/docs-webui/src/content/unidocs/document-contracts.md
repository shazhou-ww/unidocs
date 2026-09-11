# Document Contracts

A Document Contract pairs the complete snapshot schema and document-location schema under one document-type-scoped revision. `DocumentContractIdx` starts at 0 and increases monotonically.

## Append-only evolution

Revisions cannot be edited, deleted, deprecated, reordered, or manually selected as current. The highest index means only "most recently appended"; it is not automatically the only writable revision. Historical contracts remain available for interpreting versions and creating new data when the current View and Operator both support them.

## Paired schemas

One JSON append request atomically carries `snapshot` and `location` SValue schemas plus a shared `formatVersion` and audit reason. If either schema fails validation, the entire append fails.

The Platform derives fixed document-type-specific media types from format version 1. The format version describes wire encoding, while `DocumentContractIdx` identifies a schema revision.

## Compatibility set

The current View bundle and Operator each advertise supported contract revisions. Their intersection is the set available for new snapshots and locations. Appending another contract while a type is enabled does not remove older compatible revisions from that set.

## SValue dialect

Both schemas use the UniDocs SValue JSON Schema dialect. Extensions such as `x-unidocs-sblob` mark atomic blob references; blob size remains governed by UniCAS rather than a per-contract schema keyword.
