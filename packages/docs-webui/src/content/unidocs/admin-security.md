# Authentication and safe writes

The Admin API supports automation and browser-mediated administration while applying the same authorization policy to both.

## Authentication and authorization

Every operation accepts either an OAuth Bearer token or the same-origin `__Host-unidocs_admin` HttpOnly session cookie. If an `Authorization: Bearer` header is present, the server uses only that credential. A rejected Bearer token must never fall back to a valid cookie.

Cookie-authenticated mutations also require `X-CSRF-Token`. Bearer-authenticated mutations do not require CSRF. A browser client must not persist or expose the HttpOnly session cookie to JavaScript.

Authentication establishes identity; administrator membership authorizes Admin API access.

## Idempotency and retries

Every mutation requires `Idempotency-Key`. Generate a stable key before the first attempt and reuse it only for the same administrator, method, route, and request. Reusing a key with different input returns an idempotency conflict.

When a response is lost, retry the exact request with the same key. Generate a new key only for a new intended mutation.

## ETags and concurrent changes

PATCH operations and conditional member removal require `If-Match` with the exact quoted ETag from the canonical item GET. ETags represent the Platform resource, while an Operator's external configuration ETag represents discovered service configuration; the two are not interchangeable.

On precondition failure, read current state and reconcile the administrator's intent instead of blindly retrying.

## Administrator membership

The allowlist stores normalized Google account emails and binds verified identities during sign-in. Adding and removing membership are idempotent mutations. Removal is conditional, an administrator cannot remove their own membership, and the final administrator cannot be removed.

## Binary uploads

Type Card and View archives use a raw `application/zip` body so uploads remain streamable. Initial administrator name and description are UTF-8 query parameters rather than multipart fields.
