# Disable and repair a format

When a format is unsafe or unusable, contain the issue by disabling its document type, then repair candidates without changing historical resources.

## Disable conditionally

Read the current registration and PATCH `enabled: false` under its exact ETag. Include a reason that identifies the incident or failed rollout. A stale ETag means another administrator changed the same registration; read and reconcile before continuing.

## Diagnose the configuration

Check the full document type and selected resources for:

- a missing Document Contract;
- a Type Card, View, or Operator with a different `documentType`;
- no common Document Contract revision between the View and Operator;
- an expired Operator validation that was never persisted;
- an incomplete Type Card locale or icon set;
- identical interactive and thumbnail View entrypoints.

Use the audit feed to correlate the latest binding change, candidate upload, validation result, and actor.

## Repair with new candidates

Immutable bundle content and Operator descriptors are not edited in place. Upload a corrected bundle or validate and persist a corrected Operator. Metadata-only corrections may use the resource PATCH operations with `If-Match`.

## Re-enable atomically

Read fresh resource state, select all corrected IDs, and set `enabled: true` in one conditional document type update. Verify the resulting bindings, audit event, creation card, interactive View, and thumbnail View.
