import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
} from "../../../packages/cas-server-common/src/index.ts";
import { createSBlob, decodeSValue, encodeSValue } from "../../../packages/svalue-codec/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";

const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let runtime;
const GW = () => runtime.urls.gateway;

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    ports: { gateway: 32787, docx: 32789 },
    casFault: true,
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("updateRootRefs 短暂失败时:apply 返回 502,pending 在下次请求恢复", async () => {
  const userId = "rollback-cas-user";

  // 图片经由 gateway 上传,gateway 连的是真 CAS,所以节点是 ready 的。
  const header = encodeHeader(PNG_1x1.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], PNG_1x1);
  const hash = hashToHex(digest);

  const lease = await closeFetch(`${GW()}/tenants/${userId}/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(PNG_1x1.length),
      "X-CAS-Lease-Duration": "900000",
    },
    body: PNG_1x1,
  });
  expect(lease.ok, await lease.text()).toBe(true);

  const create = await closeFetch(`${GW()}/tenants/${userId}/docs/docx/`, {
    method: "POST",
  });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);
  const { docId } = created;

  // editor 连的是假 CAS:lease 与读内容照常成功,只有 root-refs 失败。
  const applyBody = encodeSValue({
    baseVersion: 1,
    description: "Insert image",
    operations: [{
      kind: "insertImage",
      payload: { blob: createSBlob(hash), widthPx: 16, altText: "dot" },
    }],
  });
  const apply = await closeFetch(
    `${GW()}/tenants/${userId}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": SValueContentType },
      body: applyBody.buffer,
    },
  );

  const applied = await apply.json();
  expect(apply.status, JSON.stringify(applied)).toBe(502);
  expect(applied.success).toBe(false);
  expect(applied.error).toContain("CAS updateRootRefs failed");
  expect(applied.version).toBe(1);

  // 重试 apply 会先用 CAS 读写权限恢复 pending，再报告请求版本已落后。
  const retry = await closeFetch(
    `${GW()}/tenants/${userId}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": SValueContentType },
      body: applyBody.buffer,
    },
  );
  const retried = await retry.json();
  expect(retry.status, JSON.stringify(retried)).toBe(409);
  expect(retried).toMatchObject({ success: false, version: 2 });

  // 恢复后的文档包含已确认提交的操作。
  const query = await closeFetch(
    `${GW()}/tenants/${userId}/docs/docx/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getImages" }),
    },
  );
  const result = await query.json();
  expect(result.success).toBe(true);
  expect(result.data).toHaveLength(1);
  expect(result.data[0]).toMatchObject({ format: "png", altText: "dot" });

  // history 无需 CAS 权限，只读取已经恢复并提交的历史。
  const history = await closeFetch(
    `${GW()}/tenants/${userId}/docs/docx/${docId}/history`,
    { headers: { Accept: SValueContentType } },
  );
  const historyError = history.ok ? "" : await history.clone().text();
  expect(history.ok, historyError).toBe(true);
  const historyBody = decodeSValue(new Uint8Array(await history.arrayBuffer()));
  const { data, version } = historyBody;
  expect(data.map((entry) => entry.version)).toEqual([1, 2]);
  expect(version).toBe(2);
}, 60_000);
