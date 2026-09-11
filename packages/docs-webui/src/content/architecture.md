# Content-addressed storage

Every UniCAS node is immutable and identified by the lowercase SHA-256 digest of its canonical bytes. The digest is both the lookup key and the integrity check.

## Nodes and edges

A node stores immutable metadata, canonical content, and an ordered list of child hashes. Stored edges propagate retention through a DAG without requiring UniCAS to understand application-specific formats.

Mutable lease and reference counters are deliberately excluded from the digest. The same node identity remains valid while its protection state changes.

## Isolation

The canonical service path contains both `stackId` and `tenantId`. A verified capability must authorize the same resource path. Identical bytes can exist in different tenant partitions without granting cross-tenant access.

## What UniCAS does not own

UniCAS does not interpret document manifests, directories, PSD layers, or application records. Business systems retain meaningful manifest roots through Root Refs and remain responsible for their own domain model.
