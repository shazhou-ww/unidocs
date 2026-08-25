targetScope = 'resourceGroup'

@description('部署位置。默认取资源组自身的位置。')
param location string = resourceGroup().location

@description('全局唯一资源名的稳定后缀。同一资源组重复部署得到同一后缀,这是幂等的依据。')
param nameSuffix string = uniqueString(resourceGroup().id)

var acrName = 'crunidocs${nameSuffix}'
var kvName = 'kvunidocs${nameSuffix}'
var storageName = 'stunidocs${nameSuffix}'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-unidocs-dev'
  location: location
}

// adminUserEnabled 必须为 false:订阅上有生效的策略
// "SFI — deny container registries with the local admin account enabled"。
// 拉镜像走下面的 AcrPull 角色分配,推镜像走部署者自己的 az 身份。
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// allowSharedKeyAccess 必须为 false:订阅上有生效的策略
// "SFI-ID4.2.1 — deny storage accounts with shared key access"。
// 这条策略正是 azure-sdk 的 Blob 客户端改用托管标识的原因。
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// 每个 Doc service 的 roots / snapshots 容器不在这里声明:ports-blob.ts 已经
// createIfNotExists() 懒建(packages/azure-sdk/src/ports-blob.ts:19,21),
// 而 Storage Blob Data Contributor 角色包含建容器的权限。
// 在这里再声明一遍会造成两个真相来源。

// Key Vault 只是部署脚本的幂等存储:生成一次的 Postgres 密码要能被后续
// 部署读回来,否则每次部署都会重置它。运行时不读它 —— 值经 @secure()
// 参数流进 Container App secret。
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    softDeleteRetentionInDays: 7
    enableSoftDelete: true
  }
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-unidocs-dev'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// AcrPull
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
// Storage Blob Data Contributor
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource blobData 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output nameSuffix string = nameSuffix
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = kv.name
output storageAccountName string = storage.name
output blobAccountUrl string = storage.properties.primaryEndpoints.blob
output identityId string = identity.id
output identityClientId string = identity.properties.clientId
