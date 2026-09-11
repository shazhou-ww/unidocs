# Operations and recovery

UniCAS workflows are designed around explicit retry identities, bounded leases, and conservative garbage collection.

## Safe retries

Creation operations may accept `Idempotency-Key`. Reuse the same key only for the same method, route, administrator, and input. Root Ref writes use their body `requestId` as the commit identity.

Conditional Admin mutations require the current integer revision in `If-Match`. On `REVISION_MISMATCH`, read current state and reconcile instead of blindly retrying.

## Usage

Tenant usage counters are an operational snapshot. Ready bytes, upload reservations, active leases, and not-ready nodes can change immediately as concurrent work progresses.

## Garbage collection

A node is collectible only when it has no positive Root Ref, no parent edge, and no active lease. UniCAS rechecks eligibility inside the tenant mutation queue to close races with commits and lease renewal.

Garbage collection is bounded. Repeat passes when more candidates remain; never infer that one pass examined the entire tenant graph.
