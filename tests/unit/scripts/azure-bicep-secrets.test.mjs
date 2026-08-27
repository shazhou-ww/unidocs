/**
 * 挡住一类只在真部署时才暴露的缺陷:`@secure()` 派生的表达式被内联进外层
 * 模板,导致 `az deployment group what-if` 对 Create 变更把明文连接串/密钥
 * 打进终端与日志(部署脚本用 stdio:"inherit" 透传)。上一轮真的踩过一次。
 *
 * 直接验 what-if 需要订阅写权限,这里改验 `az bicep build` 的编译产物——
 * 同样能区分"跨了 module 边界(securestring)"与"内联进外层模板(明文)",
 * 而且不需要任何 Azure 权限。
 *
 * 没装 az CLI 时跳过而不是失败:贡献者不该为了跑单测装 Azure CLI。代价是
 * 这层网只在装了 az 的机器上张开——所以 Task 3 的验收里要求手工跑一次。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function hasAz() {
  try {
    execFileSync("az", ["bicep", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const AZ = hasAz();

function compile(template) {
  const stdout = execFileSync(
    "az",
    ["bicep", "build", "--file", join(ROOT, "stacks/azure/deploy", template), "--stdout"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** 外层模板里所有嵌套部署资源。 */
function nestedDeployments(arm) {
  return arm.resources.filter((r) => r.type === "Microsoft.Resources/deployments");
}

/**
 * 外层模板里，一个 @secure() 参数只允许以**直接引用**
 * `[parameters('<name>')]` 出现。任何把它包进更长表达式的形式——
 * format() / concat() / union() / 字符串插值——结果都只是普通字符串，
 * securestring 的血统在那一步断掉，what-if 对 Create 变更会原样打印。
 *
 * 扫描范围含 outputs：`az deployment group create` 默认把 output 值打到
 * 终端，部署脚本还 tee 进日志，所以它和资源属性一样是泄漏面。
 * 嵌套部署被排除——跨了 module 边界的值由内层的 securestring 参数接住。
 *
 * 返回违规的 `<路径> = <表达式>` 列表；空数组代表这个参数干净。
 */
function secureParamOffenders(arm, paramName) {
  const directRef = `[parameters('${paramName}')]`;
  const needle = `parameters('${paramName}')`;
  const offenders = [];
  const walk = (node, path) => {
    if (typeof node === "string") {
      if (node.includes(needle) && node !== directRef) {
        offenders.push(`${path} = ${node}`);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  walk(arm.variables ?? {}, "variables");
  for (const r of arm.resources ?? []) {
    if (r.type === "Microsoft.Resources/deployments") continue;
    walk(r, `resources.${r.type}`);
  }
  walk(arm.outputs ?? {}, "outputs");
  return offenders;
}

describe.skipIf(!AZ)("gateway.bicep 的密钥不落进外层模板", () => {
  test("docAccessKeysJson 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("gateway.bicep");
    expect(secureParamOffenders(arm, "docAccessKeysJson")).toEqual([]);
  });

  test("casAccessKey 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("gateway.bicep");
    expect(secureParamOffenders(arm, "casAccessKey")).toEqual([]);
  });

  test("pgAdminPassword 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("gateway.bicep");
    expect(secureParamOffenders(arm, "pgAdminPassword")).toEqual([]);
  });

  test("casStackPrivateKeyPkcs8 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("gateway.bicep");
    expect(secureParamOffenders(arm, "casStackPrivateKeyPkcs8")).toEqual([]);
  });

  test("嵌套部署用 inner scope，密钥参数声明为 securestring", () => {
    const arm = compile("gateway.bicep");
    const nested = nestedDeployments(arm);
    expect(nested.length).toBeGreaterThan(0);
    for (const dep of nested) {
      expect(dep.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });
      const params = dep.properties.template.parameters;
      for (const name of ["docServicesJson", "casAccessKey", "databaseUrl", "casStackPrivateKeyPkcs8"]) {
        expect(params[name]?.type, `${name} must be securestring`).toBe("securestring");
      }
    }
  });
});

describe.skipIf(!AZ)("service.bicep 的密钥不落进外层模板", () => {
  test("casStackTrustedJwks 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("service.bicep");
    expect(secureParamOffenders(arm, "casStackTrustedJwks")).toEqual([]);
  });

  test("嵌套部署用 inner scope，stack JWKS 声明为 securestring", () => {
    const arm = compile("service.bicep");
    const nested = nestedDeployments(arm);
    expect(nested.length).toBeGreaterThan(0);
    for (const dep of nested) {
      expect(dep.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });
      expect(dep.properties.template.parameters.casStackTrustedJwks?.type)
        .toBe("securestring");
    }
  });
});

describe.skipIf(!AZ)("platform.bicep 的连接串不落进外层模板", () => {
  test("迁移 Job 的 databaseUrl 是嵌套模板的 securestring 参数", () => {
    const arm = compile("platform.bicep");
    const nested = nestedDeployments(arm);
    expect(nested.length).toBeGreaterThan(0);
    for (const dep of nested) {
      expect(dep.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });
      expect(dep.properties.template.parameters.databaseUrl?.type).toBe("securestring");
    }
  });

  test("pgAdminPassword 在外层模板里只以直接引用出现，不被拼接", () => {
    const arm = compile("platform.bicep");
    // `[parameters('pgAdminPassword')]` 仍然是 securestring，ARM 在 what-if
    // 与部署历史里会遮蔽它——pg 资源的 administratorLoginPassword 就是这一种，
    // 是 Azure 的标准写法。危险的是**拼接**：一旦被 format() / 字符串插值包
    // 进去，结果就只是一个普通字符串，securestring 的血统在那一步断掉。
    expect(secureParamOffenders(arm, "pgAdminPassword")).toEqual([]);
  });

  // R4：上一轮有过一次同类教训——迁移 Job 名写成了嵌套部署名而不是资源名，
  // 能编译但值是错的，只在真部署时表现为 "job not found"。
  test("docMigrateJobNames 读的是 module 的 output，不是嵌套部署名", () => {
    const arm = compile("platform.bicep");
    const out = JSON.stringify(arm.outputs.docMigrateJobNames);
    expect(out).toContain("outputs.name.value");
  });
});
