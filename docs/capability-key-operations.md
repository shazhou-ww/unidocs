# Capability Key Operations

This runbook covers internal Gateway-issued capability signing keys. It does
not define end-user identity or authorization.

## Configuration ownership

Gateway is the only workload that receives `CAPABILITY_PRIVATE_KEY_PKCS8`.
Doc services receive `CAPABILITY_TRUSTED_JWKS` (public keys only) for
session-capability verification. The CAS middleware does **not** verify
Gateway's identity: it verifies stack-issued delegated capabilities against
the registered stack's `CAS_STACK_TRUSTED_JWKS` (managed via the control
plane in `@unicas/service-cloudflare`, with business semantics in
`@unicas/service`). A deployment must also set:

- `CAPABILITY_ALGORITHM`: `ES256`;
- `CAPABILITY_TTL_SECONDS`: `120`;
- `CAPABILITY_MAX_LIFETIME_SECONDS`: `1800` (production; protocol hard maximum is 604800s / 7 days, per-stack control-plane cap is 60..604800 with default 28800);
- `CAPABILITY_CLOCK_SKEW_SECONDS`: `30`;
- one environment-specific `CAPABILITY_ISSUER`;
- Gateway `CAPABILITY_KEY_ID` and `CAS_CAPABILITY_AUDIENCE`;
- each Doc service's exact `DOC_CAPABILITY_AUDIENCE`;
- each validator's `CAS_CAPABILITY_AUDIENCE` where applicable.

Missing, empty, malformed, or inconsistent capability configuration fails
startup. Startup diagnostics may name the missing field but must not print key
material, JWKS bodies, bearer tokens, or signatures.

Cloudflare stores the private key and trusted JWKS as secrets. Wrangler vars
contain only non-secret policy and audience values. Changing a key or JWKS
requires a Worker deployment; running isolates do not hot-reload bindings.

Azure Container Apps mount the private key only into the Gateway Container App
secret environment and the public JWKS only into Doc Container Apps. A change
requires a new active revision or restart. Bicep outputs and deployment logs
must not contain either secret value.

Local development generates an ignored fixture with:

```text
pnpm keys:local
```

The default output is `.wrangler/capability/local.json`, which is ignored by
Git. The command prints only the output path, issuer, and `kid`.

## Rotation

1. Generate a new ES256 key and a unique `kid` in the platform secret system.
2. Add the new public JWK to every Doc and CAS trusted JWKS while retaining the
   old public JWK.
3. Deploy/restart every Cloudflare Worker and Azure revision. Confirm startup
   diagnostics report the new trusted `kid` without printing the JWKS.
4. Change Gateway's active private key and `CAPABILITY_KEY_ID` to the new key,
   then deploy/restart Gateway.
5. Run normal create/read/write and direct CAS probes through every target.
   Monitor unknown-key, wrong-issuer, and wrong-audience failures.
6. Wait at least maximum token lifetime plus clock skew:

   (configured `CAPABILITY_MAX_LIFETIME_SECONDS` plus clock skew, e.g. 1800 + 30 = 1830 seconds in production; up to 604800 + 30 at the protocol maximum).

7. Remove the old public JWK from every validator and deploy/restart them.
8. Remove or disable the old private key after all active revisions trust only
   the new key.

Validators never fetch keys from the Doc-service identity and never refresh
JWKS per request. The delegated CAS capability verifier may use the stack
issuer's live `jwks_uri` (`CAS_STACK_JWKS_URI`, with jose's cooldown caching
and unknown-`kid` refresh); the Doc-service identity stays a pinned snapshot.
Do not shorten the overlap by assuming a deployment completed everywhere at
the same instant.

## Rollback and recovery

*(Historical note: the A/B/C1/C2 `dual`-artifact rollout phases and the legacy
credential remount belong to the retired legacy runtime; current deployments
are capability-only and rollback is a Wrangler/Azure revision rollback.)*

If the active signing key is unavailable, deploy a capability-aware Gateway
revision with another already-trusted private key. If a private key may be
compromised, add a replacement public key to validators, switch Gateway,
observe for at least the configured maximum lifetime plus clock skew, then remove the compromised public and
private keys. Short-lived tokens bound the exposure; there is no online token
revocation store.

Never copy a private key to Doc/CAS, source control, container images, queues,
database rows, traces, crash reports, command output, or incident tickets.

## Operational verification

For every active Cloudflare worker and Azure revision:

1. Confirm metadata-only diagnostics report the expected issuer, active or
   trusted `kid`, and exact Doc/CAS audiences without printing JWKS bodies.
2. Run Gateway create/read/write and direct CAS read/write/admin smoke probes.
3. Probe Doc and CAS tenant routes with the retired legacy header and require
   `401`; a capability-authenticated probe must still succeed.
4. Monitor unknown-key, wrong-issuer, wrong-audience, expired-token, and
   permission-denied events through the full observation window.
5. Search logs and traces for token strings, signatures, private keys, and JWKS
   bodies. Any match is an incident, not an observability feature.
6. Inspect active revisions, environment variables, and secret references;
   inactive or pre-capability revisions must not receive traffic.

Production rollout is incomplete until the observation window, rollback
window, active-revision inspection, legacy-header probes, and legacy-secret
destruction gates all pass.

## Incident decisions

| Condition | Response |
|---|---|
| Active signing key unavailable | Switch Gateway to another already-trusted private key and deploy a capability-aware revision. |
| Private key suspected compromised | Publish replacement trust, switch Gateway, observe for at least the configured maximum lifetime plus clock skew, then remove compromised public and private material. |

## Known platform constraint: Durable Object memory and concurrent CAS subrequests

Production docx create once crashed with `Durable Object's isolate exceeded its
memory limit and was reset` after the first ~7 OpenXML part uploads while
markdown (fewer refs) stayed under the limit and the local Miniflare runtime
did not reproduce it. Each concurrent in-flight CAS subrequest issued from a
Durable Object holds a large buffer in the calling isolate, so concurrent
bursts (the docx snapshot's `Promise.all` over its ref leases, plus
high-concurrency part uploads) push a 128 MB DO past its limit.

Keep CAS subrequests from Doc Durable Objects sequential or low-concurrency:

- `doctype-server-common/src/sblob-context.ts` — SValue snapshot storage leases
  its refs sequentially (not `Promise.all`).
- `doctype-docx/src/docx.ts` — `PART_IO_CONCURRENCY` is 2, not 8.

Do not raise the DO memory limit to mask this; serialize the subrequests
instead. When adding a doc type that stores many blobs per commit, keep the
same rule.
| Validators reject new tokens | Verify issuer, `kid`, audience, JWKS deployment, and that every validator revision restarted. |
| Authorization failures spike | Disable the affected route/revision or forward-deploy a retained capability-aware release; do not enable an undocumented permanent bypass. |