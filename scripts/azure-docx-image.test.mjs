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
import { startLocalRuntime } from "./local-runtime.mjs";
import { startAzureRuntime } from "./azure-runtime.mjs";
import { computeNodeDigest, encodeHeader, hashToHex } from "../packages/cas/src/index.ts";

let miniflare;
let azure;
const USER = "docx-img-user";

beforeAll(async () => {
  miniflare = await startLocalRuntime({ docTypes: ["docx"] });
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
    join(process.cwd(), "tests/bootstrap/create-new-docx/edit/image/tiny.png"),
  );
  const bytes = new Uint8Array(png);
  const header = encodeHeader(bytes.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], bytes);
  const hash = hashToHex(digest);

  // 上传经 Azure gateway —— 它把公开 CAS 路由代理到过渡形态的 CAS worker。
  const upload = await closeFetch(`${azure.urls.gateway}/users/${USER}/cas/nodes/${hash}`, {
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

  const created = await closeFetch(`${azure.urls.gateway}/users/${USER}/docs/docx/`, {
    method: "POST",
  });
  const { docId } = await created.json();

  const applied = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersion: 1,
        description: "Insert image",
        operations: [
          { kind: "insertImage", payload: { hash, widthPx: 16, altText: "dot" } },
        ],
      }),
    },
  );
  const appliedBody = await applied.json();
  expect(applied.ok, JSON.stringify(appliedBody)).toBe(true);
  expect(appliedBody).toMatchObject({ success: true, version: 2 });

  const queried = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/docx/${docId}/query`,
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
