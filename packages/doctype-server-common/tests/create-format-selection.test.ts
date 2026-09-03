/**
 * 覆盖率护栏:`session-handler.ts` 的 `/_internal/create` 分支把
 * `file.name`/`file.type` 喂给 `selectFormat`,再把选中的格式名显式传给
 * `session.create({ bytes, format })`。
 *
 * 这一行此前没有任何测试覆盖——`session.test.ts` 里的格式用例直接调
 * `session.create({ format: "upper" })`,绕过了 handler;`upload-limit.test.ts`
 * 只是给假 session 补了个 `config` 让 handler 别崩,从不断言选中的格式。
 *
 * 真实风险:`Session.create` 内部本来就会再调一次 `selectFormat`(见
 * session.ts:368-369),但那次调用只看 `input.format`——不看 mediaType/
 * filename。所以 handler 里这段"看起来冗余"的选格式代码其实是唯一真正
 * 依据 file.name/file.type 做判断的地方;删掉它(改成 `session.create({
 * bytes })`),Azure 的 PNG 导入会静默退回 defaultFormat("psd"),PNG 字节
 * 被当 PSD 解析,而且不会有任何测试变红——直到这条补上。
 *
 * 用 upload-limit.test.ts 同一套"造假 session + createSessionHandler + 发真
 * 实 Request"夹具。
 */
import { describe, expect, it } from "vitest";
import { createSessionHandler } from "../src/session-handler.js";

const identity = { tenantId: "t1", sessionId: "s1", docType: "psd" };

function handler() {
  const created: { bytes?: Uint8Array; format?: string }[] = [];
  const session = {
    config: {
      formats: {
        psd: { mediaTypes: ["image/vnd.adobe.photoshop"], extensions: [".psd"] },
        png: { mediaTypes: ["image/png"], extensions: [".png"] },
      },
      defaultFormat: "psd",
    },
    create: async (input: { bytes?: Uint8Array; format?: string }) => {
      created.push(input);
      return { sessionId: "s1", version: 1 };
    },
  };
  return {
    created,
    handle: createSessionHandler({ session: session as never, identity: identity as never }),
  };
}

function upload(filename: string, mediaType: string | undefined): Request {
  const form = new FormData();
  // 没有 MIME 就传空串——同 File 构造函数在缺省 options.type 时的行为一致,
  // 也和 selectFormat.ts 文档注释里"调用方没有时传 undefined"的口径对齐:
  // 这里模拟"浏览器/客户端没能猜出 MIME"的真实场景(无扩展名上传时最常见)。
  const options = mediaType === undefined ? {} : { type: mediaType };
  form.append("file", new File([new Uint8Array([1, 2, 3])], filename, options));
  return new Request("https://svc/_internal/create", { method: "POST", body: form });
}

describe("createSessionHandler /_internal/create — 格式选择接上 file.name/file.type", () => {
  it(".png 文件名 -> 传给 session.create 的 format 是 \"png\"", async () => {
    const { created, handle } = handler();
    const res = await handle(upload("photo.png", "image/png"));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]!.format).toBe("png");
  });

  it(".psd 文件名 -> format 是 \"psd\"", async () => {
    const { created, handle } = handler();
    const res = await handle(upload("layers.psd", "image/vnd.adobe.photoshop"));
    expect(res.status).toBe(200);
    expect(created[0]!.format).toBe("psd");
  });

  it("无扩展名且无 MIME -> 回落 defaultFormat", async () => {
    const { created, handle } = handler();
    const res = await handle(upload("upload", undefined));
    expect(res.status).toBe(200);
    expect(created[0]!.format).toBe("psd");
  });
});
