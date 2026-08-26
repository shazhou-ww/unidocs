# stacks/cloudflare/deploy/

**Cloudflare 的部署配置不在这里,在各个包里** ——
`packages/cloudflare-{gateway,markdown,docx,psd}/wrangler.toml` 与
`unicas-packages/{server-cloudflare,edge,admin-webui}/wrangler.toml`。

这不是遗漏,是 wrangler 的硬性要求:`wrangler.toml` 里的 `main`
(`dist/worker.js`)是**相对该文件自身**解析的,而 `wrangler deploy`
从包目录运行。把 toml 搬到这里会让每一条相对路径失效。

所以 Cloudflare 侧目前没有部署编排脚本 —— 部署就是在包目录里
`wrangler deploy`,一个 worker 一条命令,天然互不耦合。

## Capability deployment contract

1. Provision an ES256 signing key and environment-specific issuer.
2. Store `CAPABILITY_TRUSTED_JWKS` as a secret on CAS and every Doc worker.
  Set each Doc's exact audience and the CAS audience/lifetime policy as vars.
3. Deploy/restart CAS and Doc validators first and confirm the new trusted
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

这个目录存在是为了给将来真正属于"Cloudflare 部署编排"的东西留位置,
比如:

- CAS 中间件的一次性 provisioning(建 D1、填 `database_id`、
  `wrangler secret put`)—— 目前 `unicas-packages/server-cloudflare/wrangler.toml`
  与 `unicas-packages/admin-webui/wrangler.toml` 已部署(见
  `docs/superpowers/plans/2026-08-26-cas-middleware.md` 的 Task 9 部署记录)
- 多 worker 的顺序部署与冒烟,对应 `stacks/azure/deploy/deploy.mjs`

在有真实编排需求之前,不要为了对称而往这里塞脚本；部署安全约束由本文件
和 `docs/capability-key-operations.md` 共同定义。
