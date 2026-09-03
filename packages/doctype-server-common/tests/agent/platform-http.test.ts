/**
 * 本任务只搬运,不改行为,所以测试盯的是**这次真正新增的东西** ——
 * `EditorFetcher` 这层抽象:请求打到哪、转发头带没带、以及"任何带
 * fetch(url, init) 的对象都能满足它"。
 *
 * 刻意不断言响应解析:`query` 走的是 SValue 编码响应
 * (`decodeValueResponse`,见 platform-http.ts 的 query),伪造它等于把实现抄进
 * 测试;而那段解析逻辑本次一个字没动,已由 cloudflare-sdk 的既有测试覆盖。
 */
import { describe, expect, it } from "vitest";
import { createHttpAgentPlatform, type EditorFetcher } from "../../src/agent/platform-http.js";

function recordingEditor(): {
  fetcher: EditorFetcher; calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    // 回一个空体:调用方随后的解析会抛,但请求已经发出并被记下 —— 这正是
    // 本测试要看的东西。
    fetcher: { fetch: async (url, init) => { calls.push({ url, init }); return new Response("", { status: 200 }); } },
  };
}

describe("createHttpAgentPlatform", () => {
  it("query 打到编辑器的 /_internal/query，并原样带上转发头", async () => {
    const { fetcher, calls } = recordingEditor();
    const headers = new Headers({ "X-Tenant-Id": "t1", "X-Session-Id": "s1" });
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: () => fetcher,
      requestHeaders: () => headers,
      editorObjectName: () => "t1:psd:s1",
    });

    // 响应体是空的,解析必然抛 —— 我们要的是它抛之前发出的那个请求。
    await platform.query({ kind: "getText" } as never).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/_internal/query");
    expect(new Headers(calls[0]!.init!.headers).get("X-Tenant-Id")).toBe("t1");
    expect(new Headers(calls[0]!.init!.headers).get("X-Session-Id")).toBe("s1");
  });

  it("getEditorStub 拿到的是 editorObjectName() 的返回值", async () => {
    const { fetcher } = recordingEditor();
    const names: string[] = [];
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: (_env, name) => { names.push(name); return fetcher; },
      requestHeaders: () => new Headers(),
      editorObjectName: () => "t1:psd:s1",
    });

    await platform.query({ kind: "getText" } as never).catch(() => undefined);

    expect(names).toEqual(["t1:psd:s1"]);
  });

  // 这条钉住 EditorFetcher 这个抽象本身：只要它还只要求 `.fetch(url, init)`，
  // 一个纯对象就能满足 —— Azure 那侧才不需要 DurableObjectStub。把类型收回成
  // DurableObjectStub 的话，这行编译不过。
  it("接受任何带 fetch(url, init) 的纯对象，不要求 DurableObjectStub", () => {
    const plain = { fetch: async () => new Response("{}", { status: 200 }) };
    const platform = createHttpAgentPlatform<unknown, unknown, undefined>({
      env: undefined,
      getEditorStub: () => plain,
      requestHeaders: () => new Headers(),
      editorObjectName: () => "n",
    });
    expect(platform).toBeDefined();
  });
});
