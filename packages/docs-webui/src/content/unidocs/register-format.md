# Register a document format

This guide follows a hypothetical `diagram` format from an empty draft to an enabled document experience.

## Before you start

Prepare:

- a stable MIME-safe document type such as `diagram`;
- snapshot and location schemas using the SValue dialect;
- a Type Card ZIP;
- a View ZIP with interactive and thumbnail entrypoints;
- an Operator service with public discovery and probe support;
- an authenticated administrator client.

## Registration sequence

1. Create a disabled document type draft named “Diagram”.
2. Append Document Contract revision 0 with paired snapshot and location schemas.
3. Upload a Type Card bundle for `diagram`.
4. Upload a View bundle supporting contract revision 0.
5. Validate the Operator endpoint for `diagram`.
6. Persist the successful validation as an Operator.
7. Read the complete resources and retain their IDs and current ETags.
8. Update the document type to select the card, View, and Operator.
9. Enable the type once the selected View and Operator share a supported contract revision.
10. Inspect the audit feed and verify the format in the user-facing creation experience.

## Why the steps are separate

Uploads and validation create reusable resources but do not change production configuration. The final document type update is an explicit, conditional decision. This separation allows review, retry, and rollback by selecting a different immutable resource instead of modifying content in place.

## Retry rules

Generate an `Idempotency-Key` before each mutation and retain it until the outcome is known. For conditional updates, send the exact quoted ETag from the latest GET response in `If-Match`. If it is stale, read current state and reconcile before retrying.
