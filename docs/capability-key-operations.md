# Capability Key Operations

This runbook covers internal Gateway-issued capability signing keys. It does
not define end-user identity or authorization.

## Configuration ownership

Gateway is the only workload that receives `CAPABILITY_PRIVATE_KEY_PKCS8`.
Doc and CAS receive `CAPABILITY_TRUSTED_JWKS`, which must contain public keys
only. A deployment must also set:

- `INTERNAL_AUTH_MODE`: `dual` or `capability` while capabilities are active;
- `CAPABILITY_ALGORITHM`: `ES256`;
- `CAPABILITY_TTL_SECONDS`: `120`;
- `CAPABILITY_MAX_LIFETIME_SECONDS`: `300`;
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

   $$300\text{ seconds} + 30\text{ seconds} = 330\text{ seconds}.$$

7. Remove the old public JWK from every validator and deploy/restart them.
8. Remove or disable the old private key after all active revisions trust only
   the new key.

Validators never fetch keys from Gateway and never refresh JWKS per request.
Do not shorten the overlap by assuming a deployment completed everywhere at
the same instant.

## Rollback and recovery

During rollout phases A, B, and C1, rollback is a forward deployment of the
retained `dual` artifact with an explicitly remounted legacy credential. It is
audited and time-bounded. After phase C2 destroys the legacy secret, releases
that require it are not valid rollback targets.

If the active signing key is unavailable, deploy a capability-aware Gateway
revision with another already-trusted private key. If a private key may be
compromised, add a replacement public key to validators, switch Gateway,
observe for at least 330 seconds, and then remove the compromised public and
private keys. Short-lived tokens bound the exposure; there is no online token
revocation store.

Never copy a private key to Doc/CAS, source control, container images, queues,
database rows, traces, crash reports, command output, or incident tickets.