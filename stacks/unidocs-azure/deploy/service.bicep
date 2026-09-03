targetScope = 'resourceGroup'

@description('doc type 名，同时决定 Container App 名 unidocs-{docType}、镜像 unidocs/azure-{docType} 与数据库 unidocs_{docType}。')
param docType string

param location string = resourceGroup().location

@description('镜像 tag，由部署脚本传入（git short sha）。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

param targetPort int
param minReplicas int
param maxReplicas int

@description('容器 CPU 核数,来自 azure.service.json。')
param cpu string = '0.5'

@description('容器内存,来自 azure.service.json。')
param memory string = '1Gi'

@description('单次上传字节上限;超过返回 413 而不是把容器撑崩。0 表示不限。')
param maxUploadBytes int = 0

@description('Cloudflare CAS worker 自身的基地址（不是 gateway 的）。过渡形态，阶段 4 删除。只有 docType=docx 时非空。')
param casBaseUrl string = ''

param pgAdminUser string = 'unidocs'

@secure()
param pgAdminPassword string

@secure()
param capabilityTrustedJwks string = ''

@description('控制面生成的不透明 stack id（形如 cas_XXXX）。CasClient 靠它拼规范路由 /stacks/{stackId}/tenants/...；缺了会拼成 legacy 路由，打到规范中间件一律 404。')
param casStackId string

@description('已注册的 stack issuer。委派 CAS 能力票由它签发，doc service 用它做验签的 issuer 断言。')
param casStackIssuer string

@description('该 stack 的公钥 JWKS（只含公钥）。doc service 只验签、不签发，所以拿不到私钥。')
@secure()
param casStackTrustedJwks string = ''

param capabilityIssuer string = 'unidocs-gateway:azure-dev'
param casCapabilityAudience string = 'unidocs-cas-azure'

@description('模型名。空 = 用 anthropic.ts 的默认 claude-opus-5。')
param llmModel string = ''

@description('Anthropic API key 明文,由 deploy.mjs 在部署时从 Key Vault 解析后传入(CLI 侧给的是 Key Vault 里的 secret 名,不是值本身)。空 = 不接 agent,operator 维持 501。')
@secure()
param llmApiKey string = ''

@description('图像编辑模型名。空 = 用 qwen-editor.ts 的默认 qwen-image-edit-plus。')
param imageEditModel string = ''

@description('图像编辑模型 API key 明文,由 deploy.mjs 在部署时从 Key Vault 解析后传入。空 = psd 没有 editPixels 工具。')
@secure()
param imageEditApiKey string = ''

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
    name: 'DOC_CAPABILITY_AUDIENCE'
    value: 'unidocs-doc:${docType}'
  }
  {
    name: 'CAS_CAPABILITY_AUDIENCE'
    value: casCapabilityAudience
  }
  {
    name: 'MAX_UPLOAD_BYTES'
    value: string(maxUploadBytes)
  }
  {
    name: 'CAS_STACK_ID'
    value: casStackId
  }
  {
    name: 'CAS_STACK_ISSUER'
    value: casStackIssuer
  }
  {
    name: 'CAPABILITY_ISSUER'
    value: capabilityIssuer
  }
  {
    name: 'CAS_STACK_ID'
    value: casStackId
  }
  {
    name: 'CAS_STACK_ISSUER'
    value: casStackIssuer
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
    value: '1800'
  }
  {
    name: 'CAPABILITY_CLOCK_SKEW_SECONDS'
    value: '30'
  }
]

// 模型名是明文,走普通 env,不是 secret——真正的密钥(llmApiKey /
// imageEditApiKey)走 container-app.bicep 的 secrets:/secretRef,见下面
// module 调用。空串不追加对应项,与 casEnv 同一套写法。
var modelEnv = concat(
  llmModel != '' ? [
    {
      name: 'LLM_MODEL'
      value: llmModel
    }
  ] : [],
  imageEditModel != '' ? [
    {
      name: 'IMAGE_EDIT_MODEL'
      value: imageEditModel
    }
  ] : []
)

var extraEnv = concat(blobEnv, casEnv, authEnv, modelEnv)

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
    cpu: cpu
    memory: memory
    databaseUrl: databaseUrl
    capabilityTrustedJwks: capabilityTrustedJwks
    casStackTrustedJwks: casStackTrustedJwks
    llmApiKey: llmApiKey
    imageEditApiKey: imageEditApiKey
    extraEnv: extraEnv
  }
}

output fqdn string = app.outputs.fqdn
