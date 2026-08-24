/**
 * `resolveBlobConfig()` 的启动期契约。两种 Blob 模式互斥，判定必须发生在
 * 进程启动，不能推迟到第一次 Blob 操作 —— 那时容器已经通过健康检查、
 * 已经在接流量了。见设计 §6.1 的契约表。
 */
import { afterEach, describe, expect, test } from "vitest";
import { resolveBlobConfig } from "../src/env.js";

const KEYS = ["BLOB_CONNECTION_STRING", "BLOB_ACCOUNT_URL", "AZURE_CLIENT_ID"] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("resolveBlobConfig", () => {
  test("只有连接串：本地/Azurite 模式", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    expect(resolveBlobConfig()).toEqual({
      blobConnectionString: "UseDevelopmentStorage=true",
      blobAccountUrl: "",
    });
  });

  test("只有账户 URL 且有 client id：云上托管标识模式", () => {
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    process.env.AZURE_CLIENT_ID = "00000000-0000-0000-0000-000000000000";
    expect(resolveBlobConfig()).toEqual({
      blobConnectionString: "",
      blobAccountUrl: "https://stunidocs.blob.core.windows.net",
    });
  });

  test("两者都有：启动失败，错误里同时点名两个变量", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    expect(() => resolveBlobConfig()).toThrow(/BLOB_CONNECTION_STRING.*BLOB_ACCOUNT_URL/s);
  });

  test("两者都无：启动失败", () => {
    expect(() => resolveBlobConfig()).toThrow(/BLOB_CONNECTION_STRING|BLOB_ACCOUNT_URL/);
  });

  // 这条是本次改动的核心风险：用**用户分配**的托管标识时，
  // DefaultAzureCredential 缺了 AZURE_CLIENT_ID 照样能构造成功，
  // 失败会推迟到第一次 Blob 操作。所以它必须在启动就炸。
  test("有账户 URL 但无 AZURE_CLIENT_ID：启动失败，错误点名 AZURE_CLIENT_ID", () => {
    process.env.BLOB_ACCOUNT_URL = "https://stunidocs.blob.core.windows.net";
    expect(() => resolveBlobConfig()).toThrow(/AZURE_CLIENT_ID/);
  });

  // 连接串模式不需要 AZURE_CLIENT_ID —— 否则本地栈会被这条契约误伤。
  test("连接串模式不要求 AZURE_CLIENT_ID", () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";
    expect(() => resolveBlobConfig()).not.toThrow();
  });
});
