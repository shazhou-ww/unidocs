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

@description('明文环境变量，形如 [{ name: "BLOB_ACCOUNT_URL", value: "https://..." }]。PORT 由模块从 targetPort 自动派生，不要在这里再传一份。')
param extraEnv array = []

@secure()
param databaseUrl string
@secure()
param serviceAccessKey string = ''
@secure()
param casAccessKey string = ''
@secure()
param docServicesJson string = ''

// PORT 必须和 ingress.targetPort 是同一个值的两种表现形式，而不是
// 调用方各自再写一份字符串字面量——否则 ingress 转发到一个端口、
// 容器监听另一个端口的漂移只会在运行时以连接失败的形式出现，
// az bicep build / what-if 都不会报错。
var port = string(targetPort)
var optionalSecrets = concat(
  empty(serviceAccessKey) ? [] : [
    {
      name: 'service-access-key'
      value: serviceAccessKey
    }
  ],
  empty(casAccessKey) ? [] : [
    {
      name: 'cas-access-key'
      value: casAccessKey
    }
  ],
  empty(docServicesJson) ? [] : [
    {
      name: 'doc-services-json'
      value: docServicesJson
    }
  ]
)
var optionalSecretEnv = concat(
  empty(serviceAccessKey) ? [] : [
    {
      name: 'SERVICE_ACCESS_KEY'
      secretRef: 'service-access-key'
    }
  ],
  empty(casAccessKey) ? [] : [
    {
      name: 'CAS_ACCESS_KEY'
      secretRef: 'cas-access-key'
    }
  ],
  empty(docServicesJson) ? [] : [
    {
      name: 'DOC_SERVICES_JSON'
      secretRef: 'doc-services-json'
    }
  ]
)

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
      secrets: concat([
          {
            name: 'database-url'
            value: databaseUrl
          }
        ], optionalSecrets)
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
                name: 'PORT'
                value: port
              }
              {
                name: 'DATABASE_URL'
                secretRef: 'database-url'
              }
            ],
            optionalSecretEnv,
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
