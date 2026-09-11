# Admin security and retries

The Admin API is designed for browser-mediated administration with explicit mutation safeguards.

## Session and CSRF

Every request requires the same-origin `__Host-unidocs_admin` HttpOnly session cookie. Mutations also require `X-CSRF-Token`. A client should never persist or expose the session cookie to JavaScript.

## Idempotency

Every mutation requires `Idempotency-Key`. Generate a stable key before the first attempt and reuse it only for the same administrator, method, route, and request. Reusing a key with different input returns an idempotency conflict.

## Optimistic concurrency

Conditional metadata and registration updates require `If-Match` with the current ETag. On precondition failure, read the current resource and reconcile the administrator's intent instead of blindly retrying.

## Administrator membership

The allowlist stores normalized Google account emails and binds verified identities during sign-in. Removal is conditional, an administrator cannot remove their own membership, and the final administrator cannot be removed.

## Binary uploads

Type Card and View archives use a raw `application/zip` body so uploads remain streamable. Initial administrator name and description are UTF-8 query parameters rather than multipart fields.
