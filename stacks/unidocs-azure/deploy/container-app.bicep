@description('Container App 名称。')
param name string
param location string
param environmentId string

@description('用户分配托管标识的资源 ID。同时用于拉镜像与访问 Blob。')
param identityId string

@description('完整镜像引用，形如 unidocsacr.azurecr.io/unidocs/azure-markdown:abc1234。')
param image string
param acrLoginServer string

param targetPort int
@description('true = 公网 ingress；false = 仅环境内可达。')
param external bool
param minReplicas int
param maxReplicas int

@description('容器 CPU 核数。默认 0.5 —— 对导入大文档的 doc type 明显不够。')
param cpu string = '0.5'

@description('容器内存。默认 1Gi。导入路径把整个文件读进内存(formData 一份、arrayBuffer 再一份),再加文档类型自己的解压表示,所以这个值要按最大可接受上传体积的数倍留。')
param memory string = '1Gi' 

@description('明文环境变量，形如 [{ name: "BLOB_ACCOUNT_URL", value: "https://..." }]。PORT 由模块从 targetPort 自动派生，不要在这里再传一份。')
param extraEnv array = []

@secure()
param databaseUrl string
@secure()
param docServicesJson string = ''
@secure()
param capabilityPrivateKeyPkcs8 string = ''
@secure()
param capabilityTrustedJwks string = ''
// Stack 模式：网关用私钥签 CAS 能力票，doc service 只拿公钥 JWKS 验签。
// 两者互斥地由 gateway.bicep / service.bicep 各传一个，另一个留空。
@secure()
param casStackPrivateKeyPkcs8 string = ''
@secure()
param casStackTrustedJwks string = ''
// agent 用的模型 key,doc service(operator)专用。都可选、默认空串——
// 空 = 这个 doc type 不接 agent,不注入对应 secret/env,operator 维持 501。
@secure()
param llmApiKey string = ''
@secure()
param imageEditApiKey string = ''

// PORT 必须和 ingress.targetPort 是同一个值的两种表现形式，而不是
// 调用方各自再写一份字符串字面量——否则 ingress 转发到一个端口、
// 容器监听另一个端口的漂移只会在运行时以连接失败的形式出现，
// az bicep build / what-if 都不会报错。
var port = string(targetPort)
var optionalSecrets = concat(
  empty(docServicesJson) ? [] : [
    {
      name: 'doc-services-json'
      value: docServicesJson
    }
  ],
  empty(capabilityPrivateKeyPkcs8) ? [] : [
    {
      name: 'capability-private-key-pkcs8'
      value: capabilityPrivateKeyPkcs8
    }
  ],
  empty(capabilityTrustedJwks) ? [] : [
    {
      name: 'capability-trusted-jwks'
      value: capabilityTrustedJwks
    }
  ],
  empty(casStackPrivateKeyPkcs8) ? [] : [
    {
      name: 'cas-stack-private-key-pkcs8'
      value: casStackPrivateKeyPkcs8
    }
  ],
  empty(casStackTrustedJwks) ? [] : [
    {
      name: 'cas-stack-trusted-jwks'
      value: casStackTrustedJwks
    }
  ],
  empty(llmApiKey) ? [] : [
    {
      name: 'llm-api-key'
      value: llmApiKey
    }
  ],
  empty(imageEditApiKey) ? [] : [
    {
      name: 'image-edit-api-key'
      value: imageEditApiKey
    }
  ]
)
var optionalSecretEnv = concat(
  empty(docServicesJson) ? [] : [
    {
      name: 'DOC_SERVICES_JSON'
      secretRef: 'doc-services-json'
    }
  ],
  empty(capabilityPrivateKeyPkcs8) ? [] : [
    {
      name: 'CAPABILITY_PRIVATE_KEY_PKCS8'
      secretRef: 'capability-private-key-pkcs8'
    }
  ],
  empty(capabilityTrustedJwks) ? [] : [
    {
      name: 'CAPABILITY_TRUSTED_JWKS'
      secretRef: 'capability-trusted-jwks'
    }
  ],
  empty(casStackPrivateKeyPkcs8) ? [] : [
    {
      name: 'CAS_STACK_PRIVATE_KEY_PKCS8'
      secretRef: 'cas-stack-private-key-pkcs8'
    }
  ],
  empty(casStackTrustedJwks) ? [] : [
    {
      name: 'CAS_STACK_TRUSTED_JWKS'
      secretRef: 'cas-stack-trusted-jwks'
    }
  ],
  empty(llmApiKey) ? [] : [
    {
      name: 'LLM_API_KEY'
      secretRef: 'llm-api-key'
    }
  ],
  empty(imageEditApiKey) ? [] : [
    {
      name: 'IMAGE_EDIT_API_KEY'
      secretRef: 'image-edit-api-key'
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
            cpu: json(cpu)
            memory: memory
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
