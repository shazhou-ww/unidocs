targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('镜像 tag，由部署脚本传入（git short sha）。这里只有 migrateJob 用得到。')
param imageTag string

param pgAdminUser string = 'unidocs'

@secure()
param pgAdminPassword string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'unidocs-identity'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'unidocsacr'
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: 'unidocs-logs'
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'unidocs-pg'
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

// P0 边界：Gateway 与每个 Doc service 各有独占的数据库。网关不再与
// doc-type worker 共享同一个 schema —— 目录表归网关、会话表归服务。
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
// 只在这里拼一次，供下面的 migrateJob 用 —— 不从别的模板 output 传入，
// 也不把它自己 output 出去：那会把明文密码写进部署历史。
var databaseOrigin = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432'
var gatewayDatabaseUrl = '${databaseOrigin}/${gatewayDatabase.name}?sslmode=require'
var markdownDatabaseUrl = '${databaseOrigin}/${markdownDatabase.name}?sslmode=require'
var docxDatabaseUrl = '${databaseOrigin}/${docxDatabase.name}?sslmode=require'

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'unidocs-env'
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

// 迁移 Job 必须走模块边界，理由见 stacks/azure/deploy/migrate-job.bicep 顶部的注释：
// databaseUrl 由 @secure() pgAdminPassword 拼出，直接写进外层模板的资源
// 属性会让 what-if 把明文连接串打进终端与日志。
//
// 三个 Job 对应三个独占数据库：网关的目录 schema 走 azure-gateway 自己的
// 迁移镜像（dist/migrate-cli.js），两个 Doc service 复用 azure-sdk 的
// 会话 schema 迁移镜像。
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

output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output migrateJobNames array = [
  gatewayMigrateJob.outputs.name
  markdownMigrateJob.outputs.name
  docxMigrateJob.outputs.name
]
