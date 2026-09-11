# Leases and Root Refs

Leases and Root Refs solve different parts of one transaction. A lease protects possible future state; a positive Root Ref records committed retained state.

## Prepare

Call the lease operation with the expected node hash and upload metadata. If content is missing, UniCAS returns a short-lived direct upload request. Upload the exact canonical bytes and finalize the lease before its deadline.

The service chooses the actual expiry. Renew the lease when the surrounding business operation may run longer.

## Commit

Apply the complete set of positive and negative Root Ref deltas in one request. This atomic update is the CAS commit boundary: acquire new roots and release replaced roots together.

Use a caller-generated `requestId` that is stable for the business intent. If the response is lost, retry the identical request. UniCAS returns the original revision instead of applying the delta twice.

## Abort and recover

To abort before commit, do not write Root Refs. Let the preparation lease expire. To recover after an uncertain commit, retry the same request and then inspect the resulting revision.
