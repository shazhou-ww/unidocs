import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { WorkbenchPage } from "../src/pages/workbench.js";

function renderPage() {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(<ClientProvider client={client}><WorkbenchPage /></ClientProvider>);
}

// 作品卡片的链接与「Agent 最新回复」条里的链接都以文档名作为可见文字——这是设计要的
// （见 aria-label 的裁决）。所以针对卡片的查询一律限定到作品列表容器内，不在整页里碰运气。
function grid() {
  return screen.getByRole("list", { name: "作品" });
}

describe("WorkbenchPage", () => {
  it("平铺列出作品，不按业务状态分组", async () => {
    renderPage();
    expect(await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ })).toBeInTheDocument();
    expect(within(grid()).getByRole("link", { name: /共创空间 · 发布手记/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /待审阅/ })).not.toBeInTheDocument();
  });

  it("卡片暴露讨论状态", async () => {
    renderPage();
    const card = (await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ })).closest("article")!;

    expect(within(card).getByText(/处待回复/)).toBeInTheDocument();
    expect(within(card).getByText(/Agent 已回复/)).toBeInTheDocument();
  });

  it("没有讨论的作品显示暂无讨论", async () => {
    renderPage();
    const card = (await screen.findByRole("link", { name: /共创空间 · 发布手记/ })).closest("article")!;

    expect(within(card).getByText("暂无讨论")).toBeInTheDocument();
  });

  it("顶部列出 Agent 最新回复，并说明已处理不等于已接受", async () => {
    renderPage();
    const strip = await screen.findByRole("status", { name: "Agent 最新回复" });

    expect(within(strip).getByText(/已处理.*不表示你已接受/)).toBeInTheDocument();

    // 条里的链接与作品卡片的链接可见文字相同（都是文档名），靠 aria-label 区分去向：
    // 这条应该指向具体那一处讨论，而不是整篇文档。
    const replyLink = within(strip).getByRole("link", { name: /打开 Agent 回复的这一处/ });
    expect(replyLink).toHaveAttribute("href", "#/d/doc-sample/th-plain-reply");
  });

  it("关键词筛选匹配标题", async () => {
    renderPage();
    await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ });

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索作品" }), "发布手记");

    expect(within(grid()).queryByRole("link", { name: /UniDocs · 产品构想/ })).not.toBeInTheDocument();
    expect(within(grid()).getByRole("link", { name: /共创空间 · 发布手记/ })).toBeInTheDocument();
  });

  it("卡片链接指向文档路由", async () => {
    renderPage();
    const link = await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ });

    expect(link).toHaveAttribute("href", "#/d/doc-sample");
  });

  it("列表为空时给空态而不是伪造样例", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: { documents: [] } }) });
    render(<ClientProvider client={client}><WorkbenchPage /></ClientProvider>);

    expect(await screen.findByText("还没有作品")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
