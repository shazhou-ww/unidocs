# @unidocs/service-auth

Cloud-neutral capability issuance/verification and platform-to-compute HMAC.
Existing capability/JWT APIs are unchanged. Platform HMAC is a separate trust layer:
it does not issue CAS rights, authorize a user, or permit callbacks to platform.

## Platform HMAC Draft 1

`signPlatformRequest` returns a POST Request with `redirect: "error"`.
`verifyPlatformRequest` authenticates its bounded raw body before a transport
decodes or computes anything. Both use the shared `unidocs-doctype/2-draft` metadata.
Keys imported by `importPlatformHmacKey` are nonextractable HMAC-SHA-256 keys with
at least 32 input bytes. Operators must supply cryptographically random secrets.

Each key record fixes keyId, platformId, environment, serviceId and role. Configure
separate secrets per environment/service/role. Unknown, revoked, mismatched or
ambiguous key records fail. Install the new key on the service, switch the signer,
then remove the old key after the bounded request window. Removal is immediate;
there is no fallback to user JWTs. Never log headers, signatures, keys or tokens.

Targets require exact HTTPS origin and path allowlists. This draft supports POST
and unescaped ASCII paths containing letters, digits, slash, underscore or hyphen.
Queries (including an empty `?`), fragments, URL credentials, encoded path aliases
and noncanonical signer URLs are rejected. Do not broaden this to arbitrary URLs
from registration. A future path/query extension requires a new canonical format.
Fetch runtimes can normalize incoming paths before constructing Request; the
deployment ingress must reject ambiguous raw targets rather than route aliases.

Headers are the following exact names:

| Metadata | Header |
| --- | --- |
| protocol | x-unidocs-protocol |
| algorithm | x-unidocs-algorithm |
| keyId | x-unidocs-key-id |
| platformId | x-unidocs-platform-id |
| environment | x-unidocs-environment |
| serviceId | x-unidocs-service-id |
| role | x-unidocs-role |
| issuedAt | x-unidocs-issued-at |
| expiresAt | x-unidocs-expires-at |
| nonce | x-unidocs-nonce |
| signature | x-unidocs-signature |
| CAS credential | x-unidocs-cas-authorization |
| Operator callback credential | x-unidocs-platform-authorization |

Identity fields are 1-128 ASCII letters/digits/underscore/hyphen. Times are canonical
nonnegative decimal Unix seconds. Signature is exactly 64 lowercase hex characters.
Content-Type is exactly `application/vnd.unidocs.svalue+cbor;version=1`.
Credential values are printable ASCII without commas or leading/trailing whitespace.
Duplicate metadata/credential/Content-Type values merged by Fetch are rejected;
ingress must not silently discard duplicate headers before verification. Unknown
`x-unidocs-*` headers, Authorization, Cookie and Content-Encoding are rejected.
The editor role cannot receive Operator callback delegation.

## Canonical Bytes

For each field, append its decimal UTF-8 byte length, `:`, then the field itself.
Concatenate without separators or final newline. Ordered fields:

```text
unidocs-hmac/1
protocol
algorithm
keyId
platformId
environment
serviceId
role
POST
HTTPS origin
allowlisted pathname
empty query string
Content-Type
lowercase SHA-256 hex of raw body
issuedAt
expiresAt
nonce
lowercase SHA-256 hex of CAS header, or literal absent
lowercase SHA-256 hex of callback header, or literal absent
```

Hash raw bytes, not decoded/re-encoded SValue. Verification uses Web Crypto
`subtle.verify`, not JavaScript string comparison. The body defaults to a 1 MiB
limit, enforced during streaming even without Content-Length. Deployment adapters
must also enforce network timeouts, request concurrency and header limits.

Reproducible vector: key is 32 bytes of hex `42`, body is UTF-8 `raw signed bytes`,
protocol/algorithm/content type as above, keyId `editor-key-1`, platformId `platform`,
environment `test`, serviceId `markdown`, role `editor`, origin
`https://editor.example`, path `/v1/editor/init`, issuedAt `1000`, expiresAt `1060`,
nonce `vector-nonce-0001`, both credential headers absent. Expected signature:

```text
dbbabcd6dcbe0e9a56514098cfb894183d7c94825805ccff6213848f341cabd1
```

## Nonce Store Contract

`PlatformNonceStore.claim(scope, nonce, retainUntil)` must atomically insert-if-absent
and return true only for the first insertion. It is mandatory: there is no default
in-memory implementation. The scope is the JSON string array of platformId,
environment, serviceId and role, deliberately excluding keyId to cover rotation.
`retainUntil` is an absolute Unix second deadline, expiresAt plus 30 seconds.

All instances serving that scope must share consistent storage; claims must survive
restart. Never delete them before retainUntil. Storage errors fail closed with
`unavailable`; repeats return `replay_detected`. This port contract is implemented
only by test fakes here. A durable deployment adapter is still required.

Request lifetime is at most 300 seconds (signer default 60); clock skew is 30 seconds.
Time checks run before verification, after body verification and after nonce claim.
Retries get fresh nonce/time/signature but retain platform business operation identity.
HMAC replay protection is not commit idempotency or uncertain-apply recovery.

## Validation

```sh
pnpm --filter @unidocs/service-auth test
pnpm --filter @unidocs/service-auth typecheck
```

Tests compare against independent Node crypto and the fixed signature above, check
tampering, key isolation/rotation, duplicate headers, expiry, replay races, store
failure and body limits. They do not prove persistent replay protection on a deployed
service, nor complete the platform/Markdown browser integration.
