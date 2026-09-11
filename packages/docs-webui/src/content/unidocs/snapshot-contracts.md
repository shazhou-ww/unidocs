# Snapshot Contracts

A Snapshot Contract is the document-type-scoped schema for complete SValue snapshots. Revisions are positive integers that increase monotonically.

## Append-only evolution

Snapshot Contract revisions cannot be edited, deleted, deprecated, reordered, or manually selected as current. The highest revision is always the latest and is the only revision accepted for new writes. Historical revisions remain readable so existing versions can always be interpreted against the schema that governed them.

## SValue dialect

Contracts use the UniDocs SValue JSON Schema dialect. Standard JSON Schema vocabulary describes structure, while extensions such as `x-unidocs-sblob` mark atomic blob references and can constrain content type and maximum size.

## Safe upgrade sequence

1. Disable the document type.
2. Append the next immutable contract revision.
3. Select a View bundle and Operator candidate that declare support for the new revision.
4. Re-enable the type.

Appending while enabled is rejected. This prevents the latest writable schema from moving ahead of the components responsible for rendering and processing it.
