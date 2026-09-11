# stacks/unidocs-cloudflare/deploy/

**Cloudflare 的部署配置不在这里,在各个包里** ——
`packages/cloudflare-{gateway,markdown,docx,psd}/wrangler.toml`。

这不是遗漏,是 wrangler 的硬性要求:`wrangler.toml` 里的 `main`
(`dist/worker.js`)是**相对该文件自身**解析的,而 `wrangler deploy`
从包目录运行。把 toml 搬到这里会让每一条相对路径失效。

`deploy.mjs` 负责 docs → gateway 的应用栈顺序，仍由各包自己的 Wrangler
配置执行实际发布。真实部署要求 gateway 的数据面已启用访问令牌身份
（`createInsecureTenantIdentityResolver` 不再出现在 gateway 源码里，
`INSECURE_PATH_IDENTITY=true` 仅限本地）；`--dry-run` 可用于审查完整计划。

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

<!-- cas-contract-docs: migration-start -->
Use `wrangler secret put` only for private key/JWKS material; vars contain only
non-secret policy and audience values. Key/JWKS changes require Worker
deployment because running isolates do not hot-reload trust. `CAS_ACCESS_KEY`
and other shared-key bindings are rollout-era legacy dependencies and must be
removed after the production observation and rollback windows close.
<!-- cas-contract-docs: migration-end -->

UniCAS 的 tenant/admin/edge 部署已经独立归属 `stacks/unicas/deploy/`。
应用栈部署安全约束由本文件和 `docs/capability-key-operations.md` 共同定义。

## Portal Auth Preparation

Portal 使用独立的 `packages/cloudflare-portal/wrangler.jsonc`，不加入现有
docs/Gateway 默认部署序列。认证预检命令：

```text
node stacks/unidocs-cloudflare/deploy/portal-auth.mjs
```

进程环境须提供 `PORTAL_D1_DATABASE_ID`、`GATEWAY_OIDC_CLIENT_ID` 和规范化的
`PORTAL_BOOTSTRAP_EMAIL`。D1 必须独立创建，不能复用 Gateway 数据库或本地占位 ID。
该命令只生成临时无公网路由配置并执行 Wrangler `--dry-run`；不创建数据库、不应用
migration、不上传 secret、不部署 Worker。临时配置在成功或失败后都会删除，不含
Google client secret。不要把凭据放在命令参数中，也不要将 `cfg env` 的输出粘贴到对话。

生产配置为 `packages/cloudflare-portal/wrangler.production.jsonc`。2026-09-10
已创建独立 D1、注入 Google secret、应用远端 migration 并部署认证版 Worker。
预检仍仅做 dry-run，不验证真实 Google 登录；真人验收尚待完成。

**认证切换须确认**：新旧后台均使用 `/admin/auth/login`、`/admin/auth/session`
和 `__Host-unidocs_admin` cookie；旧 session 接口为 POST，新 BFF 查询接口为 GET。
只接管认证路径也会影响旧后台登录，不能描述为无影响的灰度。用户已明确批准切换，
生产 Portal 接管 `/admin` 和 `/admin/*`，不修改 Gateway 包或其原路由配置。
本地配置及预检配置仍为空 routes。当前后台只是认证验收，登录后显示 session JSON。
当前已登记的新 callback 为 `https://unidocs.shazhou.work/admin/auth/callback`；
Gateway 的原 OAuth callback 必须保留。

回退：将 Portal 生产配置的 `routes` 改成 `[]` 后执行
`pnpm --filter @unidocs/cloudflare-portal exec wrangler deploy --config wrangler.production.jsonc`，
使旧 Gateway catch-all 重新处理后台。保留所有 D1 数据，不删除 Worker secret，
不改旧 OAuth callback；共享 cookie 可能要求用户在旧后台重新登录。
仅回退 Worker 版本不能替代路由回退，需核对后台实际路由归属。
