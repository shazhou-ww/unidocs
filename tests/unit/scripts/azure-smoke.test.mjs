/**
 * 部署脚本里能被纯逻辑覆盖的部分,以及 `--no-cas` 那条"不信任标志位、自己
 * 探测"的保护。真正的七步流程(建资源、跑迁移、对公网网关发真实请求)由
 * Task 8 的真实部署验收覆盖,这里不重复。
 *
 * `assertCasNotConfigured()` 的探测用 `node:http` 起一个本地假网关,不用
 * `startAzureRuntime()`——探测逻辑本身只关心"HTTP 状态码是不是 404",跟真
 * 实网关的其余行为(建库、迁移、Blob)无关,用一个假服务器覆盖同一条判断
 * 分支更快、更确定,也不需要 docker/Postgres/Azurite。用真实本地栈(配 CAS
 * 与不配 CAS 两个 `startAzureRuntime()` 实例作对照)手工验证过一次,记录见
 * `.superpowers/sdd/2026-08-22-azure-cloud-deployment/cas-optional-report.md`。
 */
import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import {
  assertCasNotConfigured,
  assertSkipCasAllowed,
  isLocalHost,
  parseArgs,
} from "../../../stacks/azure/deploy/smoke.mjs";

describe("parseArgs", () => {
  test("--gateway 是必填的", () => {
    expect(() => parseArgs([])).toThrow(/--gateway is required/);
  });

  test("--no-cas 被解析", () => {
    expect(parseArgs(["--gateway", "http://x", "--no-cas"]).noCas).toBe(true);
  });

  test("不传 --no-cas 时默认 false", () => {
    expect(parseArgs(["--gateway", "http://x"]).noCas).toBe(false);
  });

  // 两个开关语义冲突(“我选择跳过” vs “这次部署没有”),同时给出说明调用者
  // 自己都没想清楚,必须响亮拒绝,而不是悄悄选一个生效。
  test("--skip-cas 与 --no-cas 同时给出报错", () => {
    expect(() => parseArgs(["--gateway", "http://x", "--skip-cas", "--no-cas"])).toThrow(
      /mutually exclusive/,
    );
  });

  test("未知参数响亮失败", () => {
    expect(() => parseArgs(["--gateway", "http://x", "--typo"])).toThrow(/--typo/);
  });
});

describe("isLocalHost", () => {
  test("localhost / 127.0.0.1 / ::1 都算本地", () => {
    expect(isLocalHost("http://localhost:8787")).toBe(true);
    expect(isLocalHost("http://127.0.0.1:8787")).toBe(true);
    expect(isLocalHost("http://[::1]:8787")).toBe(true);
  });

  test("真实域名不算本地,即便 query string 里塞了 127.0.0.1", () => {
    expect(isLocalHost("https://evil.com/?x=127.0.0.1")).toBe(false);
    expect(isLocalHost("https://unidocs-gateway.azurecontainerapps.io")).toBe(false);
  });
});

describe("assertSkipCasAllowed", () => {
  test("--skip-cas 对非本地网关且没有 --no-cas -> 拒绝", () => {
    expect(() =>
      assertSkipCasAllowed({ skipCas: true, noCas: false }, "https://real-gateway.example"),
    ).toThrow(/non-local/);
  });

  test("--skip-cas 对本地网关 -> 允许", () => {
    expect(() =>
      assertSkipCasAllowed({ skipCas: true, noCas: false }, "http://127.0.0.1:8787"),
    ).not.toThrow();
  });

  // 对立路径:同样是非本地网关,但同时带了 --no-cas 时不再触发这条守卫——
  // “这次部署没配 CAS”走的是 assertCasNotConfigured() 的真实探测,不是这条
  // 只看主机名的规则。
  test("--skip-cas 对非本地网关,但同时带了 --no-cas -> 允许(交给探测把关)", () => {
    expect(() =>
      assertSkipCasAllowed({ skipCas: true, noCas: true }, "https://real-gateway.example"),
    ).not.toThrow();
  });

  test("没传 --skip-cas 时,不管本地不本地都不拒绝", () => {
    expect(() =>
      assertSkipCasAllowed({ skipCas: false, noCas: false }, "https://real-gateway.example"),
    ).not.toThrow();
  });
});

/** 起一个只回一种状态码的假网关,模拟 CAS 探测请求会打到的端点。 */
function startFakeGateway(status) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ probed: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("assertCasNotConfigured", () => {
  // 对立路径之一:未配 CAS 的网关上 isPublicCasRoute 恒 false,探测请求
  // 必然 404 —— --no-cas 成立,不中止。
  test("网关对探测请求答 404 -> 确认未配 CAS,不中止", async () => {
    const fake = await startFakeGateway(404);
    try {
      await expect(assertCasNotConfigured(fake.url)).resolves.toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  // 对立路径之二:网关对探测请求答了非 404(不管是配了 CAS 后代理给真实
  // CAS worker 的响应,还是别的什么状态码)-> 必须中止,不能让 --no-cas
  // 变成绕开第 3 组的后门。
  test.each([200, 400, 401, 500])(
    "网关对探测请求答 %i(非 404) -> 中止,报出实际状态码",
    async (status) => {
      const fake = await startFakeGateway(status);
      try {
        await expect(assertCasNotConfigured(fake.url)).rejects.toThrow(
          new RegExp(`HTTP ${status}`),
        );
      } finally {
        await fake.close();
      }
    },
  );
});
