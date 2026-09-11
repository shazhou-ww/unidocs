import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function renderPage(props: { threadId?: string; pingIdx?: number } = {}) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client}>
      <DocumentPage documentId="doc-sample" threadId={props.threadId} pingIdx={props.pingIdx} />
    </ClientProvider>,
  );
}

describe("DocumentPage", () => {
  it("顶栏标出内容只读、由 Agent 编辑", async () => {
    renderPage();
    expect(await screen.findByText("只读 · 内容由 Agent 编辑")).toBeInTheDocument();
  });

  it("没有选中一处时是单栏 current", async () => {
    renderPage();
    await screen.findByText("只读 · 内容由 Agent 编辑");

    expect(screen.getByRole("region", { name: "当前版本" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /评论所基于的版本/ })).not.toBeInTheDocument();
  });

  it("渲染 current 的正文", async () => {
    renderPage();
    const pane = await screen.findByRole("region", { name: "当前版本" });

    expect(within(pane).getByText(/这一节已重写为简明表述。/)).toBeInTheDocument();
  });

  it("讨论面板按待回复/已回复分别标出每一处", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).getAllByText("待回复").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("已回复").length).toBeGreaterThan(0);
  });

  it("面板上没有解决、重新打开或批量提交", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /提交.*条/ })).not.toBeInTheDocument();
  });

  // Ruling C4: ThreadCard 只在选中时渲染 ping/pong 详情，所以要带 threadId 渲染。
  it("评论卡片标出各自的版本号与落后多少版", async () => {
    renderPage({ threadId: "th-answered" });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).getAllByText(/^v\d+$/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/基于 v0 · 已过 2 版/).length).toBeGreaterThan(0);
  });

  // Ruling C4: 同上，纯 pong 详情只在选中该 thread 时渲染。
  it("纯 pong 用中性色且不显示版本号", async () => {
    renderPage({ threadId: "th-plain-pong" });
    const panel = await screen.findByRole("complementary", { name: "讨论" });
    const plain = within(panel).getByText(/指平台上一切有版本身份的创作产物/).closest(".pong-card")!;

    expect(plain).toHaveClass("pong-plain");
    expect(within(plain as HTMLElement).queryByText(/^v\d+$/)).not.toBeInTheDocument();
  });

  // Ruling C5: 筛选导航本身就有一个标签为「已回复」的按钮，所以不能断言该文本整体消失；
  // 改为断言面板里不再有任何已回复状态的卡片（class status-answered）。
  it("筛选只看待回复", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: "待回复" }));

    expect(panel.querySelector(".status-answered")).not.toBeInTheDocument();
  });

  it("点一处会把它写进 hash，供定位链接使用", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: /这一句还能再收紧吗？/ }));

    expect(window.location.hash).toBe("#/d/doc-sample/th-open");
  });

  it("文档还没有 current version 时给初始化空态", async () => {
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: createMemoryTransport({ seed: { documents: [{ documentId: "doc-new", name: "新作品", versions: [], threads: [] }] } }),
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-new" /></ClientProvider>);

    expect(await screen.findByText("这件作品还在初始化，暂时没有可读的版本。")).toBeInTheDocument();
  });
});
