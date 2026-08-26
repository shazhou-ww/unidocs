targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('镜像 tag，由部署脚本传入（git short sha）。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

@description('Cloudflare CAS worker 自身的基地址（不是 gateway 的）。过渡形态，阶段 4 删除。')
param casBaseUrl string

@description('网关的 Container App 是否挂公网 ingress。默认值就是网关唯一有意义的取值——它必须能被公网访问；参数化只是为了让 packages/azure-gateway/azure.service.json 这份既有配置文件真正被读取，不是预期会被传别的值。')
param external bool = true

@description('网关容器监听的端口。默认值来自 packages/azure-gateway/src/main.ts 的监听端口，与 packages/azure-gateway/azure.service.json 一致。')
param targetPort int = 8787

param minReplicas int = 1
param maxReplicas int = 3

param pgAdminUser string = 'unidocs'

@secure()
param pgAdminPassword string

@secure()
param casAccessKey string

@secure()
param markdownAccessKey string

@secure()
param docxAccessKey string

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
var databaseUrl = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/unidocs_gateway?sslmode=require'

// P0 边界：文档服务在**部署时**注册进 DOC_SERVICES_JSON，不是运行时动态
// 发现。网关只认识这张静态表；加新 doc type 要改这份配置并重部网关，这是
// 刻意的（见 docs/superpowers/plans/2026-08-25-p0-microservice-boundaries-working.md
// Step 6 —— 部署期注册取代运行时 KV/Postgres 注册表）。
var docServicesJson = string({
  markdown: {
    serviceId: 'markdown'
    url: 'https://unidocs-markdown.internal.${containerEnv.properties.defaultDomain}'
    accessKey: markdownAccessKey
    audience: 'unidocs-doc:markdown'
  }
  docx: {
    serviceId: 'docx'
    url: 'https://unidocs-docx.internal.${containerEnv.properties.defaultDomain}'
    accessKey: docxAccessKey
    audience: 'unidocs-doc:docx'
  }
})

module app 'container-app.bicep' = {
  name: 'gateway-app'
  params: {
    name: 'unidocs-gateway'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-gateway:${imageTag}'
    targetPort: targetPort
    external: external
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    databaseUrl: databaseUrl
    casAccessKey: casAccessKey
    docServicesJson: docServicesJson
    // 网关不碰 Blob，所以没有 blobEnv。它经内部 ingress 的 443 访问
    // 两个 doc type worker —— 不是容器端口，ingress 负责映射。
    // 路由目标在 DOC_SERVICES_JSON 里静态列出，见上面的注释。
    extraEnv: [
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
      {
        name: 'INTERNAL_AUTH_MODE'
        value: 'legacy'
      }
      // This template deploys the explicitly named dev stack. Production
      // deployments must omit this and provide a real Gateway identity resolver.
      {
        name: 'INSECURE_PATH_IDENTITY'
        value: 'true'
      }
    ]
  }
}

output gatewayFqdn string = app.outputs.fqdn
