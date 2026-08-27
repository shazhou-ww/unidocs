import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { azureDocTypePortBases, readAzureDocTypes } from "../../../stacks/unidocs-azure/doc-types.mjs";

/** 造一个只有 packages/azure-* 的假仓库根,用来测校验分支——真仓库里
 *  每份 json 都是合法的,构造不出缺字段的情形。 */
const roots = [];
function fakeRepo(services) {
  const root = mkdtempSync(join(tmpdir(), "azure-doc-types-"));
  roots.push(root);
  for (const [dir, json] of Object.entries(services)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "azure.service.json"), JSON.stringify(json));
  }
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const MARKDOWN = {
  docType: "markdown", targetPort: 8788, localPortBase: 41800,
  minReplicas: 2, maxReplicas: 5, needsCas: false,
};
const DOCX = {
  docType: "docx", targetPort: 8789, localPortBase: 41810,
  minReplicas: 2, maxReplicas: 5, needsCas: true,
};

describe("readAzureDocTypes", () => {
  test("真仓库里读出 markdown 与 docx,字段与 json 一致", () => {
    const table = readAzureDocTypes();
    expect(Object.keys(table)).toContain("markdown");
    expect(Object.keys(table)).toContain("docx");
    expect(table.markdown.localPortBase).toBe(41800);
    expect(table.docx.needsCas).toBe(true);
    expect(table.markdown.needsCas).toBe(false);
  });

  // 网关那份没有 docType 字段——它不是一个 doc type,是 --gateway 自己的
  // 参数。凭这一点被排除,不要改成按目录名硬编码排除。
  test("没有 docType 字段的 azure.service.json 被排除", () => {
    const root = fakeRepo({
      "azure-markdown": MARKDOWN,
      "azure-gateway": { external: true, targetPort: 8787, minReplicas: 1, maxReplicas: 3 },
    });
    expect(Object.keys(readAzureDocTypes(root))).toEqual(["markdown"]);
  });

  test("键按字典序排列,与目录扫描顺序无关", () => {
    const root = fakeRepo({ "azure-markdown": MARKDOWN, "azure-docx": DOCX });
    expect(Object.keys(readAzureDocTypes(root))).toEqual(["docx", "markdown"]);
  });

  // 缺字段必须点名报错,不能静默取默认值:这份 json 是唯一事实来源,
  // 静默默认值会让它名存实亡。
  test("缺字段时报错并点出文件与字段名", () => {
    const { needsCas, ...missing } = DOCX;
    const root = fakeRepo({ "azure-docx": missing });
    expect(() => readAzureDocTypes(root))
      .toThrow(/packages\/azure-docx\/azure\.service\.json.*needsCas/s);
  });

  test("字段类型不对时报错并点出文件与字段名", () => {
    const root = fakeRepo({ "azure-docx": { ...DOCX, localPortBase: "41810" } });
    expect(() => readAzureDocTypes(root))
      .toThrow(/packages\/azure-docx\/azure\.service\.json.*localPortBase/s);
  });

  // 目录名与 docType 对不上会让 deploy.mjs 的 --service 与镜像名错位,
  // 而那要到真部署才暴露。
  test("docType 与目录名不一致时报错", () => {
    const root = fakeRepo({ "azure-docx": { ...DOCX, docType: "psd" } });
    expect(() => readAzureDocTypes(root)).toThrow(/azure-docx.*psd/s);
  });

  test("localPortBase 撞车时报错并点出两个 doc type", () => {
    const root = fakeRepo({
      "azure-markdown": MARKDOWN,
      "azure-docx": { ...DOCX, localPortBase: 41800 },
    });
    expect(() => readAzureDocTypes(root)).toThrow(/41800.*(markdown.*docx|docx.*markdown)/s);
  });
});

describe("azureDocTypePortBases", () => {
  test("从表提取 docType -> localPortBase", () => {
    const root = fakeRepo({ "azure-markdown": MARKDOWN, "azure-docx": DOCX });
    expect(azureDocTypePortBases(readAzureDocTypes(root)))
      .toEqual({ docx: 41810, markdown: 41800 });
  });
});
