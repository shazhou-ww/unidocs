# What administrators manage

Administrators decide which document experiences UniDocs can safely expose. They manage configuration resources, not user documents or Operator private keys.

## Document type registrations

A registration gives a format its stable public identity and selects the resources currently used for presentation and processing. New registrations begin as disabled drafts and may remain incomplete while the supporting resources are prepared.

## Document Contracts

A Document Contract pairs a complete snapshot schema with a document-location schema. Revisions are append-only and document-type scoped. The schemas tell the Platform what data is valid without teaching it format-specific editing behavior.

## Type Card bundles

A Type Card controls how a format appears in document creation: localized name and description, icon, sample thumbnail, and accessible thumbnail text.

## View bundles

A View bundle contains separate browser entrypoints for the full interactive experience and deterministic thumbnail rendering. Its manifest declares which Document Contract revisions it supports.

## Operators

An Operator is a validated external processing service with a stable discovery identity and declared format compatibility. Administrators validate it without user data, persist it, then select it explicitly on a document type.

## Members and audit

The administrator allowlist controls who may modify configuration. The audit feed records committed changes and validation outcomes with actor, resource, reason, time, and request correlation.

## What administrators do not manage

Administrators do not upload Operator private keys, edit historical contract revisions, mutate bundle contents, or directly rewrite user document versions. Those boundaries keep configuration changes auditable and existing data interpretable.
