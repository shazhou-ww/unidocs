targetScope = 'resourceGroup'

@description('doc type 名，同时决定 Container App 名 unidocs-{docType}、镜像 unidocs/azure-{docType} 与数据库 unidocs_{docType}。')
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
param serviceAccessKey string

@secure()
param casAccessKey string = ''

@secure()
param capabilityTrustedJwks string = ''

param internalAuthMode string = 'legacy'
param capabilityIssuer string = 'unidocs-gateway:azure-dev'
param casCapabilityAudience string = 'unidocs-cas'

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
var databaseUrl = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/unidocs_${docType}?sslmode=require'

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

var casEnv = casBaseUrl != '' ? [
  {
    name: 'CAS_BASE_URL'
    value: casBaseUrl
  }
] : []

var authEnv = [
  {
    name: 'INTERNAL_AUTH_MODE'
    value: internalAuthMode
  }
  {
    name: 'DOC_CAPABILITY_AUDIENCE'
    value: 'unidocs-doc:${docType}'
  }
  {
    name: 'CAS_CAPABILITY_AUDIENCE'
    value: casCapabilityAudience
  }
  {
    name: 'CAPABILITY_ISSUER'
    value: capabilityIssuer
  }
  {
    name: 'CAPABILITY_ALGORITHM'
    value: 'ES256'
  }
  {
    name: 'CAPABILITY_TTL_SECONDS'
    value: '120'
  }
  {
    name: 'CAPABILITY_MAX_LIFETIME_SECONDS'
    value: '300'
  }
  {
    name: 'CAPABILITY_CLOCK_SKEW_SECONDS'
    value: '30'
  }
]

var extraEnv = concat(blobEnv, casEnv, authEnv)

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
    serviceAccessKey: serviceAccessKey
    casAccessKey: casAccessKey
    capabilityTrustedJwks: capabilityTrustedJwks
    extraEnv: extraEnv
  }
}

output fqdn string = app.outputs.fqdn
