/**
 * 部署脚本里能被纯逻辑覆盖的部分。其余(az 调用、ACR 构建)由 Task 8
 * 的真实部署验收。
 */
import { describe, expect, test, vi } from "vitest";
import {
  IMAGES,
  decideInternalTokenAction,
  generateSecret,
  imageRef,
  imageRepoTag,
  isKeyVaultForbidden,
  parseArgs,
  retryOnForbidden,
} from "../../../azure/deploy/deploy.mjs";

describe("imageRef", () => {
  test("拼出完整的 ACR 镜像引用", () => {
    expect(imageRef("unidocsacr.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      "unidocsacr.azurecr.io/unidocs/azure-markdown:a1b2c3d",
    );
  });

  // `az acr build --image` 要的是 registry 内的相对路径。带上 loginServer
  // 前缀会建出一个名叫 `unidocsacr.azurecr.io/unidocs/...` 的仓库,而
  // main.bicep 引用的是 `unidocs/...`,部署时拉不到镜像。
  test("imageRepoTag 不含 loginServer 前缀,且是 imageRef 的后缀", () => {
    expect(imageRepoTag("azure-markdown", "a1b2c3d")).toBe("unidocs/azure-markdown:a1b2c3d");
    expect(imageRef("unidocsacr.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      `unidocsacr.azurecr.io/${imageRepoTag("azure-markdown", "a1b2c3d")}`,
    );
  });
});

describe("IMAGES", () => {
  // 迁移镜像是唯一一个「构建参数」与「镜像名」不同名的:构建参数是
  // 工作区包名 azure-sdk,镜像名是 azure/deploy/main.bicep 引用的 azure-migrate。
  // 传错会让 main 部署时拉不到镜像,而那是个部署到一半才暴露的错误。
  test("迁移镜像的构建参数与镜像名刻意不同", () => {
    const migrate = IMAGES.find((i) => i.name === "azure-migrate");
    expect(migrate).toBeDefined();
    expect(migrate.service).toBe("azure-sdk");
    expect(migrate.entry).toBe("dist/migrate-cli.js");
  });

  test("三个服务镜像的构建参数与镜像名一致,入口都是 dist/main.js", () => {
    for (const name of ["azure-gateway", "azure-markdown", "azure-docx"]) {
      const img = IMAGES.find((i) => i.name === name);
      expect(img.service).toBe(name);
      expect(img.entry).toBe("dist/main.js");
    }
  });
});

describe("generateSecret", () => {
  // 密码会被拼进 postgres://user:password@host/db。base64 标准字母表里的
  // `/` `+` `=` 都会破坏连接串,所以必须是 URL 安全字母表且无填充。
  test("只含 URL 安全字符", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecret(24)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("每次都不同", () => {
    expect(generateSecret(24)).not.toBe(generateSecret(24));
  });

  test("长度随字节数增长", () => {
    expect(generateSecret(48).length).toBeGreaterThan(generateSecret(24).length);
  });
});

describe("parseArgs", () => {
  test("默认值指向设计里确定的订阅、资源组与位置", () => {
    const args = parseArgs([]);
    expect(args.subscription).toBe("24c9acbd-c2f5-4ef9-b9a2-486d90208b3e");
    expect(args.resourceGroup).toBe("Unidocs");
    expect(args.location).toBe("southeastasia");
  });

  test("命令行参数覆盖默认值", () => {
    const args = parseArgs(["--resource-group", "rg-other", "--location", "japaneast"]);
    expect(args.resourceGroup).toBe("rg-other");
    expect(args.location).toBe("japaneast");
  });

  test("--cas-base-url 是可选的,不传也不报错", () => {
    expect(() => parseArgs([])).not.toThrow();
    expect(parseArgs([]).casBaseUrl).toBe("");
  });

  test("未知参数响亮失败,而不是被忽略", () => {
    expect(() => parseArgs(["--typo-flag", "x"])).toThrow(/--typo-flag/);
  });

  // INTERNAL_TOKEN 不是本轮生成的密钥,而是必须与已部署的 Cloudflare CAS
  // worker 对齐的既有值 —— 所以它必须能从命令行传进来。
  test("--internal-token 被解析", () => {
    expect(parseArgs(["--internal-token", "shared-with-cloudflare"]).internalToken).toBe(
      "shared-with-cloudflare",
    );
  });

  test("不传 --internal-token 时是空串(留给 Key Vault 里的既有值)", () => {
    expect(parseArgs([]).internalToken).toBe("");
  });
});

// resolveInternalToken() 的分叉逻辑抽成纯函数,四种情形都能在不 mock `az`
// 的前提下直接断言 —— 这正是本轮改动的核心:是否配 --cas-base-url 决定了
// 「都没有」时是生成还是报错。
describe("decideInternalTokenAction", () => {
  test("Key Vault 里已有 internal-token -> read,与 provided/casBaseUrl 都无关", () => {
    expect(decideInternalTokenAction({ existing: "kv-value", provided: "", casBaseUrl: "" })).toBe("read");
    expect(
      decideInternalTokenAction({ existing: "kv-value", provided: "cli-value", casBaseUrl: "https://cas.example" }),
    ).toBe("read");
  });

  test("没有既有值但传了 --internal-token -> write,与是否配 CAS 无关", () => {
    expect(decideInternalTokenAction({ existing: "", provided: "cli-value", casBaseUrl: "" })).toBe("write");
    expect(
      decideInternalTokenAction({ existing: "", provided: "cli-value", casBaseUrl: "https://cas.example" }),
    ).toBe("write");
  });

  // 对立路径之一:都没有,且未配 --cas-base-url -> 允许生成。此时
  // INTERNAL_TOKEN 只用于 Azure 内部 gateway -> doc-type-worker 鉴权,没有
  // Cloudflare 侧需要对齐。
  test("都没有,且未配 --cas-base-url -> generate", () => {
    expect(decideInternalTokenAction({ existing: "", provided: "", casBaseUrl: "" })).toBe("generate");
  });

  // 对立路径之二:都没有,但配了 --cas-base-url -> 必须报错中止(C2 的
  // 保护原样保留)。自行生成的值必然对不上已部署的 Cloudflare CAS worker,
  // 会让所有跨云 CAS 请求 401。
  test("都没有,但配了 --cas-base-url -> error", () => {
    expect(
      decideInternalTokenAction({ existing: "", provided: "", casBaseUrl: "https://cas.example" }),
    ).toBe("error");
  });
});

describe("isKeyVaultForbidden", () => {
  test("stderr 里含 Forbidden(不分大小写)时判定为 true", () => {
    expect(isKeyVaultForbidden("ERROR: (Forbidden) Caller is not authorized...")).toBe(true);
    expect(isKeyVaultForbidden("some forbidden text")).toBe(true);
  });

  test("其它错误、或者根本没有 stderr 时判定为 false", () => {
    expect(isKeyVaultForbidden("ERROR: (SecretNotFound) A secret with...")).toBe(false);
    expect(isKeyVaultForbidden("")).toBe(false);
    expect(isKeyVaultForbidden(undefined)).toBe(false);
  });
});

// `retryOnForbidden()` 是 Task 8 真实部署撞上的 Critical 修复:
// bootstrap.bicep 刚建完 Key Vault Secrets Officer 角色分配,Step 3 紧接着
// 写 secret 就被 Forbidden 拒绝(数据平面权限传播延迟)。这里注入假的
// attempt/wait/log,不跑真实 `az`、也不用真的等 10 秒 × 6 次。
describe("retryOnForbidden", () => {
  test("第一次就成功 -> 直接返回,不重试、不等待", async () => {
    const attempt = vi.fn(() => ({ status: 0, stdout: "the-value\n", stderr: "" }));
    const wait = vi.fn(() => Promise.resolve());
    const log = vi.fn();
    const onNonForbiddenFailure = vi.fn();

    const result = await retryOnForbidden("label", attempt, onNonForbiddenFailure, {
      maxAttempts: 6,
      intervalMs: 10_000,
      wait,
      log,
    });

    expect(result).toBe("the-value");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(onNonForbiddenFailure).not.toHaveBeenCalled();
  });

  // 核心场景:第一次 Forbidden(角色分配还没传播),重试一次就成功。
  test("先 Forbidden 后成功 -> 重试一次,期间打印等待提示", async () => {
    let call = 0;
    const attempt = vi.fn(() => {
      call++;
      if (call === 1) {
        return { status: 1, stdout: "", stderr: "ERROR: (Forbidden) Caller is not authorized..." };
      }
      return { status: 0, stdout: "the-value\n", stderr: "" };
    });
    const wait = vi.fn(() => Promise.resolve());
    const log = vi.fn();

    const result = await retryOnForbidden("az keyvault secret set ...", attempt, () => {
      throw new Error("should not be called");
    }, { maxAttempts: 6, intervalMs: 10_000, wait, log });

    expect(result).toBe("the-value");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(10_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/Forbidden.*attempt 1\/6/);
  });

  // 非 Forbidden 的失败(密钥名打错、vault 不存在……)第一次就交给调用方
  // 处理,不重试、不拖慢。
  test("非 Forbidden 的失败 -> 立即调用 onNonForbiddenFailure,不重试", async () => {
    const attempt = vi.fn(() => ({ status: 1, stdout: "", stderr: "ERROR: (SecretNotFound) ..." }));
    const wait = vi.fn(() => Promise.resolve());
    const onNonForbiddenFailure = vi.fn(() => "not-found-sentinel");

    const result = await retryOnForbidden("label", attempt, onNonForbiddenFailure, {
      maxAttempts: 6,
      intervalMs: 10_000,
      wait,
      log: vi.fn(),
    });

    expect(result).toBe("not-found-sentinel");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(onNonForbiddenFailure).toHaveBeenCalledTimes(1);
  });

  // 对立路径:持续 Forbidden 到重试耗尽 -> 中止,不静默吞掉、不无限重试。
  test("持续 Forbidden 直到耗尽重试次数 -> 中止并报出角色名", async () => {
    const attempt = vi.fn(() => ({ status: 1, stdout: "", stderr: "ERROR: (Forbidden) ..." }));
    const wait = vi.fn(() => Promise.resolve());
    const log = vi.fn();

    await expect(
      retryOnForbidden("az keyvault secret set ...", attempt, () => {
        throw new Error("should not be called");
      }, { maxAttempts: 3, intervalMs: 10_000, wait, log }),
    ).rejects.toThrow(/still getting Forbidden.*3 attempts.*Key Vault Secrets Officer/s);

    // 3 次尝试、2 次等待(每两次尝试之间等一次,最后一次尝试后直接中止)。
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
