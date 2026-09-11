# Document type lifecycle

A document type begins as an incomplete, disabled draft. Drafts may remain incomplete while administrators upload and validate their supporting resources.

## Stable identity and internal metadata

`documentType` is the stable public identifier. `internalName` is administrator-facing metadata and is not a fallback for user-visible card content. User-facing name, description, icon, and sample thumbnail come from the currently bound Type Card bundle.

## Explicit bindings

A document type selects one current Type Card bundle, one current View bundle, and optionally a built-in Operator candidate. Uploading or validating a candidate never binds it automatically.

The document type update uses `If-Match` against the current registration ETag. Changes to current bindings or enabled state require an audit reason.

## Enablement gate

A type can be enabled only when:

- at least one Snapshot Contract exists;
- a current Type Card bundle is ready;
- a current View bundle supports the latest Snapshot Contract;
- the selected Operator candidate supports the document type and latest contract revision.

Disable the type before appending a new Snapshot Contract. After appending, bind compatible View and Operator candidates before enabling it again.
