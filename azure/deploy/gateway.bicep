targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('镜像 tag，由部署脚本传入（git short sha）。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

@description('Cloudflare CAS worker 自身的基地址（不是 gateway 的）。过渡形态，阶段 4 删除。')
param casBaseUrl string

param pgAdminUser string = 'unidocs'

@secure()
param pgAdminPassword string

@secure()
param internalToken string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'unidocs-identity'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'unidocsacr'
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: 'unidocs-pg'
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'unidocs-env'
}

// sslmode=require：Flexible Server 强制 TLS，而 createPool() 不设 ssl
// 选项，行为完全由连接串决定。每个独立部署单元各自拼一次 —— 不从
// platform.bicep 的 output 传入，也不把它自己 output 出去：那会把明文
// 密码写进部署历史。
var databaseUrl = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/unidocs?sslmode=require'

module app 'container-app.bicep' = {
  name: 'gateway-app'
  params: {
    name: 'unidocs-gateway'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-gateway:${imageTag}'
    targetPort: 8787
    external: true
    minReplicas: 1
    maxReplicas: 3
    databaseUrl: databaseUrl
    internalToken: internalToken
    // 网关不碰 Blob，所以没有 blobEnv。它经内部 ingress 的 443 访问
    // doc type worker —— 不是容器端口，ingress 负责映射。
    // 路由目标不在这里静态列出：网关在启动时读 Postgres 的 doc_types
    // 注册表（azure-gateway/src/main.ts 的 `makeResolveWorkerUrl`），
    // 各 doc type 服务自己在 listen 之后把 SELF_WORKER_URL upsert 进那张表。
    // 这就是「加新 doc type 不用改网关」的关键——本文件不含任何 doc type 名。
    extraEnv: [
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
    ]
  }
}

output gatewayFqdn string = app.outputs.fqdn
