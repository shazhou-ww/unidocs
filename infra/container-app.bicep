@description('Container App 名称。')
param name string
param location string
param environmentId string

@description('用户分配托管标识的资源 ID。同时用于拉镜像与访问 Blob。')
param identityId string

@description('完整镜像引用，形如 crunidocsxxx.azurecr.io/unidocs/azure-markdown:abc1234。')
param image string
param acrLoginServer string

param targetPort int
@description('true = 公网 ingress；false = 仅环境内可达。')
param external bool
param minReplicas int
param maxReplicas int

@description('明文环境变量，形如 [{ name: "PORT", value: "8788" }]。')
param extraEnv array = []

@secure()
param databaseUrl string
@secure()
param internalToken string

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      // ACR 的 admin 账号被策略禁用，拉镜像只能走托管标识 + AcrPull。
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'internal-token'
          value: internalToken
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(
            [
              {
                name: 'DATABASE_URL'
                secretRef: 'database-url'
              }
              {
                name: 'INTERNAL_TOKEN'
                secretRef: 'internal-token'
              }
            ],
            extraEnv
          )
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
