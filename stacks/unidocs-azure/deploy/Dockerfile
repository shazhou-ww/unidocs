# syntax=docker/dockerfile:1

# 一份 Dockerfile 产出服务与迁移镜像,由 SERVICE/ENTRY 选择:
#   azure-gateway / azure-markdown / azure-docx  -> ENTRY=dist/main.js
#   azure-gateway                                -> ENTRY=dist/migrate-cli.js(Gateway migration)
#   azure-sdk                                    -> ENTRY=dist/migrate-cli.js(Doc migration)
#
# 裁剪用 `pnpm deploy --prod`:它产出真实(非软链)的 node_modules,并且
# 严格按 package.json 的声明裁剪 —— 一个漏声明的运行时依赖会让构建产出
# 一个起不来的镜像,而不是等到生产才 ERR_MODULE_NOT_FOUND。

ARG SERVICE
ARG ENTRY=dist/main.js

FROM node:24-alpine AS builder
ARG SERVICE
WORKDIR /repo

# 公司环境只允许 Microsoft npm proxy,而它没有 corepack 所需的按版本
# 解析端点。用 npm install -g 走标准 packument/tarball 路径。版本从
# packageManager 字段读取,不硬编码(否则会是第二个真相来源)。
COPY package.json /tmp/package.json
RUN PNPM_VERSION=$(node -e "process.stdout.write(require('/tmp/package.json').packageManager.match(/^pnpm@([0-9.]+)/)[1])") \
    && rm /tmp/package.json \
    && npm install -g "pnpm@${PNPM_VERSION}" --registry=https://packagefeedproxy.microsoft.io/npm/ \
    && [ "$(pnpm --version)" = "$PNPM_VERSION" ]

# 整个工作区一次性拷入:pnpm install --frozen-lockfile 需要每一个工作区
# 包的 package.json 都在场,分层拷贝在 monorepo 里要靠 find 拼,得不偿失。
COPY . .

RUN pnpm install --frozen-lockfile --registry=https://packagefeedproxy.microsoft.io/npm/
RUN pnpm -r build
# --legacy:pnpm 10 起,未启用 inject-workspace-packages 的工作区不加这个
# 会直接 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE。
# --registry:deploy 会重新向 registry 解析依赖,不带镜像源会卡在被 SNI
# 拦截的公网源上。两个开关都是实测确认必需的,不要删。
RUN pnpm deploy --legacy --filter "@unidocs/${SERVICE}" --prod \
    --registry=https://packagefeedproxy.microsoft.io/npm/ /out

FROM node:24-alpine AS runtime
ARG ENTRY
WORKDIR /app
COPY --from=builder /out ./
ENV NODE_ENV=production
ENV ENTRY=${ENTRY}
# exec 形式让 node 成为 PID 1,SIGTERM 才能到达进程自己的关停处理器
# (doc-type-service.ts 与 azure-gateway/src/main.ts 都装了 SIGTERM handler)。
CMD ["sh", "-c", "exec node $ENTRY"]
