import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "../../../scripts/local-runtime.mjs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
} from "../../../packages/cas/src/index.ts";

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

test("updateRootRefs 失败时:apply 返回 502,delta 被删除,版本不变", async () => {
  const userId = "rollback-cas-user";

  // 图片经由 gateway 上传,gateway 连的是真 CAS,所以节点是 ready 的。
  const header = encodeHeader(PNG_1x1.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], PNG_1x1);
  const hash = hashToHex(digest);

  const lease = await closeFetch(`${GW()}/users/${userId}/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(PNG_1x1.length),
      "X-CAS-Lease-Duration": "900000",
    },
    body: PNG_1x1,
  });
  expect(lease.ok, await lease.text()).toBe(true);

  const create = await closeFetch(`${GW()}/users/${userId}/docs/docx/`, {
    method: "POST",
  });
  const { docId } = await create.json();

  // editor 连的是假 CAS:lease 与读内容照常成功,只有 root-refs 失败。
  const apply = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/apply`,
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

  expect(apply.status).toBe(502);
  const applied = await apply.json();
  expect(applied.success).toBe(false);
  expect(applied.error).toContain("CAS root-refs failed");
  expect(applied.version).toBe(1);

  // 那条已写入的 delta 必须被删掉,历史里只剩创建时的 version 1
  const history = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/history`,
  );
  const { data, version } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1]);
  expect(version).toBe(1);

  // 文档内容也不能留下那张图
  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getImages" }),
    },
  );
  const result = await query.json();
  expect(result.success).toBe(true);
  expect(result.data).toEqual([]);
}, 60_000);
