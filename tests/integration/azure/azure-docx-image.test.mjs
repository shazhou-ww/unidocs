/**
 * docx 含图片的 apply 在本地 Azure 栈上跑通 —— 本轮的第二条验收。
 * CAS 走过渡形态：Azure 侧的 CAS_BASE_URL 指向 Miniflare 栈里那个
 * Cloudflare CAS worker（阶段 4 换成 azure-cas 后这段脚手架整个删掉）。
 *
 * 这条测试还承担着比它表面看起来更重的分量：更早一个任务修过一个 bug ——
 * Azure 服务在某个分支下构造的 CasClient 完全不带鉴权头,而这个分支
 * 之前没有任何测试能覆盖到。这里 CAS_BASE_URL 被设置且真的走
 * editor 的 CasClient 做 lease,是那个修复目前唯一的自动化回归网。
 * 如果 lease 因鉴权错误失败,那是修复本身回归了,不要绕过它。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import { startAzureRuntime } from "../../../stacks/azure/local/runtime.mjs";
import { computeNodeDigest, encodeHeader, hashToHex } from "../../../packages/cas-server-common/src/index.ts";
import { createSBlob, encodeSValue } from "../../../packages/svalue-codec/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";

let miniflare;
let azure;
const USER = "docx-img-user";

/**
 * 专用端口,不用默认的 8787/8789/8790 —— `tests/integration/` 下每个测试文件都这么做
 * (18787 / 28787 / 29787 / 31787 / 32787),原因在这条测试上尤其硬:
 * **本轮自己的 docx 工作流要求另开一个终端跑 `pnpm dev`**,而那正是绑
 * 8787 的进程。用默认端口等于让这条测试与它所依赖的开发流程互相排斥,
 * `pnpm test:local` 会以 "Port 8787 is already in use" 失败。
 */
const MINIFLARE_PORTS = { gateway: 33787, docx: 33789, cas: 33790 };

beforeAll(async () => {
  miniflare = await startLocalRuntime({
    docTypes: ["docx"],
    ports: MINIFLARE_PORTS,
  });
  // Azure 侧刻意不覆盖端口:`startAzureRuntime()` 没有端口覆盖参数,而
  // `azure-behavior` / `azure-multi-replica` 是有意跑默认布局的(那条副本数
  // 闸门验的就是默认值)。三个 Azure 测试在 `--fileParallelism=false` 下顺序
  // 执行,互不重叠;与外部 `pnpm dev --azure` 的冲突由 `assertPortsFree()`
  // 明确报出,不是静默失败。
  azure = await startAzureRuntime({
    docTypes: ["docx"],
    casBaseUrl: miniflare.urls.cas,
  });
}, 240_000);

afterAll(async () => {
  await azure?.dispose();
  await miniflare?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

test("insertImage round-trips on the Azure stack", async () => {
  const png = readFileSync(
    join(process.cwd(), "tests/treespec/create-new-docx/edit/image/tiny.png"),
  );
  const bytes = new Uint8Array(png);
  const header = encodeHeader(bytes.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], bytes);
  const hash = hashToHex(digest);

  // 上传经 Azure gateway —— 它把公开 CAS 路由代理到过渡形态的 CAS worker。
  const upload = await closeFetch(`${azure.urls.gateway}/tenants/${USER}/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      "X-CAS-Lease-Duration": "900000",
    },
    body: bytes,
  });
  expect(upload.ok, JSON.stringify(await upload.clone().text())).toBe(true);
  expect(await upload.json()).toMatchObject({ ready: true });

  const created = await closeFetch(`${azure.urls.gateway}/tenants/${USER}/docs/docx/`, {
    method: "POST",
  });
  const createdBody = await created.json();
  expect(created.ok, JSON.stringify(createdBody)).toBe(true);
  const { docId } = createdBody;

  const applyBody = encodeSValue({
    baseVersion: 1,
    description: "Insert image",
    operations: [
      { kind: "insertImage", payload: { blob: createSBlob(hash), widthPx: 16, altText: "dot" } },
    ],
  });
  const applied = await closeFetch(
    `${azure.urls.gateway}/tenants/${USER}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": SValueContentType },
      body: applyBody.buffer,
    },
  );
  const appliedBody = await applied.json();
  expect(applied.ok, JSON.stringify(appliedBody)).toBe(true);
  expect(appliedBody).toMatchObject({ success: true, version: 2 });

  const queried = await closeFetch(
    `${azure.urls.gateway}/tenants/${USER}/docs/docx/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getImages" }),
    },
  );
  const body = await queried.json();
  expect(body.success).toBe(true);
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ format: "png", altText: "dot" });
});
