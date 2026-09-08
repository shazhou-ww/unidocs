# @unidocs/protocol-doctype

Cloud-neutral, draft contracts for platform calls to doctype compute services.
This package contains types, protocol constants and pure construction/shape helpers.
It has no HTTP client/server, storage, codec, signing or token verification implementation.
It depends only on `@unidocs/protocol` and does not replace the legacy `protocol-doc` APIs.

## Editor contracts

`EditorEndpointContracts<TDoc, TQuery, TOp>` defines:

| Operation | Input | Success data |
| --- | --- | --- |
| init | Invocation and StateSource | Fresh EditorContext |
| import | Invocation, schemaVersion, file SBlob and format | Fresh EditorContext |
| query | Invocation, expected context sequence and typed query | SValue |
| apply | Invocation, expected context sequence and changeset | Updated EditorContext |
| snapshot | Invocation and expected context sequence | Complete typed state, not a state-root reference |
| export | Invocation, StateSource and format | File SBlob, mediaType and filename |
| summary | Invocation, StateSource and maxExcerptLength | Plain-text title/excerpt, scalar properties and optional thumbnail |

`StateSource.schemaVersion` identifies a compatible snapshot/operation schema pair.
`base` is always an internal snapshot SBlob or null for an empty document.
`changes` is always an ordered array. Import files have a separate field and contract.
The context sequence is a nonnegative safe integer, not a persistent version.
Init/import return sequence zero; successful apply advances it by one. Query/snapshot
check the expected sequence but do not advance it. Requests on a context are serialized.
Lost contexts are recreated from platform-owned state, not restored by an editor history API.

Every invocation carries platform-asserted actor, tenant, document and type identities.
The platform allocates the document identity before create/import computation.
Services must bind contexts to these identities and reject mismatches. This is not a second ACL.
`requestId` identifies a fixed logical request across transport retries; changing its body
requires another identity. This field is not an implementation of idempotency.

## Operator contracts

`OperatorEndpointContracts` separately defines `run` and `reset`; neither takes an editor context.
The following is the initial synchronous contract proposal, not an implemented task system:

- The platform allocates `operatorSessionId` with generation zero. The first run initializes
  its conversation state; later runs address that same session and expected generation.
- Run uses a stable `taskId` for a fixed instruction and returns a terminal result with that
  identity, session, response text and nonnegative iteration count. Run does not advance the
  session generation. Reusing taskId with different inputs must be rejected.
- Reset checks the expected generation, clears only Operator conversation state and returns
  the same session ID with generation incremented. It never resets an editor or document.
  An active run makes reset fail with `operator_busy`; cancellation is not implied.
- One active run per session; a lost initialized session reports `operator_session_lost`
  instead of silently recreating its conversation. Lost responses do not establish whether
  platform writes occurred. Platform commit receipts remain authoritative.
- Run carries a task-scoped `platformAuthorization` in its header model for callbacks.
  It is not the user's login JWT. Callbacks still require platform authorization and commit checks.

Durable task status/recovery, streaming, cancellation, conversation retention and callback APIs
remain future Operator work. Types alone do not provide exactly-once execution. No run-status
API or background acceptance response is claimed by this synchronous draft.

## Transport and authentication

Request bodies and response envelopes use only `SValueContentType`; encoding belongs to
`@unidocs/svalue-codec`. There is no JSON fallback, inline/hash union, or raw export response.
`ServiceResponse` models the decoded content; it does not implement HTTP status mapping.

`PlatformRequestAuthentication` models HMAC metadata, with Unix seconds for issuedAt/expiresAt.
Credentials belong outside the SValue content: CAS authorization in request headers and
Operator callback delegation in run headers. Do not serialize the whole request descriptor
as a content body. Do not forward user JWTs, browser cookies or HMAC secrets.

Use separate environment/service keys. The signed canonical request must bind method,
path/query, raw body digest, content type, authentication metadata and all authorization
headers (including delegation). Timestamp windows, atomic nonce tracking, constant-time
verification, key rotation and HTTPS are runtime requirements, not helpers supplied here.
Header names, canonical byte format, signature encoding, route paths and HTTP error statuses
must be fixed with shared test vectors before exposing a service. The protocol identifier
`unidocs-doctype/2-draft` deliberately does not assert a stable wire release.

## Helpers

```ts
import { createChangeSet, createStateSource, isStateSource } from "@unidocs/protocol-doctype";

interface SetText { readonly text: string }
const changes = [createChangeSet<SetText>([{ text: "Hello" }])];
const source = createStateSource<SetText>("markdown/1", null, changes);
const valid = isStateSource<SetText>(source, (value): value is SetText =>
  value !== null && typeof value === "object" && "text" in value && typeof value.text === "string",
);
```

Constructors accept already typed inputs and copy arrays, not nested operation objects.
Guards check protocol shapes; they do not validate type-specific semantics or authorize requests.
`isStateSource` requires the caller's operation guard. `isSBlobReference` recognizes the
in-memory SBlob brand and a nonempty hash, not hash format, content integrity or CAS access.
Decode wire SValue before applying these guards; JSON `{ hash: ... }` is not an SBlob.
`isServiceResult` validates success data using the supplied guard and known failure codes;
failure does not establish the outcome of any earlier platform commit.

## Validation

```sh
pnpm --filter @unidocs/protocol-doctype test
pnpm --filter @unidocs/protocol-doctype typecheck
pnpm --filter @unidocs/protocol-doctype build
```