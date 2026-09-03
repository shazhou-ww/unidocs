/**
 * 上传体积上限。
 *
 * 线上踩到的:一个 237MB 的 PSD 打到 1 GiB 的容器上,进程被内核 SIGKILL,
 * Envoy 返回 503 `connection termination`,副本进 CrashLoopBackOff。危害不止
 * 于"这个文件传不上去" —— 同一副本上其他人正在处理的请求一起没了。
 *
 * 上限必须在 `request.formData()` **之前**用 Content-Length 判:那一步本身
 * 就把整个 body 读进内存,等到 `file.arrayBuffer()` 再判已经晚了一个副本。
 * 分块上传没有 Content-Length,那时才退回用 `file.size` 兜底 —— 只能拦住
 * 后续的拷贝与解析放大,拦不住第一份,所以它是补充而非替代。
 */
import { describe, expect, it } from "vitest";
import { createSessionHandler } from "../src/session-handler.js";

const identity = { tenantId: "t1", sessionId: "s1", docType: "psd" };

function handler(maxUploadBytes?: number) {
  const created: { bytes?: Uint8Array; format?: string }[] = [];
  const session = {
    // session-handler now reads `session.config` to run `selectFormat` on
    // any upload that carries a `file` — this fixture didn't exercise format
    // selection before, so give it just enough config to not blow up.
    config: {
      formats: { psd: { mediaTypes: ["image/vnd.adobe.photoshop"], extensions: [".psd"] } },
      defaultFormat: "psd",
    },
    create: async (input: { bytes?: Uint8Array; format?: string }) => {
      created.push(input);
      return { sessionId: "s1", version: 1 };
    },
  };
  return {
    created,
    handle: createSessionHandler({
      session: session as never,
      identity: identity as never,
      ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
    }),
  };
}

function upload(bytes: number, declaredLength?: number): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "big.psd", {
    type: "image/vnd.adobe.photoshop",
  }));
  const request = new Request("https://svc/_internal/create", { method: "POST", body: form });
  if (declaredLength !== undefined) {
    request.headers.set("Content-Length", String(declaredLength));
  }
  return request;
}

describe("上传体积上限", () => {
  it("超过上限的 Content-Length 直接 413，且不触碰 body", async () => {
    const { created, handle } = handler(1024);
    const res = await handle(upload(16, 5000));
    expect(res.status).toBe(413);
    // 关键:根本没走到 create,说明也没走到 formData()。
    expect(created).toHaveLength(0);
  });

  it("413 的响应体说明上限是多少", async () => {
    const { handle } = handler(1024);
    const body = await (await handle(upload(16, 5000))).json() as { error: string };
    expect(body.error).toMatch(/1024/);
  });

  it("没有 Content-Length 时靠 file.size 兜底", async () => {
    const { created, handle } = handler(1024);
    const res = await handle(upload(4096));
    expect(res.status).toBe(413);
    expect(created).toHaveLength(0);
  });

  it("上限内的上传照常创建", async () => {
    const { created, handle } = handler(1024);
    const res = await handle(upload(16));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].bytes).toHaveLength(16);
  });

  it("不配上限时不设限（保持既有行为）", async () => {
    const { created, handle } = handler();
    const res = await handle(upload(4096, 4096));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
  });
});
