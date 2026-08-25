@description('迁移 Job 名称。')
param name string
param location string
param environmentId string

@description('用户分配托管标识的资源 ID。只用于从 ACR 拉镜像 —— 迁移不碰 Blob。')
param identityId string

@description('完整镜像引用，形如 crunidocsxxx.azurecr.io/unidocs/azure-migrate:abc1234。')
param image string
param acrLoginServer string

// 这个模块存在的唯一理由是**模块边界**：Bicep 编译时会把外层模板里的
// 表达式内联到资源属性上，而由 @secure() 参数拼出的连接串一旦这样落在
// 外层模板里，`az deployment group what-if` 对一个 Create 变更会把完整
// 资源体（含明文连接串）打印到终端，部署脚本又用 stdio:"inherit" 透传、
// 计划再把它 tee 进日志文件。作为模块参数传入时，编译产物是嵌套部署的
// `expressionEvaluationOptions.scope: "inner"` + securestring 参数，
// 明文不再出现在外层模板中。三个 Container App 早就是这个形状
// （azure/deploy/container-app.bicep），这里补上 Job 的那一半。
@secure()
param databaseUrl string

// 迁移只需要 DATABASE_URL：migrate-cli.ts 只调 createPool() 与
// runMigrations(pool)，从不构造 BlobServiceClient。
resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
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
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
        }
      ]
    }
  }
}

output name string = migrateJob.name
