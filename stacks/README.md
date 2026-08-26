# stacks/

每朵云一个子目录,每个子目录内部分 `deploy/`(真实云部署)与 `local/`
(本机等价栈)。新增一朵云的支持时,照这个形状建目录即可。

```
stacks/
  azure/
    deploy/   Bicep 模板 + Dockerfile + deploy.mjs + smoke.mjs
    local/    runtime.mjs / ports.mjs / replica-proxy.mjs
  cloudflare/
    deploy/   (见该目录 README:wrangler.toml 按 wrangler 的要求留在各包内)
    local/    runtime.mjs / doc-types.mjs
```

## 与 `packages/` 的分界

`packages/{azure,cloudflare}-*` 是**代码** —— 被部署、被跑单测的东西。
`stacks/` 是**运维与工具** —— 怎么把那些代码构建成镜像/bundle、部署上云、
或者在本机起一套等价的栈。

依赖是单向的:`stacks/` 依赖 `packages/`,反过来不成立。推论 ——
**删掉整个 `stacks/azure/`,`pnpm build` / `typecheck` / `test` 依然全绿**,
丢失的只是"怎么部署 Azure"和"怎么在本机跑 Azure 栈"这两项能力。
(`stacks/cloudflare/local/` 不满足这条:`tests/integration/cloudflare/`
的强制门禁直接 import 它。)

## 与 `scripts/` 的分界

`scripts/` 只放**与云无关或两栈共享**的东西:

| 文件 | 为什么在这 |
|---|---|
| `dev.mjs` | 两栈共享的入口,`--azure` 在这里分派 |
| `workspace-aliases.mjs` | 两栈的 esbuild 打包共用同一份别名表(8 处 import) |
| `cas-digest.mjs` | 命令行算 CAS 哈希,与云无关 |
| `analyze-deps.mjs` | 依赖分析,与云无关 |
| `psd-do-memory-probe.mjs` | 一次性诊断工具(跑 workerd 测 DO 内存) |

判断依据:**只有一朵云用到的运行时/部署逻辑,放 `stacks/<cloud>/`;
两朵云都用到的、或者跟云无关的,放 `scripts/`。**
