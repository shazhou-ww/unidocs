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

@description('网关要路由到的 doc type 列表，由部署脚本从各包的 azure.service.json 展开。')
param docTypes array

@description('doc type -> 该服务的 SERVICE_ACCESS_KEY，JSON 字符串。整体作为一个 @secure() 参数传，而不是每个 doc type 一个参数——后者需要按 doc type 动态生成参数名，Bicep 做不到。')
@secure()
param docAccessKeysJson string

param pgAdminUser string = 'unidocs'

@secure()
param pgAdminPassword string

@secure()
param capabilityPrivateKeyPkcs8 string = ''

@secure()
param casStackPrivateKeyPkcs8 string = ''

param internalAuthMode string = 'stack'
param capabilityIssuer string = 'unidocs-gateway:azure-dev'
param capabilityKeyId string = ''
param casStackId string = 'unidocs-azure'
param casStackIssuer string = 'https://unicas.shazhou.work/cas/issuer/azure'
param casStackKeyId string = 'az-rotate-1'
param casRefDomain string = 'doc'
param casCapabilityAudience string = 'unidocs-cas-azure'

@description('控制面生成的不透明 stack id（形如 cas_XXXX）。不可自选——CAS 校验器拿 issuer 反查注册表得到 stackId，再与路径里的 stackId 比对，对不上就是 resource_scope_mismatch。')
param casStackId string

@description('已在控制面注册的 stack issuer。CAS 只用它当查表键，JWKS 从注册表读，绝不信任令牌自带的。')
param casStackIssuer string

@description('该 stack 下处于 active 的签名密钥 kid。')
param casStackKeyId string

@description('Root Refs 写入的业务域，必须已在该 stack 注册且 active。')
param casRefDomain string = 'doc'

@description('与 casStackKeyId 配对的私钥（PKCS8）。只有网关持有——doc service 拿公钥 JWKS。')
@secure()
param casStackPrivateKeyPkcs8 string = ''

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
var docServicesJson = string(toObject(docTypes, dt => dt, dt => {
  serviceId: dt
  url: 'https://unidocs-${dt}.internal.${containerEnv.properties.defaultDomain}'
  accessKey: json(docAccessKeysJson)[dt]
  audience: 'unidocs-doc:${dt}'
}))

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
    docServicesJson: docServicesJson
    capabilityPrivateKeyPkcs8: capabilityPrivateKeyPkcs8
    casStackPrivateKeyPkcs8: casStackPrivateKeyPkcs8
    // 网关不碰 Blob，所以没有 blobEnv。它经内部 ingress 的 443 访问
    // docTypes 里的每个 doc type worker —— 不是容器端口，ingress 负责映射。
    // 路由目标在 DOC_SERVICES_JSON 里静态列出，见上面的注释。
    extraEnv: [
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
      {
        name: 'INTERNAL_AUTH_MODE'
        value: internalAuthMode
      }
      {
        name: 'CAPABILITY_ISSUER'
        value: capabilityIssuer
      }
      {
        name: 'CAPABILITY_KEY_ID'
        value: capabilityKeyId
      }
      {
        name: 'CAS_CAPABILITY_AUDIENCE'
        value: casCapabilityAudience
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
        name: 'CAS_STACK_KEY_ID'
        value: casStackKeyId
      }
      {
        name: 'CAS_REF_DOMAIN'
        value: casRefDomain
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
