import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  createMemoryTransport,
  createTenantPortalClient,
  sampleSeed,
  type PlatformTransport,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";
import { TEST_DRAFT_SCOPE } from "./draft-scope.js";

function renderAt(threadId: string, commentIdx?: number) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}>
      <DocumentPage documentId="doc-sample" threadId={threadId} commentIdx={commentIdx} />
    </ClientProvider>,
  );
}

/**
 * 包一层 transport：freeze() 之前原样转发；freeze() 之后，任何对 `/versions/...` 的 GET
 * 永远不 resolve。用来在测试里把 DocumentPage 的 baseVersion 状态钉死在某个值上——
 * 不是等一个可能被 JS 引擎调度细节吃掉的窄时间窗，而是让「新基版一直没拉回来」这个
 * 状态本身变成确定的、可以随便等多久去断言的稳定态。
 */
function freezableTransport(real: PlatformTransport): { transport: PlatformTransport; freeze(): void } {
  let frozen = false;
  const transport: PlatformTransport = (request) => {
    if (frozen && request.method === "GET" && request.path.includes("/versions/")) {
      return new Promise(() => { /* 故意永远不 resolve */ });
    }
    return real(request);
  };
  return { transport, freeze: () => { frozen = true; } };
}

const base = () => screen.findByRole("region", { name: "评论所基于的版本" });
const current = () => screen.getByRole("region", { name: "当前版本" });

describe("分屏对照", () => {
  it("选中一处后出现左右两栏与讨论面板", async () => {
    renderAt("th-answered");

    const pane = await base();
    expect(pane).toBeInTheDocument();
    expect(current()).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "讨论" })).toBeInTheDocument();

    // 三种 role 里，marker-pong-result 和 marker-stale-ping 各有专门的用例覆盖；
    // marker-ping 只在左栏出现，且恰好是 markdown-view.ts 里 `marker.role ?? "ping"`
    // 的兜底值，之前没有测试单独钉住它——这里补上，确认左栏的评论高亮确实用的是
    // "ping" 这个 role（role 本身不随协议改名，见 model/compare.ts 的注释），
    // 而不是巧合地落在某个默认样式上。
    //
    // await base() 只等到 pane 这个 <div role="region"> 元素本身挂载，不等 ViewHost 的
    // initialize/loadSnapshot/setMarkers 异步链跑完——marker 是那条链的最后一步才画出来的。
    // 之前这里紧接着同步查询，能过是因为 RTL 的 act 包裹恰好把微任务队列冲平了，不是
    // 有意同步这两者；一个实现者报告过大约 1/6 概率失败。改成 waitFor 关掉这个窗口。
    await waitFor(() => {
      expect(pane.querySelector(".marker-ping")).not.toBeNull();
    });
  });

  it("左栏渲染该评论的基版，不是 current", async () => {
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

  it("有回复时右栏金色高亮结果位置", async () => {
    renderAt("th-answered");
    await base();

    // 同上：右栏的 marker 也是 ViewHost 异步链跑完才出现的，不能紧跟 await base() 同步查询。
    await waitFor(() => {
      expect(current().querySelector(".marker-pong-result")).not.toBeNull();
    });
  });

  it("评论就写在 current 上时右栏标暂无改动且不重复高亮", async () => {
    renderAt("th-on-current");
    const pane = await base();

    expect(screen.getByText("暂无改动 · 与左栏同一版本")).toBeInTheDocument();

    // decideRightPane 对 same-version 情形无条件返回空 markers（见 compare.test.ts
    // 「评论就写在 current 上时不重复高亮」），所以下面两条 toBeNull 断言在异步链跑完
    // 之前、之后都成立——不管实现对不对都不会失败，是两条测不出问题的断言。改法：
    // 先等左栏的 marker-ping 出现——th-on-current 的评论带着位置锚点，左栏一定会画
    // 出这个 marker，用它确认 ViewHost 的 initialize/loadSnapshot/setMarkers 那条链
    // 这一轮已经跑完——这时候再断言右栏没有 marker，才是真的在检查「same-version 情形
    // 下右栏没有被错误地下发 marker」，而不是巧合地测在了链跑完之前。
    await waitFor(() => {
      expect(pane.querySelector(".marker-ping")).not.toBeNull();
    });
    expect(current().querySelector(".marker-pong-result")).toBeNull();
    expect(current().querySelector(".marker-stale-ping")).toBeNull();
  });

  it("基于旧版本、内容仍在时右栏灰底虚线并说明这不是 Agent 的改动", async () => {
    renderAt("th-stale-present");
    await base();

    await waitFor(() => {
      expect(current().querySelector(".marker-stale-ping")).not.toBeNull();
    });
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

  it("commentIdx 指定时左栏用那一条的基版", async () => {
    renderAt("th-answered", 0);
    const wrapper = (await base()).closest(".pane-wrapper")!;

    expect(within(wrapper as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
  });

  it("跨版本切换评论时，新基版一直没追上前左栏不会把新位置套在旧版本正文上", async () => {
    // th-stale-present 的评论基于 v0；th-open 的评论基于 v2。故意挑这一对，是因为
    // th-open 的锚点原文「平台让人和外部 Agent 共同创作数字作品。」从 V0 到 V2 逐字未改、
    // 偏移也一样——如果 leftMarkers 没等 baseVersion 对齐就把它套到还停在 v0 的正文上，
    // 这段文字在 v0 里同样能被找到并高亮，bug 会真的显形，而不是像别的评论对那样因为
    // 锚点文字对不上而悄悄找不到、看不出区别。
    const real = createMemoryTransport({ seed: sampleSeed() });
    const { transport, freeze } = freezableTransport(real);
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    const { rerender } = render(
      <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}>
        <DocumentPage documentId="doc-sample" threadId="th-stale-present" />
      </ClientProvider>,
    );

    const firstWrapper = (await base()).closest(".pane-wrapper") as HTMLElement;
    expect(within(firstWrapper).getByText("基版 v0 · 只读")).toBeInTheDocument();

    // 冻结之后，任何 getVersion/getVersionSnapshot 请求都不会 resolve——base 从此永远停在 v0。
    // 这不是在赌一个可能被跳过的窄时间窗：不管等多久、poll 多少轮，v0 都不会变成 v2，
    // 所以下面的断言可以放心用 waitFor 等到底，而不用去猜某个精确的微任务时刻。
    freeze();
    rerender(
      <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}>
        <DocumentPage documentId="doc-sample" threadId="th-open" />
      </ClientProvider>,
    );

    const pane = screen.getByRole("region", { name: "评论所基于的版本" });

    // 分屏结构本身不应该在切换、甚至在新基版迟迟不来的时候被收起——收起会导致布局跳动；
    // split 只看 comment/base 是否非空，不看两者是否已经对齐。
    expect(pane.closest(".pane-wrapper")).not.toBeNull();

    // 给 ViewHost 自己的异步链（initialize/loadSnapshot/setMarkers）充分时间把 leftMarkers
    // 应用完——因为 leftMarkers 应该在 baseReady 为 false 期间恒为空数组，所以无论等多久，
    // th-open 的锚点文字都不应该被高亮，pane-label 也应该始终还停在 v0。
    await waitFor(() => {
      expect(pane.querySelector(".marker-ping")).toBeNull();
    });
    expect(within(pane.closest(".pane-wrapper") as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
    expect(within(pane).queryByText("平台让人和外部 Agent 共同创作数字作品。")?.closest("mark")).toBeNull();
    // 正文本身仍然是 v0 的，没有被悄悄换成别的版本。
    expect(within(pane).getByText(/这一段写得很绕，回头要换掉。/)).toBeInTheDocument();
  });
});
