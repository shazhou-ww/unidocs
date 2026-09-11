import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStore, createMemoryTransport, createScriptedAgent, createTenantPortalClient, sampleSeed,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
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
    expect(store.getThread("doc-sample", "th-answered").pings).toHaveLength(2);
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
    // 文字定位再取其按钮祖先。原文是 seed.ts 里 th-on-current 的 ping 原文「这节改得
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

    // 原文本就同时出现在折叠摘要与展开的原评论卡片里；「修改」会再压一份副本进草稿块，
    // 所以这里按 getAllByText 断言「原评论留在原地」——它不是消失后被替换，是还在，
    // 且草稿块里多了一份注明来源的副本。用单数 getByText 断言会在功能正确时反而报
    // 「多个匹配」，不能真的分辨行为，所以改成这样。
    const note = within(p).getByRole("note", { name: "未发送的评论" });
    expect(note).toHaveTextContent("改自评论 1");
    expect(note).toHaveTextContent("这一句还能再收紧吗？");
    expect(within(p).getAllByText("这一句还能再收紧吗？").length).toBeGreaterThanOrEqual(2);
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
    expect(thread.pings).toHaveLength(2);
    expect(thread.pings[0].content.text).toBe("这一句还能再收紧吗？");
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
    expect(store.getThread("doc-sample", "th-open").pings).toHaveLength(2);
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
});
