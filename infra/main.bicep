targetScope = 'resourceGroup'

param location string = resourceGroup().location
param nameSuffix string = uniqueString(resourceGroup().id)

@description('镜像 tag，由部署脚本传入（git short sha）。不用 latest —— Container Apps 需要镜像引用变化才会滚动 revision。')
param imageTag string

@description('Cloudflare CAS worker 自身的基地址（不是 gateway 的）。过渡形态，阶段 4 删除。')
param casBaseUrl string

@secure()
param pgAdminPassword string

@secure()
param casAccessKey string

@secure()
param markdownAccessKey string

@secure()
param docxAccessKey string

param pgAdminUser string = 'unidocs'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-unidocs-dev'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'crunidocs${nameSuffix}'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'stunidocs${nameSuffix}'
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: 'log-unidocs-dev'
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-unidocs-${nameSuffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    // 17：与本订阅现有 8 台 Flexible Server 一致。
    version: '17'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource gatewayDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'unidocs_gateway'
}

resource markdownDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'unidocs_markdown'
}

resource docxDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'unidocs_docx'
}

// 设计 §4.4：显式的 dev 期妥协。0.0.0.0-0.0.0.0 是 Azure 约定的
// "允许 Azure 服务和资源访问此服务器" —— 放行整个 Azure 平台的出站
// 流量（不只本订阅），但不放行公网任意来源。唯一的实际屏障是强随机
// 管理员密码。本设计刻意不依赖"消费型 Container Apps 环境有稳定的
// 可枚举出口 IP"这一未验证前提。要做 IP 级限制需换环境形态（工作负载
// 配置文件 + VNet + NAT 网关或私有端点），那是前置条件而非延后加固。
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// sslmode=require：Flexible Server 强制 TLS，而 createPool() 不设 ssl
// 选项，行为完全由连接串决定（设计 §6.3 —— 这条需要实测确认）。
var databaseOrigin = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432'
var gatewayDatabaseUrl = '${databaseOrigin}/${gatewayDatabase.name}?sslmode=require'
var markdownDatabaseUrl = '${databaseOrigin}/${markdownDatabase.name}?sslmode=require'
var docxDatabaseUrl = '${databaseOrigin}/${docxDatabase.name}?sslmode=require'

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-unidocs-dev'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

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

module markdownApp 'container-app.bicep' = {
  name: 'markdown-app'
  params: {
    name: 'ca-unidocs-markdown'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-markdown:${imageTag}'
    targetPort: 8788
    external: false
    // minReplicas = 2 是刻意的：阶段 3 证明的是多副本拓扑下的并发
    // 正确性（条件写 + (doc_type, doc_id, version) 主键），生产上跑
    // 单副本等于把那份保证退回未验证状态。
    minReplicas: 2
    maxReplicas: 5
    databaseUrl: markdownDatabaseUrl
    serviceAccessKey: markdownAccessKey
    extraEnv: blobEnv
  }
}

module docxApp 'container-app.bicep' = {
  name: 'docx-app'
  params: {
    name: 'ca-unidocs-docx'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-docx:${imageTag}'
    targetPort: 8789
    external: false
    minReplicas: 2
    maxReplicas: 5
    databaseUrl: docxDatabaseUrl
    serviceAccessKey: docxAccessKey
    casAccessKey: casAccessKey
    extraEnv: concat([
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
      }
    ], blobEnv)
  }
}

module gatewayApp 'container-app.bicep' = {
  name: 'gateway-app'
  params: {
    name: 'ca-unidocs-gateway'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-gateway:${imageTag}'
    targetPort: 8787
    external: true
    minReplicas: 1
    maxReplicas: 3
    databaseUrl: gatewayDatabaseUrl
    casAccessKey: casAccessKey
    docServicesJson: string({
      markdown: {
        serviceId: 'markdown'
        url: 'https://${markdownApp.outputs.fqdn}'
        accessKey: markdownAccessKey
      }
      docx: {
        serviceId: 'docx'
        url: 'https://${docxApp.outputs.fqdn}'
        accessKey: docxAccessKey
      }
    })
    // 网关不碰 Blob，所以没有 blobEnv。它经内部 ingress 的 443 访问
    // 两个 doc type worker —— 不是容器端口，ingress 负责映射。
    extraEnv: [
      {
        name: 'CAS_BASE_URL'
        value: casBaseUrl
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

// 迁移 Job 必须走模块边界，理由见 infra/migrate-job.bicep 顶部的注释：
// databaseUrl 由 @secure() pgAdminPassword 拼出，直接写进外层模板的资源
// 属性会让 what-if 把明文连接串打进终端与日志。
module gatewayMigrateJob 'migrate-job.bicep' = {
  name: 'gateway-migrate-job'
  params: {
    name: 'caj-unidocs-gateway-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-gateway-migrate:${imageTag}'
    databaseUrl: gatewayDatabaseUrl
  }
}

module markdownMigrateJob 'migrate-job.bicep' = {
  name: 'markdown-migrate-job'
  params: {
    name: 'caj-unidocs-markdown-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
    databaseUrl: markdownDatabaseUrl
  }
}

module docxMigrateJob 'migrate-job.bicep' = {
  name: 'docx-migrate-job'
  params: {
    name: 'caj-unidocs-docx-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
    databaseUrl: docxDatabaseUrl
  }
}

output gatewayFqdn string = gatewayApp.outputs.fqdn
output migrateJobNames array = [
  gatewayMigrateJob.outputs.name
  markdownMigrateJob.outputs.name
  docxMigrateJob.outputs.name
]
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
