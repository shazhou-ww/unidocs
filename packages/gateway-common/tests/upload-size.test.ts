/**
 * 网关上传路径的内存边界。
 *
 * 线上踩到的:一个 237MB 的 PSD 让**网关**进程死掉(readiness probe
 * connection refused → 重启),请求根本没走到 doc service。给 doc service 加
 * 内存只是把崩溃点往上游推了一跳。
 *
 * 原因在 `readCloneSource()`:它为了判断有没有 `sourceId` 字段,对 multipart
 * 请求做 `request.clone().formData()` —— 把整个 body 解析进内存,而且 clone
 * 意味着同时存在两份(克隆那份被完整缓冲,原始那份留着流式转发)。
 *
 * 两条防线,缺一不可:
 *  1. 超过上限直接 413,body 一个字节都不碰。
 *  2. 上限之内、但明显不可能是克隆请求的体积,跳过那次 formData() ——
 *     克隆请求只带一个 sourceId 字段,几百字节封顶。
 */
import { describe, expect, it } from "vitest";
import { createGatewayHandler } from "../src/gateway-handler.js";
import { GatewayCapabilityAuthority } from "../src/capability-authority.js";
import { MemoryGatewayDocumentDirectory } from "../src/document-directory.js";

const issuer = { keyId: "test-key", issue: async () => "test-token" };
const capabilityAuthority = new GatewayCapabilityAuthority({
  issuer,
  casIssuer: issuer,
  casAudience: "unidocs-cas",
  casStackId: "test-stack",
});

const tenantIdentity = {
  resolve: async (_r: Request, tenantId: string) => ({
    userId: `local:${tenantId}`,
    tenantId,
    canManageTenant: true,
  }),
};

function handler(maxUploadBytes?: number) {
  const forwarded: Request[] = [];
  return {
    forwarded,
    handle: createGatewayHandler({
      capabilityAuthority,
      casStackId: "test-stack",
      identityResolver: tenantIdentity,
      resolveDocService: async () => ({
        serviceId: "psd",
        url: "http://doc.invalid",
        audience: "unidocs-doc:psd",
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
      ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
    } as never),
  };
}

function upload(bytes: number, declared?: number): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "big.psd"));
  const request = new Request("https://gw/tenants/u1/docs/psd/", { method: "POST", body: form });
  if (declared !== undefined) request.headers.set("Content-Length", String(declared));
  return request;
}

describe("网关上传体积", () => {
  it("超过上限返回 413", async () => {
    const { handle } = handler(1024);
    const res = await handle(upload(16, 10_000));
    expect(res.status).toBe(413);
  });

  it("413 的响应体点明上限", async () => {
    const { handle } = handler(1024);
    const body = await (await handle(upload(16, 10_000))).json() as { error: string };
    expect(body.error).toMatch(/1024/);
  });

  it("不配上限时不设限（保持既有行为）", async () => {
    const { handle } = handler();
    // 上游不可达 → 502,重点是它没有在体积上先被拒。
    const res = await handle(upload(16, 10_000));
    expect(res.status).not.toBe(413);
  });
});
