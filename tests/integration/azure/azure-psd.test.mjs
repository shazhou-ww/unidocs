/**
 * psd 在本地 Azure 栈上的端到端 —— 本轮的验收之一。
 *
 * Stack 模式：PSD 的像素路径重度依赖 SBlob，经 Azure Doc 服务的 tenant CAS client
 * (capability + stackId) 打到本地嵌入的中间件(unidocs-azure 栈)。
 *
 * 这条测试的重心是 `getPreview`:它走的正是 makeSBlob/openSBlob → CAS 的
 * 那条路径。只 create + getLayers 不足以证明 psd 在 Azure 上可用——那两步
 * 不碰 CAS。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startAzureRuntime } from "../../../stacks/unidocs-azure/local/runtime.mjs";

const TENANT = "psd-e2e-tenant";

let azure;

beforeAll(async () => {
  // Stack 模式：psd 的像素路径（SBlob）经 azure doc 服务的 tenant CAS client
  // (capability + stackId) 打到本地嵌入的中间件（unidocs-azure 栈），
  // 不再依赖 cf legacy CAS worker。
  azure = await startAzureRuntime({
    docTypes: ["psd"],
  });
}, 300_000);

afterAll(async () => {
  await azure?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

test("psd imports, lists layers and renders a preview on the Azure stack", async () => {
  const psd = readFileSync(
    join(process.cwd(), "packages/doctype-psd/tests/fixtures/sample.psd"),
  );

  // create + import：两边的 `/_internal/create`（cloudflare-sdk 的
  // editor-do-svalue.ts#create 与 doctype-server-common 的
  // session-handler.ts）都只在 `multipart/form-data` 里找 `file` 字段来导入
  // 字节——裸 body + Content-Type 头会被当成「没有文件」，直接落到
  // `config.init()` 的空文档分支。`file` 的 media type 要认
  // `formats.psd.mediaTypes`（packages/doctype-psd/src/doctype.ts 的
  // formats 块），走跟 behavior-suite.mjs「export 的字节导入成新文档」
  // 同一条路子。
  const form = new FormData();
  form.append("file", new File([psd], "sample.psd", { type: "image/vnd.adobe.photoshop" }));
  const created = await closeFetch(`${azure.urls.gateway}/tenants/${TENANT}/docs/psd/`, {
    method: "POST",
    body: form,
  });
  const createdBody = await created.json();
  expect(created.ok, JSON.stringify(createdBody)).toBe(true);
  const { docId } = createdBody;
  expect(docId).toBeTypeOf("string");

  const layers = await closeFetch(
    `${azure.urls.gateway}/tenants/${TENANT}/docs/psd/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getLayers" }),
    },
  );
  const listed = await layers.json();
  expect(layers.ok, JSON.stringify(listed)).toBe(true);
  expect(listed.version).toBeGreaterThanOrEqual(1);
  // sample.psd 有图层；空数组说明导入没真正落下来。
  expect(JSON.stringify(listed.data).length).toBeGreaterThan(2);

  // 这一步才碰 CAS：getPreview 要读回被 externalize 出去的像素。
  const preview = await closeFetch(
    `${azure.urls.gateway}/tenants/${TENANT}/docs/psd/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getPreview", payload: { maxSize: 64 } }),
    },
  );
  const rendered = await preview.json();
  expect(preview.ok, JSON.stringify(rendered)).toBe(true);
  expect(rendered.data).toBeTruthy();
}, 240_000);
