# Document types and lifecycle

A document type is the stable public identity and configuration root for one format. Choose a short MIME-safe identifier such as `diagram`, `markdown`, or `psd`; do not put display names, deployment names, or schema versions in it.

New registrations begin as disabled drafts. They may remain incomplete while administrators append contracts and prepare candidates. The internal administrator name is not user-facing and is never a fallback for missing Type Card localization.

## Draft

Create the registration first, then require every supporting resource to declare exactly the same `documentType`. A registration with missing bindings is valid while disabled.

## Bind

After creating the resources, update the registration to select the current Type Card bundle, View bundle, and Operator.

## Read before writing

Read the full document type registration and the selected candidate resources. Retain the exact quoted registration ETag for `If-Match`. Do not parse or reconstruct Platform ETags.

## Check compatibility

Before enabling, verify:

- at least one Document Contract exists;
- the Type Card and View declare the same `documentType`;
- the Operator supports the document type;
- the current View and Operator share at least one supported Document Contract revision;
- all selected resources have passed validation.

The shared View/Operator contract intersection is the writable set. It does not need to contain only the highest contract index.

## Enable

Use the document type PATCH to select all intended resources and set `enabled: true`. Include an audit reason and the current ETag. The Platform evaluates the complete target configuration together, preventing a temporarily enabled but incompatible state.

On `PRECONDITION_FAILED`, read current state and reconcile. Do not replay the same body with a newly invented ETag.

## Disable and repair

An enabled type can be disabled under its ETag without deleting contracts or candidates. Repair by creating corrected immutable resources and selecting them explicitly; do not modify historical contract revisions or bundle content in place.

## Verify the result

Read the registration again, confirm selected resource identities and enabled state, then inspect audit events. Finally verify that the Type Card appears in the Tenant Portal and both View entrypoints load for a document using a supported contract revision.
