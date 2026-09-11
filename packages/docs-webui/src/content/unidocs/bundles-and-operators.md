# Bundles and Operators

UniDocs separates presentation resources from processing services. Type Card and View bundles are immutable uploaded archives; Operators are independently deployed services validated through discovery.

## Type Card bundles

A Type Card bundle defines localized creation-card content, an SVG or complete predefined-size PNG icon set, and a sample thumbnail. The `en` locale is required as the final fallback. Bundle content is addressed by identity, while administrator-only name and description metadata can change under an ETag.

## View bundles

A View bundle contains the isolated browser experience for a document type. Its manifest declares the entrypoint, supported Snapshot Contract revisions, and understood location types. Uploading a View does not make it current.

## Operator validation and candidates

Validation discovers the Operator descriptor and probes compatibility without sending user document data. A successful validation is short-lived. Persist it as an Operator candidate to retain the validated base URL and immutable descriptor together with editable administrator metadata.

## Selection

Candidates are selected through the document type update. This keeps upload, inspection, and production binding as separate auditable decisions.
