/**
 * 部署脚本里能被纯逻辑覆盖的部分。其余(az 调用、ACR 构建)由 Task 8
 * 的真实部署验收。
 */
import { describe, expect, test, vi } from "vitest";
import {
  seedSecrets,
  azureImages,
  classifySmokeFailure,
  generateSecret,
  imageRef,
  imageRepoTag,
  isKeyVaultForbidden,
  mapWithConcurrency,
  parseArgs,
  readGatewayParams,
  readServiceParams,
  retryOnForbidden,
  retryUntil,
} from "../../../stacks/unidocs-azure/deploy/deploy.mjs";

describe("imageRef", () => {
  test("拼出完整的 ACR 镜像引用", () => {
    expect(imageRef("unidocsacr.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      "unidocsacr.azurecr.io/unidocs/azure-markdown:a1b2c3d",
    );
  });

  // `az acr build --image` 要的是 registry 内的相对路径。带上 loginServer
  // 前缀会建出一个名叫 `unidocsacr.azurecr.io/unidocs/...` 的仓库,而
  // service.bicep/gateway.bicep/platform.bicep 引用的是 `unidocs/...`,
  // 部署时拉不到镜像。
  test("imageRepoTag 不含 loginServer 前缀,且是 imageRef 的后缀", () => {
    expect(imageRepoTag("azure-markdown", "a1b2c3d")).toBe("unidocs/azure-markdown:a1b2c3d");
    expect(imageRef("unidocsacr.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      `unidocsacr.azurecr.io/${imageRepoTag("azure-markdown", "a1b2c3d")}`,
    );
  });
});

describe("azureImages", () => {
  // 迁移镜像是唯一一个「构建参数」与「镜像名」不同名的:构建参数是
  // 工作区包名 azure-sdk,镜像名是 stacks/unidocs-azure/deploy/platform.bicep(通过
  // migrate-job.bicep 模块)引用的 azure-migrate。传错会让 platform
  // 部署时拉不到镜像,而那是个部署到一半才暴露的错误。
  test("迁移镜像的构建参数与镜像名刻意不同", () => {
    const migrate = azureImages().find((i) => i.name === "azure-migrate");
    expect(migrate).toBeDefined();
    expect(migrate.service).toBe("azure-sdk");
    expect(migrate.entry).toBe("dist/migrate-cli.js");
  });

  test("Gateway migration 复用 Gateway package 的独立入口", () => {
    const migrate = azureImages().find((i) => i.name === "azure-gateway-migrate");
    expect(migrate).toEqual({
      service: "azure-gateway",
      name: "azure-gateway-migrate",
      entry: "dist/migrate-cli.js",
    });
  });

  test("三个服务镜像的构建参数与镜像名一致,入口都是 dist/main.js", () => {
    for (const name of ["azure-gateway", "azure-markdown", "azure-docx"]) {
      const img = azureImages().find((i) => i.name === name);
      expect(img.service).toBe(name);
      expect(img.entry).toBe("dist/main.js");
    }
  });

  test("azureImages 从 azure.service.json 展开每个 doc type 的服务镜像", () => {
    const names = azureImages().map((i) => i.name);
    expect(names).toContain("azure-markdown");
    expect(names).toContain("azure-docx");
    expect(names).toContain("azure-gateway");
    expect(names).toContain("azure-gateway-migrate");
    expect(names).toContain("azure-migrate");
  });

  // 加一个 doc type 只该改那个包，不该改 deploy.mjs。
  test("azureImages 接受注入的表，新 doc type 自动出现", () => {
    const names = azureImages({
      markdown: { docType: "markdown" },
      psd: { docType: "psd" },
    }).map((i) => i.name);
    expect(names).toContain("azure-psd");
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

/** stack 模式下 gateway/services 目标的必填组，逐个测必填性时再拆开。 */
const STACK_ARGS = [
  "--cas-stack-id", "cas_EM1_egj6I-ea",
  "--cas-stack-issuer", "https://unicas.shazhou.work/cas/issuer/azure",
  "--cas-stack-key-id", "az-rotate-1",
  "--cas-capability-audience", "unidocs-cas-azure",
];

describe("parseArgs", () => {
  test("默认值指向设计里确定的订阅、资源组与位置", () => {
    const args = parseArgs(["--capability-key-id", "test-key", ...STACK_ARGS]);
    expect(args.subscription).toBe("24c9acbd-c2f5-4ef9-b9a2-486d90208b3e");
    expect(args.resourceGroup).toBe("Unidocs");
    expect(args.location).toBe("southeastasia");
  });

  test("命令行参数覆盖默认值", () => {
    const args = parseArgs(["--resource-group", "rg-other", "--location", "japaneast", "--capability-key-id", "test-key", ...STACK_ARGS]);
    expect(args.resourceGroup).toBe("rg-other");
    expect(args.location).toBe("japaneast");
  });

  test("--cas-base-url 是可选的,不传也不报错", () => {
    expect(() => parseArgs(["--capability-key-id", "test-key", ...STACK_ARGS])).not.toThrow();
    expect(parseArgs(["--capability-key-id", "test-key", ...STACK_ARGS]).casBaseUrl).toBe("");
  });

  test("未知参数响亮失败,而不是被忽略", () => {
    expect(() => parseArgs(["--typo-flag", "x"])).toThrow(/--typo-flag/);
  });

  test("capability identity values are parsed", () => {
    const args = parseArgs([
      "--gateway",
      "--capability-issuer", "unidocs-gateway:staging",
      "--capability-key-id", "staging-key-2",
      ...STACK_ARGS,
    ]);
    expect(args).toMatchObject({
      capabilityIssuer: "unidocs-gateway:staging",
      capabilityKeyId: "staging-key-2",
    });
    expect(() => parseArgs(["--capability-private-key", "secret"]))
      .toThrow(/Unknown argument/);
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

describe("parseArgs 选择器", () => {
  test("无参数:全量部署", () => {
    const a = parseArgs(["--capability-key-id", "test-key", ...STACK_ARGS]);
    expect(a.targets).toEqual(["bootstrap", "platform", "services", "gateway"]);
  });

  test("--service docx:只部一个", () => {
    const a = parseArgs(["--service", "docx", "--capability-key-id", "test-key", ...STACK_ARGS]);
    expect(a.targets).toEqual(["services"]);
    expect(a.services).toEqual(["docx"]);
  });

  test("--service 多选用逗号分隔", () => {
    expect(parseArgs(["--service", "docx,markdown", "--capability-key-id", "test-key", ...STACK_ARGS]).services).toEqual(["docx", "markdown"]);
  });

  test("--service 的取值必须存在对应的 azure.service.json", () => {
    expect(() => parseArgs(["--service", "nosuch"])).toThrow(/nosuch/);
  });

  // gateway 的 azure.service.json 没有 docType 字段——它不是一个可 --service
  // 的 doc type,那是 --gateway 自己的 target。
  test("--service gateway 被拒绝(那份 json 没有 docType 字段)", () => {
    expect(() => parseArgs(["--service", "gateway"])).toThrow(/docType/);
  });

  test("--bootstrap / --platform / --gateway 可以组合,顺序与 argv 无关", () => {
    expect(parseArgs(["--gateway", "--bootstrap", "--capability-key-id", "test-key", ...STACK_ARGS]).targets).toEqual(["bootstrap", "gateway"]);
    expect(parseArgs(["--platform", "--capability-key-id", "test-key", ...STACK_ARGS]).targets).toEqual(["platform"]);
  });

  test("--build-concurrency 默认 2,可覆盖", () => {
    expect(parseArgs(["--capability-key-id", "test-key", ...STACK_ARGS]).buildConcurrency).toBe(2);
    expect(parseArgs(["--build-concurrency", "1", "--capability-key-id", "test-key", ...STACK_ARGS]).buildConcurrency).toBe(1);
  });

  test("--build-concurrency 非正整数要响亮失败", () => {
    expect(() => parseArgs(["--build-concurrency", "0"])).toThrow(/build-concurrency/);
    expect(() => parseArgs(["--build-concurrency", "-1"])).toThrow(/build-concurrency/);
    expect(() => parseArgs(["--build-concurrency", "abc"])).toThrow(/build-concurrency/);
  });
});

describe("readServiceParams", () => {
  test("读 packages/azure-docx/azure.service.json", () => {
    const p = readServiceParams("docx");
    expect(p).toMatchObject({ docType: "docx", targetPort: 8789, minReplicas: 2 });
  });

  test("读 packages/azure-markdown/azure.service.json", () => {
    const p = readServiceParams("markdown");
    expect(p).toMatchObject({ docType: "markdown", targetPort: 8788, minReplicas: 2 });
  });

  test("不存在的 doc type 响亮失败并点名", () => {
    expect(() => readServiceParams("nosuch")).toThrow(/nosuch/);
  });
});

// gateway 的 azure.service.json 此前是一份没人读的死文件——gateway.bicep
// 把 external/targetPort/minReplicas/maxReplicas 硬编码在模板内部。评审后
// 把这四个值改成了带同名默认值的 bicep param,deployGateway() 改为读这份
// json 并显式传参。这里确认「读出来的值」与「gateway.bicep 里那四个 param
// 的默认值」逐字一致——这是零行为变更重构的前提,不是巧合。
describe("readGatewayParams", () => {
  test("读 packages/azure-gateway/azure.service.json 的全部字段", () => {
    // external/targetPort/minReplicas/maxReplicas 与 gateway.bicep 的默认值
    // 逐字相同 —— 传等于默认值的值不改变行为,只是让这份配置文件真正被读取。
    // cpu/memory/maxUploadBytes 则是**刻意偏离**默认值的覆盖:网关默认的
    // 0.5CPU/1Gi 扛不住大文档上传(克隆探测会把整个 body 解析进内存,而且
    // clone 意味着同时存在两份),所以这三个必须显式抬高。
    expect(readGatewayParams()).toEqual({
      external: true,
      targetPort: 8787,
      minReplicas: 1,
      maxReplicas: 3,
      cpu: "2.0",
      memory: "4.0Gi",
      maxUploadBytes: 268435456,
    });
  });
});

// mapWithConcurrency 是「有界并发,不是无界 Promise.all」这条要求的核心：
// 用一个会记录同时在飞数量的 worker 直接断言峰值并发不超过 limit。
describe("mapWithConcurrency", () => {
  test("并发数不超过给定上限", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 6 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 2, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item * 10;
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
  });

  test("concurrency 大于 items 数时不会多起 lane", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2], 10, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([1, 2]);
  });

  test("单个 worker 失败会让整体 reject", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow(/boom/);
  });
});

// retryUntil 是冒烟重试的核心循环——与注册表无关，见 stacks/unidocs-azure/deploy/deploy.mjs
// 里 runSmoke() 的注释。这里同样注入假的 wait/log，不真的等待。
describe("retryUntil", () => {
  test("第一次就成功 -> 不重试、不等待", async () => {
    const attempt = vi.fn(async () => "ok");
    const wait = vi.fn(() => Promise.resolve());
    const result = await retryUntil(attempt, { timeoutMs: 1000, intervalMs: 100, wait, log: vi.fn() });
    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test("失败几次后成功 -> 重试直到成功", async () => {
    let call = 0;
    const attempt = vi.fn(async () => {
      call++;
      if (call < 3) throw new Error(`not ready yet (${call})`);
      return "ok";
    });
    const wait = vi.fn(() => Promise.resolve());
    const result = await retryUntil(attempt, { timeoutMs: 1000, intervalMs: 100, wait, log: vi.fn() });
    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  test("持续失败直到超时 -> 抛出最后一次的错误，不静默吞掉", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("still failing");
    });
    // wait 立即 resolve(不真的等待),但 timeoutMs 本身用一个很小的真实值
    // (50ms),循环会在真实时钟上很快越过 deadline 并中止 —— 不需要 mock
    // Date.now,测试仍然快且不脆弱。
    const wait = vi.fn(() => Promise.resolve());
    await expect(
      retryUntil(attempt, { timeoutMs: 50, intervalMs: 1, wait, log: vi.fn() }),
    ).rejects.toThrow(/still failing/);
    expect(attempt.mock.calls.length).toBeGreaterThan(0);
  });
});

// classifySmokeFailure() 是本轮评审要求的修复:冒烟重试耗尽之前,
// "revision 还没接管流量"和"服务起来了但断言失败"两种失败的错误信息完全
// 相同(`exited with code 1`)。这里直接喂 smoke.mjs 真实会产出的 stdout/
// stderr 形状,断言两种情况被分类成不同的 kind,且失败摘要进了 detail——
// 不用真的起子进程。
describe("classifySmokeFailure", () => {
  test("含 FAIL 行 -> assertion,摘要里带着具体哪条断言挂了", () => {
    const stderr =
      "  FAIL apply setContent → success && version === 2 — " +
      '{"success":false,"error":"conflict"}\n' +
      "\n2 assertion(s) failed";
    const { kind, detail } = classifySmokeFailure("", stderr);
    expect(kind).toBe("assertion");
    expect(detail).toMatch(/FAIL apply setContent/);
  });

  test("网络错误(ECONNREFUSED 等)且没有 FAIL 行 -> network", () => {
    const stderr =
      "Error: connect ECONNREFUSED 127.0.0.1:8787\n" +
      "    at TCPConnectWrap.afterConnect [as oncomplete]";
    const { kind, detail } = classifySmokeFailure("", stderr);
    expect(kind).toBe("network");
    expect(detail).toMatch(/ECONNREFUSED/);
  });

  test("既没有 FAIL 行也没有网络错误关键词 -> unknown,仍然带着尾部输出", () => {
    const stderr = "TypeError: Cannot read properties of undefined (reading 'foo')";
    const { kind, detail } = classifySmokeFailure("", stderr);
    expect(kind).toBe("unknown");
    expect(detail).toMatch(/Cannot read properties/);
  });

  test("同时出现 FAIL 与网络关键词时优先判定为 assertion(已经跑到断言阶段了)", () => {
    const stderr =
      "  FAIL export → HTTP 200 with non-empty body — status=502\n" +
      "some unrelated ECONNRESET noise from an earlier retry";
    const { kind } = classifySmokeFailure("", stderr);
    expect(kind).toBe("assertion");
  });

  test("stdout 与 stderr 都为空 -> unknown,不抛错", () => {
    const { kind, detail } = classifySmokeFailure("", "");
    expect(kind).toBe("unknown");
    expect(typeof detail).toBe("string");
  });
});

describe("parseArgs: stack 身份参数", () => {
  test("四个 stack 参数被解析,refDomain 默认 doc", () => {
    const args = parseArgs([
      "--gateway",
      "--capability-key-id", "k1",
      ...STACK_ARGS,
    ]);
    expect(args).toMatchObject({
      casStackId: "cas_EM1_egj6I-ea",
      casStackIssuer: "https://unicas.shazhou.work/cas/issuer/azure",
      casStackKeyId: "az-rotate-1",
      casRefDomain: "doc",
    });
  });

  test("--cas-ref-domain 可覆盖默认值", () => {
    const args = parseArgs([
      "--gateway", "--capability-key-id", "k1", ...STACK_ARGS,
      "--cas-ref-domain", "asset",
    ]);
    expect(args.casRefDomain).toBe("asset");
  });

  test.each([
    ["--cas-stack-id", /cas-stack-id/],
    ["--cas-stack-issuer", /cas-stack-issuer/],
    ["--cas-stack-key-id", /cas-stack-key-id/],
  ])("gateway 目标缺 %s 时响亮失败", (omitted, pattern) => {
    const kept = [];
    for (let i = 0; i < STACK_ARGS.length; i += 2) {
      if (STACK_ARGS[i] !== omitted) kept.push(STACK_ARGS[i], STACK_ARGS[i + 1]);
    }
    expect(() => parseArgs(["--gateway", "--capability-key-id", "k1", ...kept]))
      .toThrow(pattern);
  });

  test.each([
    ["--cas-stack-id", /cas-stack-id/],
    ["--cas-stack-issuer", /cas-stack-issuer/],
  ])("services 目标缺 %s 时响亮失败", (omitted, pattern) => {
    const kept = [];
    for (let i = 0; i < STACK_ARGS.length; i += 2) {
      if (STACK_ARGS[i] !== omitted) kept.push(STACK_ARGS[i], STACK_ARGS[i + 1]);
    }
    expect(() => parseArgs(["--service", "markdown", ...kept])).toThrow(pattern);
  });

  test("services 目标不需要 --cas-stack-key-id(doc service 不签发,只验签)", () => {
    const args = parseArgs([
      "--service", "markdown",
      "--cas-stack-id", "cas_EM1_egj6I-ea",
      "--cas-stack-issuer", "https://unicas.shazhou.work/cas/issuer/azure",
      "--cas-capability-audience", "unidocs-cas-azure",
    ]);
    expect(args.casStackKeyId).toBe("");
  });

  test("只跑 --bootstrap 时不要求任何 stack 参数", () => {
    expect(() => parseArgs(["--bootstrap"])).not.toThrow();
  });
});

describe("parseArgs: CAS audience", () => {
  test("--cas-capability-audience 被解析", () => {
    const args = parseArgs(["--gateway", "--capability-key-id", "k1", ...STACK_ARGS]);
    expect(args.casCapabilityAudience).toBe("unidocs-cas-azure");
  });

  test.each([["--gateway", ["--capability-key-id", "k1"]], ["--service", ["markdown"]]])(
    // 没有默认值是刻意的:bicep 那边的 'unidocs-cas' 是个没有 stack 区分度的
    // 占位值,一旦与控制面里注册的 audience 不一致,网关签的票会被 CAS 以
    // aud 不匹配全量拒绝 —— 而且要等部署完才暴露。
    "%s 目标缺 --cas-capability-audience 时响亮失败",
    (selector, extra) => {
      const kept = [];
      for (let i = 0; i < STACK_ARGS.length; i += 2) {
        if (STACK_ARGS[i] !== "--cas-capability-audience") {
          kept.push(STACK_ARGS[i], STACK_ARGS[i + 1]);
        }
      }
      expect(() => parseArgs([selector, ...extra, ...kept]))
        .toThrow(/cas-capability-audience/);
    },
  );

  test("只跑 --bootstrap 时不要求 audience", () => {
    expect(() => parseArgs(["--bootstrap"])).not.toThrow();
  });
});

describe("seedSecrets: capability keys", () => {
  test("reads both stack identity keys", async () => {
    const calls = [];
    await seedSecrets("kv-test", {
      targets: ["services", "gateway"],
    }, {
      seedSecret: async () => "x",
      requireExistingSecret: async (_vault, name) => { calls.push(name); return "y"; },
    });
    expect(calls).toContain("cas-stack-private-key-pkcs8");
    expect(calls).toContain("cas-stack-trusted-jwks");
  });
});

/**
 * Task 7: LLM / 图像编辑模型的部署参数。四个都可选、默认空串,语义与
 * --cas-base-url 一致(不给 = 这个 doc type 不接 agent,operator 维持
 * 501),不加必填校验——所以这里只验证"透传"和"门槛条件",不验证任何
 * "缺了就报错"的分支(压根没有这种分支)。
 */
describe("parseArgs: LLM / 图像模型参数", () => {
  const base = [
    "--service", "psd",
    "--cas-stack-id", "cas_TESTTEST",
    "--cas-stack-issuer", "https://example.test/issuer",
    "--cas-capability-audience", "aud",
  ];

  test("省略 agent 参数时是空串 —— 语义是不接 agent，不是报错", () => {
    const args = parseArgs(base);
    expect(args.llmApiKeySecretName).toBe("");
    expect(args.llmModel).toBe("");
    expect(args.imageEditApiKeySecretName).toBe("");
    expect(args.imageEditModel).toBe("");
  });

  test("给了就带进来", () => {
    const args = parseArgs([...base, "--llm-api-key-secret", "llm-key", "--image-edit-model", "wan2.6-image"]);
    expect(args.llmApiKeySecretName).toBe("llm-key");
    expect(args.imageEditModel).toBe("wan2.6-image");
  });
});

/**
 * seedSecrets() 里这两个 key 的解析门槛是 `services`,不是 `gateway`——
 * 它们是给 doc service(operator)用的,跟网关无关,和上面
 * capability/CAS 那组身份密钥（gateway 签发、services 验签）刚好反过来。
 * 这条不是 brief 原文,是协调者核实 brief 缺陷后追加的必测分支：抄错门槛
 * 条件会让"只跑 --service"的部署永远解析不出 key，容器起来但 501/未授权，
 * 而且没有任何报错能提示这一点。
 */
describe("seedSecrets: LLM / 图像模型 key", () => {
  test("不给 secret 名 —— 不碰 Key Vault，解析结果是 null", async () => {
    // targets 含 services 时 seedSecrets() 还会解析
    // capabilityTrustedJwks/casStackTrustedJwks——那两个跟这次改动无关,
    // 这里不断言"完全没调用",只断言 llm/image 这两个名字压根没被查过、
    // 且解析结果确实是 null(不是空字符串、不是被误当成"已配置")。
    const calls = [];
    const secrets = await seedSecrets("kv-test", {
      targets: ["services"],
      llmApiKeySecretName: "",
      imageEditApiKeySecretName: "",
    }, {
      seedSecret: async () => "x",
      requireExistingSecret: async (_vault, name) => { calls.push(name); return "y"; },
    });
    expect(calls).not.toContain("my-llm-key");
    expect(calls).not.toContain("my-image-key");
    expect(secrets.llmApiKey).toBeNull();
    expect(secrets.imageEditApiKey).toBeNull();
  });

  test("给了 secret 名且 target 含 services —— 从 Key Vault 解析出明文值", async () => {
    const calls = [];
    const secrets = await seedSecrets("kv-test", {
      targets: ["services"],
      llmApiKeySecretName: "my-llm-key",
      imageEditApiKeySecretName: "my-image-key",
    }, {
      seedSecret: async () => "x",
      requireExistingSecret: async (_vault, name) => { calls.push(name); return `resolved-${name}`; },
    });
    expect(calls).toEqual(expect.arrayContaining(["my-llm-key", "my-image-key"]));
    expect(secrets.llmApiKey).toBe("resolved-my-llm-key");
    expect(secrets.imageEditApiKey).toBe("resolved-my-image-key");
  });

  test("门槛是 services，不是 gateway —— 只部 gateway 时不解析，也不报错", async () => {
    // targets 含 gateway 时 seedSecrets() 还会解析
    // capabilityPrivateKeyPkcs8/casStackPrivateKeyPkcs8——那两个跟这次改动
    // 无关。这条测试守的是协调者核实出的那个真实缺陷:如果误抄成
    // `targets.includes("gateway")`(像 capabilityPrivateKeyPkcs8 那样),
    // 纯 --service 部署就永远解析不出 LLM key,这里必须证明反过来也一样
    // 不解析——门槛是 services,不是 gateway。
    const calls = [];
    const secrets = await seedSecrets("kv-test", {
      targets: ["gateway"],
      llmApiKeySecretName: "my-llm-key",
      imageEditApiKeySecretName: "my-image-key",
    }, {
      seedSecret: async () => "x",
      requireExistingSecret: async (_vault, name) => { calls.push(name); return "y"; },
    });
    expect(calls).not.toContain("my-llm-key");
    expect(calls).not.toContain("my-image-key");
    expect(secrets.llmApiKey).toBeNull();
    expect(secrets.imageEditApiKey).toBeNull();
  });
});
