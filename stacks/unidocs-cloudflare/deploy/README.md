# stacks/unidocs-cloudflare/deploy/

**Cloudflare 的部署配置不在这里,在各个包里** ——
`packages/cloudflare-{gateway,markdown,docx,psd}/wrangler.toml`。

这不是遗漏,是 wrangler 的硬性要求:`wrangler.toml` 里的 `main`
(`dist/worker.js`)是**相对该文件自身**解析的,而 `wrangler deploy`
从包目录运行。把 toml 搬到这里会让每一条相对路径失效。

`deploy.mjs` 负责 docs → gateway 的应用栈顺序，仍由各包自己的 Wrangler
配置执行实际发布。Gateway 仍使用 insecure identity resolver 时，真实部署会在
发布任何单元之前失败；`--dry-run` 可用于审查完整计划。

## Capability deployment contract

1. Provision an ES256 signing key and environment-specific issuer.
2. Store `CAPABILITY_TRUSTED_JWKS` as a secret on every Doc worker.
  Set each Doc's exact audience and the CAS audience/lifetime policy as vars.
3. Deploy/restart Doc validators first and confirm the new trusted
  `kid` from metadata-only startup diagnostics.
4. Store `CAPABILITY_PRIVATE_KEY_PKCS8` only on Gateway, set its active `kid`,
  issuer, Doc registry audiences, and CAS audience, then deploy Gateway.
5. Run capability-authenticated smoke paths and direct retired-legacy-header
  probes against every active worker. Observe unknown-key, issuer, audience,
  expiry, and permission failures without logging token values.
6. During rotation retain both public JWKs for at least $300+30=330$ seconds
  after switching Gateway before removing old trust.

Use `wrangler secret put` only for private key/JWKS material; vars contain only
non-secret policy and audience values. Key/JWKS changes require Worker
deployment because running isolates do not hot-reload trust. `CAS_ACCESS_KEY`
and other shared-key bindings are rollout-era legacy dependencies and must be
removed after the production observation and rollback windows close.

UniCAS 的 tenant/admin/edge 部署已经独立归属 `stacks/unicas/deploy/`。
应用栈部署安全约束由本文件和 `docs/capability-key-operations.md` 共同定义。
