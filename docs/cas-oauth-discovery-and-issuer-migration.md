# Public OAuth discovery and issuer domains

UniCAS is middleware, not the host of downstream authorization servers. Stack
administrators may register a public HTTPS issuer on their application's domain
without asking the UniCAS operator to approve that domain. The issuer's metadata
may advertise a JWKS endpoint on another public HTTPS origin.

## Discovery policy

`CAS_OAUTH_DISCOVERY_ALLOWED_ORIGINS` is an optional deployment restriction, not
a trust registry. Unset or blank means public HTTPS discovery is enabled. A
nonblank comma-separated list restricts issuer, discovery and JWKS origins to
exact matches. A nonblank list with no entries (for example `,`) denies all;
the adapter's explicit `allowedOrigins: []` likewise denies all. The production
configuration omits this variable. Existing private deployments that require
domain restrictions should continue setting an explicit list.

Both inspection and runtime JWKS fetching enforce:

- HTTPS on port 443 without credentials or fragments; IP literals (including URL
  parser-normalized numeric/hex IPv4), single-label hosts and local/internal names
  are rejected before fetching.
- GET with only the adapter's JSON Accept header, no redirects and no forwarded
  cookies, authorization headers, private service bindings or `cf` overrides.
- Five-second request/body timeout; caller cancellation also cancels runtime JWKS.
- Bounded body reads: 128 KiB metadata, 256 KiB JWKS; rejected bodies are cancelled.
- Metadata issuer must exactly match the requested canonical issuer. Stack
  membership, signed activation challenge, resource audience and key validation
  are unchanged. Discoverable does not mean trusted.

## Network boundary

This adapter targets Cloudflare Workers global fetch with
`global_fetch_strictly_public`, already enabled in the deployment. Cloudflare
documents that this routes requests as on the public Internet, including same-zone
requests, rather than bypassing the public entry point to reach the zone origin:
https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public

Hostname syntax checks are not DNS resolution or address pinning. The public
network boundary is a runtime/deployment requirement, not something the URL
allowlist or a preflight DNS lookup can establish. Do not substitute unrestricted
Node fetch, a VPC binding, private-network fetcher or DNS/resolve override. Other
deployment adapters must enforce destination-address restrictions at connection
time, including after DNS resolution, before supporting arbitrary public issuers.
Injected fetchers in unit tests verify adapter policy, not Cloudflare's network.

## UniDocs migration status (2026-09-08)

Live control-plane reads confirmed:

| Stack | Current external issuer | Status |
| --- | --- | --- |
| `cas_SZ6wfcfqS34J` (Cloudflare) | `https://unicas.shazhou.work/oauth/unidocs-cloudflare` | active, revision 2 |
| `cas_EM1_egj6I-ea` (Azure) | none | external OAuth issuer not configured |

The intended Cloudflare issuer is
`https://unidocs.shazhou.work/oauth/unidocs-cloudflare`. Its CAS resource audience
remains `https://unicas.shazhou.work/stacks/cas_SZ6wfcfqS34J`; issuer migration does
not rename the resource server or stack.

**Do not change production issuer variables yet.** The current control API rejects
inspection when an external issuer is active, and stores only one external issuer
per stack. There is no supported old/new issuer overlap or replacement operation.
Direct SQL changes, weakening issuer matching, or briefly replacing an active
issuer with a pending record would bypass the safety contract and disrupt clients.

Before cutting over Cloudflare:

1. Add a supported replacement workflow that stages and proves the candidate while
   the current issuer remains active; define ETags, audit, rollback and bounded
   overlap for existing tokens. Do not reuse ordinary inspect as an implicit reset.
2. Publish candidate metadata/JWKS on the application domain without changing the
   issuer of tokens currently being minted. Obtain the activation proof through an
   authorized signer holding an advertised private key; never export that key into
   the control plane or logs.
3. Coordinate `CAS_STACK_ISSUER` and `GATEWAY_OAUTH_ISSUER` on Gateway with
   `CAS_STACK_ISSUER` and `CAS_STACK_JWKS_URI` on DOCX, Markdown and PSD workers.
   Check OAuth client registrations, refresh grants, session cookies and cached
   client discovery, not just access-token expiry. Keep the CAS audience unchanged.
4. Verify new token issuance and CAS/Doc authorization, drain old tokens and account
   for clock skew and verifier caches before retiring the old authority and routes.
   Existing token lifetime can be up to 1800 seconds; refresh grants need an explicit
   transition policy rather than merely waiting that long.

Azure needs its actual public Gateway hostname and runtime signing/login setup
verified first. Its deployment already accepts `--cas-stack-issuer` and
`--gateway-oauth-issuer`; OAuth requires the two to match and use HTTPS. A missing
external issuer is not evidence that legacy tenant traffic or keys are unused.
Register the provider's own public URL only after its discovery, JWKS and signed
activation proof are available. Do not invent an Azure hostname or replace its
existing runtime issuer without checking clients and document-service trust.