targetScope = 'resourceGroup'

@description('doc type 名，同时决定 Container App 名 unidocs-{docType} 与镜像 unidocs/azure-{docType}。')
param docType string

param location string = resourceGroup().location

@description('镜像 tag，由部署脚本传入（git short sha）。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

param targetPort int
param minReplicas int
param maxReplicas int

@description('Cloudflare CAS worker 自身的基地址（不是 gateway 的）。过渡形态，阶段 4 删除。只有 docType=docx 时非空。')
param casBaseUrl string = ''

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

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'unidocsblob'
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

var blobAccountUrl = storage.properties.primaryEndpoints.blob

// 用户分配的托管标识必须显式告诉 DefaultAzureCredential 用哪个身份。
// 缺了它容器能启动、能通过健康检查，失败推迟到第一次 Blob 操作 ——
// azure-sdk 的 resolveBlobConfig() 因此把它作为启动期硬性要求。
var blobEnv = [
  {
    name: 'BLOB_ACCOUNT_URL'
    value: blobAccountUrl
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: identity.properties.clientId
  }
]

// Container Apps 的内部 FQDN 是 `<app名>.internal.<环境默认域>`，由 app 名
// 与环境确定性推出，不需要该 App 已存在 —— 所以这里没有先有鸡还是先有蛋的
// 问题。服务拿到它之后在启动时把自己 upsert 进 doc_types 表，网关查表路由。
// 这取代了原先「网关读 markdownApp.outputs.fqdn」的做法，那正是三个 App
// 必须在同一次部署里的根因。
var selfWorkerUrl = 'https://unidocs-${docType}.internal.${containerEnv.properties.defaultDomain}'

var casEnv = casBaseUrl != '' ? [
  {
    name: 'CAS_BASE_URL'
    value: casBaseUrl
  }
] : []

var extraEnv = concat(blobEnv, [
  {
    name: 'SELF_WORKER_URL'
    value: selfWorkerUrl
  }
], casEnv)

module app 'container-app.bicep' = {
  name: '${docType}-app'
  params: {
    name: 'unidocs-${docType}'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-${docType}:${imageTag}'
    targetPort: targetPort
    external: false
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    databaseUrl: databaseUrl
    internalToken: internalToken
    extraEnv: extraEnv
  }
}

output fqdn string = app.outputs.fqdn
