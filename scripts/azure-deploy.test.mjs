/**
 * 部署脚本里能被纯逻辑覆盖的部分。其余(az 调用、docker 构建)由 Task 8
 * 的真实部署验收。
 */
import { describe, expect, test } from "vitest";
import { IMAGES, generateSecret, imageRef, parseArgs } from "./azure-deploy.mjs";

describe("imageRef", () => {
  test("拼出完整的 ACR 镜像引用", () => {
    expect(imageRef("crunidocsabc.azurecr.io", "azure-markdown", "a1b2c3d")).toBe(
      "crunidocsabc.azurecr.io/unidocs/azure-markdown:a1b2c3d",
    );
  });
});

describe("IMAGES", () => {
  // 迁移镜像是唯一一个「构建参数」与「镜像名」不同名的:构建参数是
  // 工作区包名 azure-sdk,镜像名是 infra/main.bicep 引用的 azure-migrate。
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
    expect(args.resourceGroup).toBe("rg-unidocs-dev");
    expect(args.location).toBe("southeastasia");
  });

  test("命令行参数覆盖默认值", () => {
    const args = parseArgs(["--resource-group", "rg-other", "--location", "japaneast"]);
    expect(args.resourceGroup).toBe("rg-other");
    expect(args.location).toBe("japaneast");
  });

  test("--cas-base-url 是必填的,缺失时报错点名它", () => {
    expect(() => parseArgs(["--require-cas"])).toThrow(/--cas-base-url/);
  });

  test("未知参数响亮失败,而不是被忽略", () => {
    expect(() => parseArgs(["--typo-flag", "x"])).toThrow(/--typo-flag/);
  });
});
