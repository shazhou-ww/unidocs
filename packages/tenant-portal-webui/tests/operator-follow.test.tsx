/**
 * R17：Operator 是异步的，没有推送通道，文档页靠轮询跟上它。
 * 用 fake timers 推进 1.5 秒的轮询间隔（只伪造 setTimeout/clearTimeout/Date）。
 *
 * testing-library 只认得 Jest 的 fake timers：它靠全局 `jest` 判断，否则 asyncWrapper
 * 会等一个被伪造、永远不触发的 setTimeout(0)，findBy/waitFor 全部挂死。所以这里给它一个
 * 只有 advanceTimersByTime 的 `jest` 垫片，指向 vitest 的实现；waitFor 因此会在每轮检查间
 * 推进 50ms 假时间，这和它在 Jest 下的行为一致，下面的读取计数都按「至少」或「停止增长」写。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStore, createMemoryTransport, createScriptedAgent, createTenantPortalClient, sampleSeed,
  type MemorySeed, type PlatformRequest, type PlatformTransport,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";
import { TEST_DRAFT_SCOPE } from "./draft-scope.js";

function harness(seed: MemorySeed, documentId: string, threadId?: string) {
  const store = createMemoryStore(seed);
  const inner = createMemoryTransport({ store });
  const requests: PlatformRequest[] = [];
  // holdComments 为真时，追加评论的 POST 挂起，直到测试调用 releaseComments——
  // 用来制造「请求还在路上，用户已经离开」的时序。
  const control = { holdComments: false, releaseComments: () => {} };
  const transport: PlatformTransport = async (request) => {
    requests.push(request);
    if (control.holdComments && request.method === "POST" && request.path.endsWith("/comments")) {
      await new Promise<void>((resolve) => { control.releaseComments = resolve; });
    }
    return inner(request);
  };
  const client = createTenantPortalClient({ tenantId: "t1", transport });
  const page = (id: string, thread?: string) => (
    <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><DocumentPage documentId={id} threadId={thread} /></ClientProvider>
  );
  const view = render(page(documentId, threadId));
  const reads = (suffix: string) =>
    requests.filter((request) => request.method === "GET" && request.path.endsWith(suffix)).length;
  const posts = (suffix: string) =>
    requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix)).length;
  return { store, view, reads, posts, control, page };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const newDocumentSeed: MemorySeed = {
  documents: [{ documentId: "doc-new", name: "新作品", versions: [], threads: [] }],
};

describe("文档页跟随 Operator", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
  });
  afterEach(() => {
    delete (globalThis as { jest?: unknown }).jest;
    vi.useRealTimers();
  });

  it("没有版本时每 1.5 秒重拉文档，版本出现后渲染正文、等待文案消失", async () => {
    const { store, reads } = harness(newDocumentSeed, "doc-new");
    expect(await screen.findByText(/等待 Operator 初始化/)).toBeInTheDocument();

    const before = reads("/documents/doc-new");
    await advance(1500);
    expect(reads("/documents/doc-new")).toBeGreaterThan(before);
    expect(screen.getByText(/等待 Operator 初始化/)).toBeInTheDocument();

    store.appendVersion(store.requireDocument("doc-new"), "# 新作品\n\nOperator 写下的第一版。\n", "agent:markdown-primary");
    await advance(1500);

    const pane = await screen.findByRole("region", { name: "当前版本" });
    expect(await within(pane).findByText("Operator 写下的第一版。")).toBeInTheDocument();
    expect(screen.queryByText(/等待 Operator 初始化/)).not.toBeInTheDocument();
    expect(screen.getByText("当前 v0")).toBeInTheDocument();

    // 版本到了就不再轮询。
    const settled = reads("/documents/doc-new");
    await advance(10_000);
    expect(reads("/documents/doc-new")).toBe(settled);
  });

  it("卸载后不再读取", async () => {
    const { view, reads } = harness(newDocumentSeed, "doc-new");
    await screen.findByText(/等待 Operator 初始化/);
    await advance(1500);
    const before = reads("/documents/doc-new");
    expect(before).toBeGreaterThan(1);

    view.unmount();
    await advance(30_000);

    expect(reads("/documents/doc-new")).toBe(before);
  });

  it("60 秒还没有版本就停下，提示 Operator 暂未响应", async () => {
    const { reads } = harness(newDocumentSeed, "doc-new");
    await screen.findByText(/等待 Operator 初始化/);
    expect(screen.queryByText("Operator 暂未响应，可稍后刷新")).not.toBeInTheDocument();

    await advance(60_000);

    expect(await screen.findByText("Operator 暂未响应，可稍后刷新")).toBeInTheDocument();
    const settled = reads("/documents/doc-new");
    await advance(10_000);
    expect(reads("/documents/doc-new")).toBe(settled);
  });

  it("发评论后轮询该 thread，直到出现覆盖这条评论的 reply 才停，并刷新出 reply 带来的新版本", async () => {
    const { store, reads } = harness(sampleSeed(), "doc-sample", "th-answered");
    const agent = createScriptedAgent({
      store,
      respond: () => ({ text: "已按第二条改好。", producesContent: "# 改好的版本\n" }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const panel = await screen.findByRole("complementary", { name: "讨论" });
    expect(screen.getByText("当前 v2")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "回复" }));
    await user.type(within(panel).getByRole("textbox", { name: "回复这一处" }), "再补一句");
    await user.click(within(panel).getByRole("button", { name: "发送" }));
    await within(panel).findByText("再补一句");
    expect(store.getThread("doc-sample", "th-answered").comments).toHaveLength(2);

    // th-answered 已有一条 reply，但它只覆盖到 commentIdx 0；新评论是 1，不算回复到了。
    const thread = "/threads/th-answered";
    const before = reads(thread);
    await advance(1500);
    await advance(1500);
    expect(reads(thread)).toBeGreaterThanOrEqual(before + 2);
    expect(within(panel).queryByText("已按第二条改好。")).not.toBeInTheDocument();

    agent.runPending({ documentId: "doc-sample", threadId: "th-answered" });
    await advance(1500);

    expect(await within(panel).findByText("已按第二条改好。")).toBeInTheDocument();
    expect(await screen.findByText("当前 v3")).toBeInTheDocument();

    const settled = reads(thread);
    await advance(10_000);
    expect(reads(thread)).toBe(settled);
    expect(screen.queryByText("Operator 暂未响应，可稍后刷新")).not.toBeInTheDocument();
  });

  it("发评论后还在等 reply 时卸载，不再读取该 thread", async () => {
    const { view, reads } = harness(sampleSeed(), "doc-sample", "th-answered");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await user.click(within(panel).getByRole("button", { name: "回复" }));
    await user.type(within(panel).getByRole("textbox", { name: "回复这一处" }), "等一下就走");
    await user.click(within(panel).getByRole("button", { name: "发送" }));
    await within(panel).findByText("等一下就走");
    expect(screen.getByText("等待 Operator 回复…")).toBeInTheDocument();
    await advance(1500);

    const before = reads("/threads/th-answered");
    view.unmount();
    await advance(30_000);

    expect(reads("/threads/th-answered")).toBe(before);
  });

  it("评论 POST 还在路上时卸载：请求回来后不开始等 reply，不再读取也不落状态", async () => {
    const { view, reads, posts, control } = harness(sampleSeed(), "doc-sample", "th-answered");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    control.holdComments = true;
    await user.click(within(panel).getByRole("button", { name: "回复" }));
    await user.type(within(panel).getByRole("textbox", { name: "回复这一处" }), "发出去就走");
    await user.click(within(panel).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(posts("/threads/th-answered/comments")).toBe(1));

    view.unmount();
    const before = reads("/threads/th-answered");
    await act(async () => { control.releaseComments(); });
    await advance(30_000);

    expect(reads("/threads/th-answered")).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("评论 POST 还在路上时切到另一篇：不读旧文档的 thread，新文档上也不出现等待或超时提示", async () => {
    const { view, reads, posts, control, page } = harness(sampleSeed(), "doc-sample", "th-answered");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    control.holdComments = true;
    await user.click(within(panel).getByRole("button", { name: "回复" }));
    await user.type(within(panel).getByRole("textbox", { name: "回复这一处" }), "发出去就换一篇");
    await user.click(within(panel).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(posts("/threads/th-answered/comments")).toBe(1));

    // DocumentPage 不按 documentId 加 key（app.tsx），切文档是同一个组件实例换 props。
    view.rerender(page("doc-empty"));
    expect(await screen.findByRole("heading", { name: "共创空间 · 发布手记" })).toBeInTheDocument();
    const before = reads("/documents/doc-sample/threads/th-answered");
    await act(async () => { control.releaseComments(); });
    await advance(1500);
    expect(screen.queryByText("等待 Operator 回复…")).not.toBeInTheDocument();
    await advance(60_000);

    expect(reads("/documents/doc-sample/threads/th-answered")).toBe(before);
    expect(screen.queryByText("等待 Operator 回复…")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator 暂未响应，可稍后刷新")).not.toBeInTheDocument();
  });

  it("发评论后 60 秒没有回复就提示 Operator 暂未响应", async () => {
    harness(sampleSeed(), "doc-sample", "th-answered");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await user.click(within(panel).getByRole("button", { name: "回复" }));
    await user.type(within(panel).getByRole("textbox", { name: "回复这一处" }), "没人回");
    await user.click(within(panel).getByRole("button", { name: "发送" }));
    await within(panel).findByText("没人回");

    await advance(60_000);
    await waitFor(() => expect(screen.getByText("Operator 暂未响应，可稍后刷新")).toBeInTheDocument());
  });
});
