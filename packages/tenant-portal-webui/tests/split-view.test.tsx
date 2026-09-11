import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function renderAt(threadId: string, pingIdx?: number) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client}>
      <DocumentPage documentId="doc-sample" threadId={threadId} pingIdx={pingIdx} />
    </ClientProvider>,
  );
}

const base = () => screen.findByRole("region", { name: "评论所基于的版本" });
const current = () => screen.getByRole("region", { name: "当前版本" });

describe("分屏对照", () => {
  it("选中一处后出现左右两栏与讨论面板", async () => {
    renderAt("th-answered");

    expect(await base()).toBeInTheDocument();
    expect(current()).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "讨论" })).toBeInTheDocument();
  });

  it("左栏渲染该 ping 的基版，不是 current", async () => {
    renderAt("th-answered");
    const pane = await base();

    expect(within(pane).getByText(/引用固定到明确版本，源作品更新时提示。/)).toBeInTheDocument();
    expect(within(pane).queryByText(/由人主动切换/)).not.toBeInTheDocument();
  });

  it("左栏带只读徽标与基版版本号", async () => {
    renderAt("th-answered");
    const wrapper = (await base()).closest(".pane-wrapper")!;

    expect(within(wrapper as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
  });

  it("有 pong 时右栏金色高亮结果位置", async () => {
    renderAt("th-answered");
    await base();

    expect(current().querySelector(".marker-pong-result")).not.toBeNull();
  });

  it("ping 就写在 current 上时右栏标暂无改动且不重复高亮", async () => {
    renderAt("th-on-current");
    await base();

    expect(screen.getByText("暂无改动 · 与左栏同一版本")).toBeInTheDocument();
    expect(current().querySelector(".marker-pong-result")).toBeNull();
    expect(current().querySelector(".marker-stale-ping")).toBeNull();
  });

  it("基于旧版本、内容仍在时右栏灰底虚线并说明这不是 Agent 的改动", async () => {
    renderAt("th-stale-present");
    await base();

    expect(current().querySelector(".marker-stale-ping")).not.toBeNull();
    expect(screen.getByText(/这不是 Agent 的改动/)).toBeInTheDocument();
  });

  it("基于旧版本、原文已被改写时不高亮，只给说明", async () => {
    renderAt("th-stale-rewritten");
    await base();

    expect(current().querySelector(".marker-stale-ping")).toBeNull();
    expect(screen.getByText(/这段内容已经不在当前版本里/)).toBeInTheDocument();
  });

  it("说明文案指出常见成因是 Agent 处理别处评论时顺带改的", async () => {
    renderAt("th-stale-rewritten");
    await base();

    expect(screen.getByText(/处理别的一处评论时顺带改动/)).toBeInTheDocument();
  });

  it("点具体某一条评论，左栏切到那条的基版", async () => {
    renderAt("th-answered");
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: /这里要说清楚谁来切换/ }));

    expect(window.location.hash).toBe("#/d/doc-sample/th-answered/0");
  });

  it("pingIdx 指定时左栏用那一条的基版", async () => {
    renderAt("th-answered", 0);
    const wrapper = (await base()).closest(".pane-wrapper")!;

    expect(within(wrapper as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
  });
});
