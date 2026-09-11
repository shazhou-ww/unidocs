# Document type lifecycle

A document type begins as an incomplete, disabled draft. Drafts may remain incomplete while administrators upload and validate their supporting resources.

## Stable identity and internal metadata

`documentType` is the stable public identifier. `internalName` is administrator-facing metadata and is not a fallback for user-visible card content. User-facing name, description, icon, and sample thumbnail come from the currently bound Type Card bundle.

## Explicit bindings

A document type selects one current Type Card bundle, one current View bundle, and optionally a built-in Operator. Uploading a bundle or validating an Operator never binds it automatically.

The document type update uses `If-Match` against the current registration ETag. Changes to current bindings or enabled state require an audit reason.

## Enablement gate

A type can be enabled only when:

- at least one paired Document Contract exists;
- a current Type Card bundle is ready;
- a current View bundle is ready;
- the selected View and Operator share at least one supported Document Contract revision.

Enabled types may receive additional Document Contract revisions. Appending a revision does not invalidate the existing writable set; new data can use any revision supported by both the current View and Operator.
