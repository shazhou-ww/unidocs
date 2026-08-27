# CAS Middleware Operations

Runbooks, SLOs, and alerting for the independently deployed CAS middleware
(the `@unicas` packages in `unicas-packages/`). Production topology:

| Component | Worker / resource | Notes |
|---|---|---|
| Edge (public) | `unidocs-cas-edge` | `https://unicas.shazhou.work/*` classic route; dispatches `/stacks` + `/admin` |
| Tenant (private) | `unidocs-cas-server-cloudflare` | canonical stack-scoped storage; behind edge |
| Admin BFF + UI (private) | `unidocs-cas-admin-webui` | Google OIDC + sessions; behind edge |
| Control D1 | `unidocs-cas-control` (`dc8090eb-…`) | issuers, stacks, members, control audit |
| Tenant D1 | `unidocs-cas-db` (`66f8738b-…`) | stack-scoped nodes/edges/root-refs |
| R2 | `unidocs-cas`, `unidocs-cas-preview` | node content |

Secrets live only as Worker secrets (Google OIDC client id/secret,
`SESSION_ENCRYPTION_KEYS`, `CAS_AUDIT_READER_KEY`, stack private keys) — never
in vars or source. Deployment credentials are supplied through
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`; see
[Deployment and local configuration](deployment-and-local-configuration.md).

## SLOs and error budgets

| SLO | Target | Measurement | Error budget (30d) |
|---|---|---|---|
| Edge availability | 99.9% | edge /health + routed request success | 43.8 min |
| Tenant + admin availability (via edge) | 99.9% | routed `/stacks` + `/admin` success | 43.8 min |
| Edge p95 latency (live) | < 500 ms | edge request duration | — |
| Tenant node read p95 (cached/DB) | < 200 ms | node metadata/content reads | — |
| Key rotation effectiveness | new key ≤ 60 s, revoked key ≤ 60 s | JWKS cache bounds (30 s TTL / 60 s hard stale) | — |
| Backup freshness | RPO ≤ 24 h | last successful D1 export timestamp | — |
| Restore | RTO ≤ 30 min | restore drill from exported SQL | — |

Error-budget burn: alert at 5% of monthly budget consumed per rolling 24 h,
page at 15%. Availability is measured from the edge (`/health` plus a routed
probe like the live smoke's lease+read); the tenant/admin workers are private
and measured through the edge.

## Metrics and events

Existing structured logs (JSON to the worker's stdout, queryable via the
Cloudflare dashboard / logpush):

- `cas_stack_authorization` — every authorization decision; `kind` ∈
  `authorized`, `denied`, `fail_closed`, `registry_stale`, `unknown_issuer`,
  `issuer_disabled`, `unsupported_algorithm`. **`fail_closed` is an incident
  signal** (registry unreachable past the hard bound, or a cold outage).
- `gateway_capability_issued` — gateway-signed capabilities.
- `doc_authentication` — doc-service session auth decisions.

Roll-up per 5-min window (via CF Analytics API or a logpush consumer):
edge request count + 5xx rate, tenant 401/403 rate by error code
(`invalid_token`, `unknown_issuer`, `registry_unavailable`,
`resource_scope_mismatch`), admin OIDC failures, D1 export success/failure.

## Alerting rules

| Alert | Condition | Severity | Response |
|---|---|---|---|
| Edge 5xx rate | > 1% of requests over 5 min | P1 | Check `wrangler deployments list` on edge/tenant/admin; rollback if a recent deploy regressed |
| `fail_closed` burst | `cas_stack_authorization` kind=`fail_closed` ≥ 3 in 5 min | P1 | D1 reachability from the tenant worker; registry row integrity |
| `registry_unavailable` 401/403 rate | > 0.5% of tenant requests over 5 min | P1 | Same as above |
| Unknown-issuer spike | `unknown_issuer` > threshold after a rotation | P2 | Issuer/keys registered? rotation SQL applied to the right stack? |
| Key age | any active issuer key older than 90 days | P2 | Run the rotation drill |
| Backup failure | scheduled D1 export fails | P2 | Re-run export; verify file non-empty (`--remote`!) |
| Admin OIDC failures | login error rate > threshold | P2 | Google client config, redirect URI, session keys |

## Runbooks

### Deploy

Order: **tenant → admin → edge** (backing workers first; edge last, matching
the original rollout). **Always rebuild first** — `wrangler deploy` uploads
`dist/`, and stale `dist` silently deploys old code:

```text
pnpm --filter @unicas/server-cloudflare exec tsc
pnpm --filter @unicas/server-cloudflare exec wrangler deploy
pnpm --filter @unicas/admin-webui build        # vite + assets + tsc
pnpm --filter @unicas/admin-webui exec wrangler deploy
pnpm --filter @unicas/edge exec wrangler deploy
node scripts/cas-middleware-smoke.mjs           # repeatable now; run twice 70s apart
```

The smoke script is repeatable (per-run tenant/requestId). Running it twice
with a 70s gap also proves the authority-cache refresh path (see the
hard-stale fix).

### Rollback

`wrangler` retains prior versions; reverse-order rollback is verified on the
deployed middleware (admin drill 2026-08-26):

```text
cd unicas-packages/<pkg>
wrangler deployments list
wrangler rollback            # move traffic to the retained prior version
# verify through the edge, then redeploy the current version if needed
wrangler deploy
```

Edge rollback reverts to the prior route/version — check the classic route
(`unicas.shazhou.work/*`) still matches after rolling back the edge.

### Backup and restore

Backup (manual or scheduled; daily target):

```text
wrangler d1 export unidocs-cas-control --remote --no-schema --output backup-cas-control.sql
wrangler d1 export unidocs-cas-db --remote --no-schema --output backup-cas-db.sql
```

`--remote` is mandatory (without it wrangler exports an empty local DB).
Store the SQL off-box (the gitignored `.wrangler/` copy is a working backup,
not a durable one). R2 content is referenced by node hashes in the tenant D1
backup; a restore re-verifies blobs through the canonical read path.

Restore (disaster drill; destructive — clears target tables first):

```text
wrangler d1 execute unidocs-cas-control --remote --command "<clear tables>"
wrangler d1 execute unidocs-cas-control --remote --file=backup-cas-control.sql
wrangler d1 execute unidocs-cas-db --remote --command "<clear tables>"
wrangler d1 execute unidocs-cas-db --remote --file=backup-cas-db.sql
```

Backups were verified 2026-08-26 (control 4.1 KB, tenant 2.0 KB, content
inspected). Restore was not executed against production (destructive); a
throwaway-D1 restore drill is a pending ops item.

### Issuer key rotation

Verified live 2026-08-26 (see round-9 notes). The `state` CHECK constraint
allows only `active` / `retiring` / `revoked` (no `retired`).

1. Generate a fresh ES256 pair; register the **public JWK** (kty/x/y/crv —
   the middleware adds kid/alg/use itself) in `cas_stack_issuer_keys` with
   state `active`, `ON CONFLICT(stack_id, kid) DO UPDATE` (idempotent).
2. Sign a capability with the NEW private key; it must verify at the edge
   after the 30 s cache window (expect 404 `NODE_NOT_FOUND` for an absent
   node, i.e. authentication passed). The OLD key keeps working throughout
   (coexistence window).
3. Retire the old key (`state='retiring'` → after the 60 s hard bound,
   `state='revoked'`) or delete the drill row entirely.
4. Keep the private key out of the repo; the drill harness persists it under
   `.wrangler/` (gitignored) and deletes it after the drill.

Revocation guarantee: a revoked key stops verifying within 60 s (the verifier
never serves a cached record past the hard bound unless a registry refresh
succeeds first — and a refresh that no longer lists the key fails closed).

### Key compromise

1. Add a replacement public key to `cas_stack_issuer_keys` (active).
2. Switch signers to the replacement private key.
3. Wait ≥ 60 s (revocation bound), then set the compromised key
   `state='revoked'`.
4. Rotate any secrets that may share the compromise (audit reader key,
   session encryption keys) and review `cas_control_audit_events` for the
   affected window.

### Incident checklist

1. Confirm edge `/health`; confirm routed `/stacks` + `/admin` probes.
2. `wrangler deployments list` on all three workers — recent deploy?
   Rollback first, diagnose later.
3. Grep `cas_stack_authorization` for `fail_closed` / `unknown_issuer` —
   registry reachability vs key/issuer config.
4. Check the tenant worker's D1 bindings (`CAS_CONTROL_DB`,
   `unidocs-cas-control`) and `wrangler d1 execute ... SELECT` reachability.
5. After resolution, run the smoke twice (70 s apart) to confirm both the
   happy path and the cache-refresh path.

## Pending ops items

- Scheduled backup job (Workers Cron or external) with alerting on failure.
- Throwaway-D1 restore drill (destructive restore not yet executed).
- Alert delivery integration (Cloudflare alerting webhooks or an external
  monitor like Better Stack / Grafana) wired to the rules above.
- Cloudflare analytics/logpush consumption for the 5-min roll-ups.
