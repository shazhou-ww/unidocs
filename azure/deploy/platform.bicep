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

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'unidocs'
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
var databaseUrl = 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/unidocs?sslmode=require'

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

// 迁移 Job 必须走模块边界，理由见 azure/deploy/migrate-job.bicep 顶部的注释：
// databaseUrl 由 @secure() pgAdminPassword 拼出，直接写进外层模板的资源
// 属性会让 what-if 把明文连接串打进终端与日志。
module migrateJob 'migrate-job.bicep' = {
  name: 'migrate-job'
  params: {
    name: 'unidocs-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
    databaseUrl: databaseUrl
  }
}

output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output migrateJobName string = migrateJob.outputs.name
