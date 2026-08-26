# stacks/cloudflare/deploy/

**Cloudflare 的部署配置不在这里,在各个包里** ——
`packages/cloudflare-{gateway,markdown,docx,psd,cas}/wrangler.toml`。

这不是遗漏,是 wrangler 的硬性要求:`wrangler.toml` 里的 `main`
(`dist/worker.js`)是**相对该文件自身**解析的,而 `wrangler deploy`
从包目录运行。把 toml 搬到这里会让每一条相对路径失效。

所以 Cloudflare 侧目前没有部署编排脚本 —— 部署就是在包目录里
`wrangler deploy`,一个 worker 一条命令,天然互不耦合。

这个目录存在是为了给将来真正属于"Cloudflare 部署编排"的东西留位置,
比如:

- CAS worker 的一次性 provisioning(建 D1 `unidocs-cas`、填 `database_id`、
  `wrangler secret put`)—— 目前 `packages/cloudflare-cas/wrangler.toml` 的
  `database_id` 还是 `REPLACE_WITH_CAS_D1_ID`,这个 worker 从未部署过
- 多 worker 的顺序部署与冒烟,对应 `stacks/azure/deploy/deploy.mjs`

在有真实内容之前,不要为了对称而往这里塞东西。
