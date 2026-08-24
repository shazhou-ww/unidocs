# UniDocs 测试布局整理

日期: 2026-08-24
状态: 已确认,已实施

## 1. 背景与目标

`scripts/` 同时放本地/Azure 运行时工具和大量 vitest 文件,`tests/` 只给 treespec YAML 树,`e2e/` 只有 Dockerfile。三套说法撞车,加测试时不知道该放哪。

**目标**: `scripts/` 只留可执行工具;vitest 进 `tests/`;treespec 独占 `tests/treespec/`(含 Dockerfile)。

**非目标**:

- 改测试断言或行为
- 合并薄 package、重组 `packages/`
- 改写历史 `docs/superpowers/plans/`(以及既有 specs 里的过期路径)

## 2. 目标树

```
scripts/                          # 工具 only,无 *.test.mjs
tests/
  unit/scripts/                   # 测脚本本身,不起服务
  integration/
    shared/behavior-suite.mjs
    cloudflare/                   # Miniflare HTTP / CF 端口契约
    azure/                        # 本地 Azure 栈 HTTP
  treespec/
    Dockerfile
    spec.yaml
    cas/
    create-new-markdown/
    create-new-docx/
```

`tests/bootstrap/` 整棵 YAML 树升为 `tests/treespec/`(不再套 `bootstrap/`)。根目录 `e2e/` 删除。

## 3. treespec.yaml

必须改,否则 `unit/`、`integration/` 会被当成 treespec 步骤:

- `image.dockerfile`: `tests/treespec/Dockerfile`
- `spec`: `tests/treespec`(原为 `tests`)

## 4. 命令

- `pnpm test`: 不变(`pnpm -r test`,各包 `packages/*/tests`)
- `pnpm test:local`: `vitest run --fileParallelism=false tests/unit tests/integration`
- 不新增根 `vitest.config.ts`
- `scripts/azure-smoke.mjs` 仍留在 `scripts/`,不进 `test:local`

## 5. 文件搬家

| 原路径 | 新路径 |
|---|---|
| `scripts/doc-types.test.mjs` | `tests/unit/scripts/doc-types.test.mjs` |
| `scripts/bundle-deps.test.mjs` | `tests/unit/scripts/bundle-deps.test.mjs` |
| `scripts/azure-deploy.test.mjs` | `tests/unit/scripts/azure-deploy.test.mjs` |
| `scripts/azure-ports.test.mjs` | `tests/unit/scripts/azure-ports.test.mjs` |
| `scripts/replica-proxy.test.mjs` | `tests/unit/scripts/replica-proxy.test.mjs` |
| `scripts/behavior-suite.mjs` | `tests/integration/shared/behavior-suite.mjs` |
| `scripts/local-runtime.test.mjs` | `tests/integration/cloudflare/local-runtime.test.mjs` |
| `scripts/cas-e2e.test.mjs` | `tests/integration/cloudflare/cas-e2e.test.mjs` |
| `scripts/docx-image-e2e.test.mjs` | `tests/integration/cloudflare/docx-image-e2e.test.mjs` |
| `scripts/editor-characterization.test.mjs` | `tests/integration/cloudflare/editor-characterization.test.mjs` |
| `scripts/editor-restart.test.mjs` | `tests/integration/cloudflare/editor-restart.test.mjs` |
| `scripts/cas-rollback.test.mjs` | `tests/integration/cloudflare/cas-rollback.test.mjs` |
| `scripts/svalue-editor-e2e.test.mjs` | `tests/integration/cloudflare/svalue-editor-e2e.test.mjs` |
| `scripts/cf-port-contract.test.mjs` | `tests/integration/cloudflare/cf-port-contract.test.mjs` |
| `scripts/port-probe-worker.js` | `tests/integration/cloudflare/port-probe-worker.js` |
| `scripts/azure-behavior.test.mjs` | `tests/integration/azure/azure-behavior.test.mjs` |
| `scripts/azure-multi-replica.test.mjs` | `tests/integration/azure/azure-multi-replica.test.mjs` |
| `scripts/azure-docx-image.test.mjs` | `tests/integration/azure/azure-docx-image.test.mjs` |
| `tests/bootstrap/**` | `tests/treespec/**` |
| `e2e/Dockerfile` | `tests/treespec/Dockerfile` |

搬家后更新相对 import、`tiny.png` 路径,以及仍在用的代码/README/treespec 注释。不改断言。
