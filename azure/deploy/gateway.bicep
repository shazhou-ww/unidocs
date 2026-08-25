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
    // 两个 doc type worker —— 不是容器端口，ingress 负责映射。
    // 这条路径复用 azure-gateway/src/main.ts 已有的 {TYPE}_WORKER_URL
    // 解析，不需要注册表服务。
    //
    // 过渡：Task 4 把网关改成查注册表之后，这两个变量整体删除。保留到那时是
    // 为了让本任务可以独立部署验证，不制造一个「网关找不到任何服务」的中间态。
    extraEnv: [
      {
        name: 'MARKDOWN_WORKER_URL'
        value: 'https://unidocs-markdown.internal.${containerEnv.properties.defaultDomain}'
      }
      {
        name: 'DOCX_WORKER_URL'
        value: 'https://unidocs-docx.internal.${containerEnv.properties.defaultDomain}'
      }
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
    ]
  }
}

output gatewayFqdn string = app.outputs.fqdn
