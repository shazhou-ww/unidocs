import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentLocation } from "@unidocs/protocol-tenant-portal";
import {
  createMemoryStore, createMemoryTransport, createScriptedAgent, createTenantPortalClient, sampleSeed,
  type MemoryStore,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { anchorKeyOf, createDraftStore } from "../src/drafts/draft-store.js";
import { DocumentPage } from "../src/pages/document.js";

function setup(threadId?: string) {
  const store = createMemoryStore(sampleSeed());
  const agent = createScriptedAgent({ store });
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ store }) });
  const view = render(
    <ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId={threadId} /></ClientProvider>,
  );
  return { store, agent, client, view };
}

const panel = () => screen.findByRole("complementary", { name: "讨论" });

/**
 * 问题 2 的回归测试用夹具：让 doc-sample 上带一份「选区来的评论发送失败」留下的
 * 草稿（threadId 为 null、锚点是 location）。直接写进真实 localStorage，好让随后
 * 渲染的 DocumentPage 的 useDrafts 读到同一份草稿。
 */
function seedOrphanedDraft(): { store: MemoryStore; client: ReturnType<typeof createTenantPortalClient> } {
  const store = createMemoryStore(sampleSeed());
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ store }) });

  const location: DocumentLocation = {
    documentContractIdx: 0,
    locationType: "unidocs.markdown.text-range/v1",
    payload: { start: 0, end: 3, quote: "abc" },
  };
  createDraftStore(localStorage).save({
    draftId: crypto.randomUUID(),
    documentId: "doc-sample",
    anchorKey: anchorKeyOf({ threadId: null, location }),
    threadId: null,
    location,
    baseVersionIdx: 2,
    text: "选区评论失败",
    idempotencyKey: crypto.randomUUID(),
    editedFromCommentIdx: null,
    updatedAt: new Date().toISOString(),
  });

  return { store, client };
}

/**
 * 在「当前版本」正文里选中一段并点出 View 浮出的「添加评论」。jsdom 的 Range 没有
 * getBoundingClientRect（View 靠它定位触发按钮），调用方负责先 stub 上。
 */
async function addCommentOnSelection(quote: string) {
  const region = await screen.findByRole("region", { name: "当前版本" });
  const node = await waitFor(() => {
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      if ((current.textContent ?? "").includes(quote)) return current;
    }
    throw new Error(`quote not rendered: ${quote}`);
  });
  const at = node.textContent!.indexOf(quote);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + quote.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  region.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await userEvent.click(within(region).getByRole("button", { name: "添加评论" }));
}

describe("评论流程", () => {
  beforeEach(() => { localStorage.clear(); window.location.hash = ""; });

  it("面板上没有常驻输入框", async () => {
    setup("th-open");
    expect(within(await panel()).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("点回复才出输入框，取消后收起", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    expect(within(p).getByRole("textbox", { name: "回复这一处" })).toBeInTheDocument();

    await userEvent.click(within(p).getByRole("button", { name: "取消" }));
    expect(within(p).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("发送后追加为该处的新一条，并且该处变回待回复", async () => {
    const { store } = setup("th-answered");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "还想再改一处");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    expect(await within(p).findByText("还想再改一处")).toBeInTheDocument();
    expect(store.getThread("doc-sample", "th-answered").comments).toHaveLength(2);
    expect(within(p).getAllByText("待回复").length).toBeGreaterThan(0);
  });

  it("发送成功后草稿被清掉", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "补一句");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    await within(p).findByText("补一句");
    expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument();
  });

  it("写到一半切去看别处不会丢，并计入「N 条未发送」", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "写了一半");
    // ThreadCard 的切换按钮用 aria-label 覆盖了可访问名（Task 13 起的既定设计，见
    // document-page.test.tsx 的 Ruling C5），不能按摘要原文当按钮名匹配，改按可见
    // 文字定位再取其按钮祖先。原文是 seed.ts 里 th-on-current 的评论原文「这节改得
    // 不错」（没有「一」）——brief 里的 /这一节改得不错/ 与样本数据不符，按实际值改。
    await userEvent.click(within(p).getByText(/这节改得不错/).closest("button")!);

    expect(within(p).getByText("1 条未发送")).toBeInTheDocument();
  });

  it("未发送筛选只留有草稿的一处，草稿显示为黄色虚线块", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "半截话");
    await userEvent.click(within(p).getByRole("button", { name: "未发送" }));

    const blocks = within(p).getAllByRole("note", { name: "未发送的评论" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveTextContent("半截话");
  });

  it("讨论折叠后仍显示未发送草稿且可以丢弃", async () => {
    const { client, view } = setup("th-open");
    const discussion = await panel();
    await userEvent.click(within(discussion).getByRole("button", { name: "回复" }));
    await userEvent.type(within(discussion).getByRole("textbox", { name: "回复这一处" }), "留在这一处的草稿");
    await userEvent.click(within(discussion).getByRole("button", { name: "待回复的讨论 · 折叠" }));
    view.rerender(<ClientProvider client={client}><DocumentPage documentId="doc-sample" /></ClientProvider>);
    const draft = await within(discussion).findByRole("note", { name: "未发送的评论" });
    expect(draft).toHaveTextContent("留在这一处的草稿");
    expect(draft.closest(".collapsed-drafts")).not.toBeNull();
    await userEvent.click(within(draft).getByRole("button", { name: "丢弃" }));
    expect(within(discussion).queryByRole("note", { name: "未发送的评论" })).not.toBeInTheDocument();
  });

  it("已发送的评论不可编辑不可删除，只有「修改」", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "修改" })).toBeInTheDocument();
  });

  it("点修改把原文压回草稿并注明改自哪一条，原评论留在原地", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "修改" }));

    const note = within(p).getByRole("note", { name: "未发送的评论" });
    expect(note).toHaveTextContent("改自评论 1");
    expect(note).toHaveTextContent("这一句还能再收紧吗？");
    expect(within(p).getAllByText("这一句还能再收紧吗？")).toHaveLength(2);
    expect(p.querySelector(".ping-card")).toHaveTextContent("这一句还能再收紧吗？");
  });

  it("水位未覆盖的已发送评论标为正在执行", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).getByText("正在执行")).toBeInTheDocument();
  });

  it("水位已覆盖的已发送评论标为已处理", async () => {
    setup("th-answered");
    const p = await panel();

    expect(within(p).getByText("已处理")).toBeInTheDocument();
  });

  it("改后发送是同一处的新一条，不覆盖原评论", async () => {
    const { store } = setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "修改" }));
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    const thread = store.getThread("doc-sample", "th-open");
    expect(thread.comments).toHaveLength(2);
    expect(thread.comments[0].content.text).toBe("这一句还能再收紧吗？");
  });

  it("发送失败时保留草稿并给出中文说明与重试", async () => {
    const store = createMemoryStore(sampleSeed());
    let failNext = true;
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (failNext && request.method === "POST") {
          failNext = false;
          return { ok: false, error: { error: { code: "limit_exceeded", message: "too many", requestId: "r1" } } };
        }
        return inner(request);
      },
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId="th-open" /></ClientProvider>);
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "会失败一次");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    expect(await within(p).findByRole("alert")).toHaveTextContent("操作太频繁");
    expect(within(p).getByRole("note", { name: "未发送的评论" })).toHaveTextContent("会失败一次");

    await userEvent.click(within(p).getByRole("button", { name: "重试" }));

    expect(await within(p).findByText("会失败一次")).toBeInTheDocument();
    expect(store.getThread("doc-sample", "th-open").comments).toHaveLength(2);
  });

  it("重试复用同一个 idempotencyKey", async () => {
    const store = createMemoryStore(sampleSeed());
    const keys: string[] = [];
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (request.idempotencyKey !== undefined) keys.push(request.idempotencyKey);
        if (keys.length === 1) return { ok: false, error: { error: { code: "limit_exceeded", message: "x", requestId: "r1" } } };
        return inner(request);
      },
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId="th-open" /></ClientProvider>);
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "重试用同 key");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));
    await within(p).findByRole("alert");
    await userEvent.click(within(p).getByRole("button", { name: "重试" }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("依然没有解决、重新打开或批量提交", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /提交.*条/ })).not.toBeInTheDocument();
  });

  // 问题 2：选区评论发送失败后，anchorKeyOf({ threadId: null, location }) 产出的
  // 是 location:… 锚点，任何 thread 卡片都不会认领它——但 draftCount 仍然把它算
  // 进「N 条未发送」。草稿必须自己渲染成一张能点得到的卡片，不能只被计数、摸不着。
  it("选区评论发送失败留下的草稿单独渲染成卡片，可以重试发送", async () => {
    const { store, client } = seedOrphanedDraft();

    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" /></ClientProvider>);
    const p = await panel();

    expect(within(p).getByText("1 条未发送")).toBeInTheDocument();
    const note = within(p).getByRole("note", { name: "未发送的评论" });
    expect(note).toHaveTextContent("选区评论失败");

    await userEvent.click(within(note).getByRole("button", { name: "发送" }));

    await waitFor(() => expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument());
    const threadIds = store.listThreadIds("doc-sample");
    const sent = threadIds.some(
      (threadId) => store.getThread("doc-sample", threadId).comments[0]?.content.text === "选区评论失败",
    );
    expect(sent).toBe(true);
  });

  it("选区评论发送失败留下的草稿可以丢弃，丢弃后「N 条未发送」清零", async () => {
    const { client } = seedOrphanedDraft();

    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" /></ClientProvider>);
    const p = await panel();

    const note = within(p).getByRole("note", { name: "未发送的评论" });
    await userEvent.click(within(note).getByRole("button", { name: "丢弃" }));

    expect(within(p).queryByRole("note", { name: "未发送的评论" })).not.toBeInTheDocument();
    expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument();
  });

  describe("选中正文添加评论", () => {
    const original = Range.prototype.getBoundingClientRect;
    beforeEach(() => { Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 10); });
    afterEach(() => { Range.prototype.getBoundingClientRect = original; });

    it("在讨论面板里打开和「回复」同一个输入框，带上选中的原文，正文里不浮出输入框", async () => {
      setup();
      const p = await panel();

      await addCommentOnSelection("平台让人和外部");

      const card = within(p).getByRole("group", { name: "新的一处" });
      expect(card).toHaveTextContent("平台让人和外部");
      expect(within(card).getByRole("textbox", { name: "添加评论" }).closest(".composer")).not.toBeNull();
      expect(within(screen.getByRole("region", { name: "当前版本" })).queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("发送后成为新的一处，位置就是选中的原文，草稿清掉", async () => {
      const { store } = setup();
      const p = await panel();

      await addCommentOnSelection("平台让人和外部");
      await userEvent.type(within(p).getByRole("textbox", { name: "添加评论" }), "这句太长了");
      await userEvent.click(within(p).getByRole("button", { name: "发送" }));

      await waitFor(() => {
        const created = store.listThreadIds("doc-sample")
          .map((threadId) => store.getThread("doc-sample", threadId))
          .find((thread) => thread.comments[0]?.content.text === "这句太长了");
        expect(created?.comments[0]?.location?.payload).toMatchObject({ quote: "平台让人和外部" });
        expect(created?.comments[0]?.baseVersionIdx).toBe(2);
      });
      expect(within(p).queryByRole("group", { name: "新的一处" })).not.toBeInTheDocument();
      expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument();
    });

    it("取消就收起，不留草稿", async () => {
      setup();
      const p = await panel();

      await addCommentOnSelection("平台让人和外部");
      await userEvent.type(within(p).getByRole("textbox", { name: "添加评论" }), "算了");
      await userEvent.click(within(p).getByRole("button", { name: "取消" }));

      expect(within(p).queryByRole("group", { name: "新的一处" })).not.toBeInTheDocument();
      expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument();
    });

    it("发送失败时留下可重试的草稿，重试复用同一个 idempotencyKey", async () => {
      const store = createMemoryStore(sampleSeed());
      const keys: string[] = [];
      const inner = createMemoryTransport({ store });
      const client = createTenantPortalClient({
        tenantId: "t1",
        transport: async (request) => {
          if (request.idempotencyKey !== undefined) keys.push(request.idempotencyKey);
          if (keys.length === 1) return { ok: false, error: { error: { code: "limit_exceeded", message: "x", requestId: "r1" } } };
          return inner(request);
        },
      });
      render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" /></ClientProvider>);
      const p = await panel();

      await addCommentOnSelection("平台让人和外部");
      await userEvent.type(within(p).getByRole("textbox", { name: "添加评论" }), "会失败一次");
      await userEvent.click(within(p).getByRole("button", { name: "发送" }));

      const note = await within(p).findByRole("note", { name: "未发送的评论" });
      expect(await within(note).findByRole("alert")).toHaveTextContent("操作太频繁");
      await userEvent.click(within(note).getByRole("button", { name: "重试" }));

      await waitFor(() => expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument());
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });
  });
});
