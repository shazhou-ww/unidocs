# CAS Durable Object memory reproduction

Temporary isolated Worker for testing whether concurrent tiny uploads through
a Durable Object and the production `unidocs-cas` service binding reproduce
the DOCX isolate memory failure. It contains no DOCX, ZIP, or SValue code.

The `/run` endpoint requires both a Wrangler secret (`REPRO_KEY`) and a
short-lived UniCAS capability. Each run uses a fresh DO name, uploads unique
canonical nodes, consumes every response body, then writes one value to DO
storage. Optional `--pad-mib` reserves and touches memory for the duration of
the run to model a larger caller-isolate baseline.

```powershell
$env:CLOUDFLARE_API_TOKEN = cfg get CLOUDFLARE_API_TOKEN
$env:CAS_DO_REPRO_KEY = [guid]::NewGuid().ToString("N")
$env:CAS_DO_REPRO_KEY | pnpm exec wrangler secret put REPRO_KEY -c scripts/cas-do-memory-repro/wrangler.jsonc
pnpm exec wrangler deploy -c scripts/cas-do-memory-repro/wrangler.jsonc

$env:CAS_DO_REPRO_URL = "https://unidocs-cas-do-memory-repro.<subdomain>.workers.dev"
$env:GATEWAY_SESSION_ENCRYPTION_KEY = cfg get GATEWAY_SESSION_ENCRYPTION_KEY
node scripts/cas-do-memory-repro/run.mjs --concurrency 6 --count 7 --content-bytes 512 --pad-mib 0

pnpm exec wrangler delete unidocs-cas-do-memory-repro --force
```