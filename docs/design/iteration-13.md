# Iteration 13：Markdown 发现入口与创建正文消费修复

日期：2026-09-08。状态：本地实现与新旧路径集成通过；已定位并修复此前 502 阻塞，未部署、未提交。独立 editor 与主站动态目录仍未完成。

## 当前改动

- [Markdown 发现入口](../../packages/cloudflare-markdown/src/discovery.ts) 提供 GET/HEAD `/.well-known/unidocs-doctype` 和 `/health`。需要部署显式配置 DOC_SERVICE_ID、DOC_STORAGE_IDENTITY、DOC_CAPABILITY_AUDIENCE；不猜测生产身份，缺少配置返回 503。
- health 仅检查配置，明确返回 configuration-only，不代表 CAS、鉴权或完整业务健康。
- Worker 增加 `/api/` 前缀别名，去掉前缀后进入原 createDocTypeHandler；原路径不变。不更改生产 registry、身份或 DO 数据。
- Markdown 微服务没有独立浏览器 editor，`/editor/` 明确返回 501；描述使用 editorProtocol=null、preview/edit=false，不把主站内置 Markdown 预览冒充该服务的嵌入能力。
- 管理目录接受无 editor 描述，只能登记为停用；启用或将已启用类型切到无 editor 服务返回 embedded_editor_unavailable。管理配置仍未接生产用户路由。
- DOC_SERVICE_ID 和 DOC_STORAGE_IDENTITY 尚未配置到生产，没有改变 Wrangler 或执行部署。

## 验证结果

- Markdown 单测 3 条通过：描述/缺配置/健康/方法约束、API 请求方法/正文/鉴权头/查询保留。
- gateway-common 描述契约 5 条通过；Cloudflare Gateway 目录测试 7 条通过（含无 editor 禁止启用）。
- cloudflare-markdown、gateway-common、cloudflare-gateway 类型检查通过。
- 已有 svalue-editor-e2e 集成 2 条通过，作为旧路径对照。
- 新 [markdown-discovery 集成](../../tests/integration/cloudflare/markdown-discovery.test.mjs) 现已通过：JSON `{}` 创建、旧路径写入到 v2、同一持久目录重启后 `/api/` 读取 v2 并写入 v3、两种路径无鉴权读取均拒绝。此前失败发生在旧路径首次 apply，返回 Document worker unreachable / Network connection lost，修复过程见下节。

此前尝试增加响应诊断、将未授权探测改成无正文读取并消费响应、将该探测移到读写链路之后；结果不变。未授权探测和提前初始化鉴权的假设没有获得支持，没有据此修改鉴权实现。以下修复保留原失败条件，不跳过或延长超时。

## 根因与修复

1. 对照既有通过测试，给 apply 加 opId 后仍失败，排除缺省 opId。最终测试恢复为不带 opId。
2. 临时测试入口包装原 Markdown Worker，确认创建请求到达并返回 200，但随后失败的 apply 没有进入 Worker，且未捕获 Worker 内部异常。证据将问题收窄至上游 HTTP 传输，而不是 Markdown 引擎或操作计算。
3. 仅将创建请求从 JSON `{}` 改成空正文，完整测试通过。此前通过的旧测试正是空正文创建。
4. [SValue Editor 的 create 分支](../../packages/cloudflare-sdk/src/editor-do-svalue.ts) 对 multipart 会读取 formData，但非 multipart 空白创建直接 config.init，没有消费正文。在本地 workerd HTTP 转发链路中，前次创建虽返回成功，未消费的请求正文导致后续请求断连。没有证据表明是 Content-Length 被改写。
5. 在非 multipart 分支调用 request.body.pipeTo(WritableStream) 流式消费不使用的正文，再执行原 init。没有解析/物化正文，不增加全文内存缓冲、不更改鉴权或创建内容语义。恢复 `{}` 创建后，原失败测试完整通过。

临时探针已移除，没有加入生产调试入口。实际连接复用的底层 workerd 实现未做抓包分析；结论基于请求到达探针与两组单变量对照，不泛化为所有云运行时均出现相同故障。

本次修复回归：cloudflare-sdk 47 条、既有 svalue-editor-e2e 2 条、explicit-commit 6 条、新 markdown-discovery 1 条，共 56 条通过；cloudflare-sdk 与 cloudflare-markdown 类型检查通过。所有集成使用临时本地数据，无生产作品修改。

## 后续

新旧路径鉴权读写阻塞已解除，可以继续统一 editor 入口和主站动态目录接入。后台依旧只管理一个 base URL 与 enabled，版本和部署继续归 doctype 自身管理；不将本次发现入口验收视为完整动态注册已上线。