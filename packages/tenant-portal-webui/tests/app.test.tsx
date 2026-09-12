import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { createTenantPortalClient, createMemoryTransport, sampleSeed } from "@unidocs/tenant-portal-client";

function renderApp() {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(<App client={client} />);
}

describe("App", () => {
  it("渲染品牌与工作台标题", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "我的作品" })).toBeInTheDocument();
  });

  it("窄屏提示页始终在 DOM 里，由 CSS 控制显隐", () => {
    renderApp();
    expect(screen.getByText("请在电脑或平板上查看")).toBeInTheDocument();
  });

  it("界面上没有任何编辑内容的入口", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "我的作品" });

    expect(screen.queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /提交.*反馈/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
