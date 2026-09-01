import { describe, it, expect, vi, beforeEach } from "vitest";
import { postForm } from "../src/doc-controller.js";

/** 最小的 XMLHttpRequest 替身。jsdom 自带的那个会真的去发请求,而这里要考的
 *  恰恰是几个回调的触发顺序,所以整个换掉。 */
class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onload: (() => void) | null } = { onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = "";
  status = 0;
  opened: [string, string] | null = null;
  sent: unknown = null;
  constructor() { FakeXHR.last = this; }
  open(method: string, url: string): void { this.opened = [method, url]; }
  send(body: unknown): void { this.sent = body; }
}

beforeEach(() => {
  FakeXHR.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

describe("postForm", () => {
  it("POSTs the form to the given url", () => {
    const fd = new FormData();
    void postForm("/tenants/u1/docs/psd/", fd, () => {});
    expect(FakeXHR.last!.opened).toEqual(["POST", "/tenants/u1/docs/psd/"]);
    expect(FakeXHR.last!.sent).toBe(fd);
  });

  // 这是整个 helper 存在的理由:最后一个字节离开浏览器,和服务器解析完 PSD
  // 回话,是两个时刻。fetch 下它们是一个不透明的 await,而对一个大 PSD 这
  // 恰好是最长、且时长差别最大的两段。
  it("signals the upload finishing separately from the response arriving", async () => {
    const seen: string[] = [];
    const xhr = (): FakeXHR => FakeXHR.last!;
    const p = postForm("/u", new FormData(), () => seen.push("uploaded"));

    xhr().upload.onload!();
    expect(seen).toEqual(["uploaded"]);

    xhr().status = 200;
    xhr().responseText = JSON.stringify({ success: true, docId: "doc-a" });
    xhr().onload!();
    await expect(p).resolves.toEqual({ success: true, docId: "doc-a" });
  });

  it("resolves the parsed body without judging it — success is the caller's check", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.status = 200;
    FakeXHR.last!.responseText = JSON.stringify({ success: false, error: "not a psd" });
    FakeXHR.last!.onload!();
    await expect(p).resolves.toEqual({ success: false, error: "not a psd" });
  });

  it("rejects on a network error", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.onerror!();
    await expect(p).rejects.toThrow("网络错误");
  });

  it("rejects on an aborted request", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.onabort!();
    await expect(p).rejects.toThrow("请求已中断");
  });

  // 网关 5xx 时返回的是一个 HTML 错误页,JSON.parse 会抛。不接住的话它会以
  // 一个语法错误的形式冒到用户面前,而真正有用的是那个状态码。
  it("rejects with the status code when the body is not JSON", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.status = 502;
    FakeXHR.last!.responseText = "<html>Bad Gateway</html>";
    FakeXHR.last!.onload!();
    await expect(p).rejects.toThrow("HTTP 502");
  });
});
