/**
 * docx 含图片的 apply 在 Azure 栈的 STACK 模式下跑通 —— bullet 8 的验收。
 * CAS 走本地嵌入的中间件（注册 unidocs-azure 栈）：
 *  - 图片上传经 azure gateway 的公开 CAS 路由，stack 模式下转发到规范
 *    /stacks/unidocs-azure/tenants/{tenant}/cas/nodes/{hash} 打到中间件；
 *  - apply 的 lease/root-ref helpers 经 azure doc 服务的
 *    tenant CAS client（capability + stackId）打到中间件；
 *  - 中间件的 tenant 存储里留下该图片节点的 root 引用。
 * 过渡形态（cf legacy CAS worker + 共享密钥）在此不再参与。
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startAzureRuntime } from "../../../stacks/unidocs-azure/local/runtime.mjs";
import { computeNodeDigest, encodeHeader, hashToHex } from "../../../unicas-packages/server-common/src/index.ts";
import { createSBlob, encodeSValue } from "../../../packages/svalue-codec/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";

let azure;
const USER = "docx-img-user";

beforeAll(async () => {
  azure = await startAzureRuntime({
    docTypes: ["docx"],
    internalAuthMode: "stack",
  });
}, 240_000);

afterAll(async () => {
  await azure?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

test("insertImage round-trips on the Azure stack through the middleware", async () => {
  const png = readFileSync(
    join(process.cwd(), "tests/treespec/create-new-docx/edit/image/tiny.png"),
  );
  const bytes = new Uint8Array(png);
  const header = encodeHeader(bytes.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], bytes);
  const hash = hashToHex(digest);

  // 上传经 Azure gateway —— stack 模式下转发到规范路由，打到中间件。
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

  // 中间件（unidocs-azure 栈）已持有该图片节点的 root 引用。
  const retained = await azure.middleware.storage.middlewareRetainedRoots("unidocs-azure", USER);
  const blobRow = retained.find((row) => row.hash === hash);
  expect(blobRow).toBeDefined();
  expect(blobRow.count).toBe(1);
}, 60_000);
