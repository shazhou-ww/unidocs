# Admin security and retries

The Admin API supports browser-mediated administration and automation clients with explicit credential selection and mutation safeguards.

## Session and CSRF

Every operation accepts either an administrator Bearer token or the same-origin `__Host-unidocs_admin` HttpOnly session cookie. When an `Authorization: Bearer` header is present, the server uses only that token and never falls back to a cookie after token failure.

Cookie-authenticated mutations require `X-CSRF-Token`; Bearer-authenticated mutations do not. A client should never persist or expose the session cookie to JavaScript.

## Idempotency

Every mutation requires `Idempotency-Key`. Generate a stable key before the first attempt and reuse it only for the same administrator, method, route, and request. Reusing a key with different input returns an idempotency conflict.

## Optimistic concurrency

Conditional metadata and registration updates require `If-Match` with the current ETag. On precondition failure, read the current resource and reconcile the administrator's intent instead of blindly retrying.

## Administrator membership

The allowlist stores normalized Google account emails and binds verified identities during sign-in. Removal is conditional, an administrator cannot remove their own membership, and the final administrator cannot be removed.

## Audit

The append-only audit feed supports actor, action, resource type, document type, time-range, and cursor filters. Events include request correlation for investigation and attribution.

## Binary uploads

Type Card and View archives use a raw `application/zip` body so uploads remain streamable. Initial administrator name and description are UTF-8 query parameters rather than multipart fields.
