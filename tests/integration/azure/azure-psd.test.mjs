/**
 * psd 在本地 Azure 栈上的端到端 —— 本轮的验收之一。
 *
 * 与 azure-docx-image 同样的过渡形态:psd 的像素路径重度依赖 SBlob，而
 * Azure 侧还没有 azure-cas，所以 CAS_BASE_URL 指向 Miniflare 栈里的
 * Cloudflare CAS worker（阶段 4 换成 azure-cas 后这段脚手架整个删掉）。
 *
 * 这条测试的重心是 `getPreview`：它走的正是 makeSBlob/readSBlob → CAS 的
 * 那条路径。只 create + getLayers 不足以证明 psd 在 Azure 上可用——那两步
 * 不碰 CAS。
 *
 * Miniflare 侧用专用端口（tests/integration/ 下每个文件都这么做：
 * 18787 / 28787 / 29787 / 31787 / 32787），因为开发流程要求另开终端跑
 * `pnpm dev`，那是绑默认端口的进程。**Azure 侧刻意不覆盖端口**：
 * `startAzureRuntime()` 没有端口覆盖参数，四个 Azure 测试在
 * `--fileParallelism=false` 下顺序执行、互不重叠；与外部 `pnpm dev --azure`
 * 的冲突由 `assertPortsFree()` 明确报出，不是静默失败。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import { startAzureRuntime } from "../../../stacks/azure/local/runtime.mjs";

const TENANT = "psd-e2e-tenant";
const MINIFLARE_PORTS = { gateway: 34787, psd: 34790, cas: 34791 };

let miniflare;
let azure;

beforeAll(async () => {
  miniflare = await startLocalRuntime({ docTypes: ["psd"], ports: MINIFLARE_PORTS });
  azure = await startAzureRuntime({
    docTypes: ["psd"],
    casBaseUrl: miniflare.urls.cas,
    // 两套栈必须共用同一把 capability 签名密钥:各自
    // `createEphemeralCapabilityFixture()` 会生成两把不同的，Azure 侧签出的
    // 委托 CAS capability 在 Cloudflare 的 CAS worker 上验不过，表现为
    // `CAS leaseExisting failed: 401 Unauthorized`。同 azure-docx-image。
    capabilityFixture: miniflare.capabilityFixture,
  });
}, 300_000);

afterAll(async () => {
  await azure?.dispose();
  await miniflare?.dispose();
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
