# Update presentation only

Presentation can change without changing document schemas or Operator behavior.

## Type Card changes

For administrator-only wording, update the Platform record's `name` or `description` under `If-Match`. For user-facing localization, icon, or sample thumbnail changes, build and upload a new immutable Type Card bundle, then select it on the document type.

## View changes

Build a new immutable View ZIP when interactive code, thumbnail rendering, or bundled assets change. Keep the exact `documentType` and declare every Document Contract revision the replacement can render.

## Switch explicitly

Inspect the uploaded candidate, read the document type's current ETag, and PATCH the selected bundle ID. A new upload is never selected automatically.

A Type Card-only change has no View/Operator compatibility effect. A View change must preserve a non-empty intersection with the current Operator before an enabled document type can select it.

## Recovery

Because bundle content is immutable, recovery is another conditional binding update to a previously validated bundle. Record a specific audit reason for both the rollout and any recovery action.
