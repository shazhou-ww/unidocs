# OAuth issuer activation

Each stack trusts capability signatures from an active Stack OAuth issuer. An external issuer is activated through discovery and cryptographic ownership proof; UniCAS never receives the issuer's private key.

## Inspect

Submit the exact public HTTPS issuer identifier. UniCAS performs bounded OAuth or OIDC discovery, validates that metadata reports the same issuer, and retrieves compatible public JWKs without forwarding administrator credentials.

The response contains an expiring inspection identity and exact challenge bytes.

## Prove control

Sign the challenge as a compact JWS using a private key corresponding to one of the discovered public keys. Keep the private key inside the authorization server or its secure signing system.

## Activate

Send the inspection identity, compact JWS, and pending issuer revision. UniCAS verifies the proof and activates the issuer under optimistic concurrency. Tenant capabilities must then use the exact configured issuer and audience.
