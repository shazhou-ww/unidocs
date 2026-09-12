# Candidates and current bindings

UniDocs separates resource creation from production selection. This is the key control-plane pattern behind safe document format administration.

## Candidate resources

Bundle uploads and Operator validation/persistence create resources that can be inspected independently:

- Type Card bundles;
- View bundles;
- Operators.

Their immutable content or descriptor is fixed. Administrator-facing name and description are mutable under each resource's own ETag.

## Current bindings

The document type registration stores the resource IDs currently selected for users. Changing a candidate's display metadata does not change its immutable behavior. Uploading another bundle or persisting another Operator does not alter the registration.

## Why this separation matters

Administrators can:

- prepare replacements without affecting users;
- compare immutable manifests and compatibility declarations;
- retry upload or validation independently;
- atomically switch several selected resources;
- recover by selecting a previous immutable resource;
- attribute every transition through audit events.

The Platform never treats “most recently uploaded” as “current”. Selection is always explicit and protected by the registration ETag.
