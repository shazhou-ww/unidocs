import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  createMemoryTransport, createTenantPortalClient, sampleSeed, type PlatformTransport,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function renderPage(props: { threadId?: string; commentIdx?: number } = {}) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client}>
      <DocumentPage documentId="doc-sample" threadId={props.threadId} commentIdx={props.commentIdx} />
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

  // Ruling C4: ThreadCard 只在选中时渲染评论/回复详情，所以要带 threadId 渲染。
  it("评论卡片标出各自的版本号与落后多少版", async () => {
    renderPage({ threadId: "th-answered" });
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).getAllByText(/^v\d+$/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/基于 v0 · 已过 2 版/).length).toBeGreaterThan(0);
  });

  // Ruling C4: 同上，纯回复详情只在选中该 thread 时渲染。
  it("纯回复用中性色且不显示版本号", async () => {
    renderPage({ threadId: "th-plain-reply" });
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

  // Task 13 起，thread-card 的切换按钮用 aria-label（「待回复的讨论 · 展开/折叠」）覆盖了
  // 可访问名，为的是和展开后内层 CommentCard 里同样文字的按钮不撞车——所以这里改成按可见摘要
  // 文字定位再取其按钮祖先，而不是按可访问名匹配评论原文；点击目标和断言结果都没变。
  it("点一处会把它写进 hash，供定位链接使用", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByText("这一句还能再收紧吗？").closest("button")!);

    expect(window.location.hash).toBe("#/d/doc-sample/th-open");
  });

  // 问题 E：send() 在发送成功后总会调一次 session.reload()。假后端从不让读失败，
  // 这条路径此前一直没被测到——use-document.ts 的 catch 分支把 document 直接置 null，
  // 而 document.tsx 的早退只看 document 是否为 null，于是一次紧跟在成功发送后面的、
  // 纯粹是网络抖了一下的读失败，会把整块面板、分屏、正在开着的输入框全部闪没。
  it("发送成功后紧跟的一次刷新读失败时，保留已有内容，只多一条不影响阅读的错误提示", async () => {
    let failReads = false;
    const inner = createMemoryTransport({ seed: sampleSeed() });
    const transport: PlatformTransport = async (request) => {
      if (failReads && request.method === "GET") {
        return { ok: false, error: { error: { code: "transport_failure", message: "网络不通", requestId: "r1" } } };
      }
      return inner(request);
    };
    const client = createTenantPortalClient({ tenantId: "t1", transport });
    render(
      <ClientProvider client={client}>
        <DocumentPage documentId="doc-sample" threadId="th-open" />
      </ClientProvider>,
    );
    const p = await screen.findByRole("complementary", { name: "讨论" });
    // 先确认真的加载成功过一次——有旧内容可留。th-open 被选中时展开的评论卡片和折叠
    // 摘要里都有这段原文，用 getAllByText 而不是 getByText，免得两处匹配互相打架。
    await waitFor(() => expect(within(p).getAllByText("这一句还能再收紧吗？").length).toBeGreaterThan(0));

    // 发送这一条本身（POST）必须成功；只有它之后紧跟着的 reload()（GET）失败。
    failReads = true;
    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "触发一次刷新");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    // 旧内容（面板、讨论摘要、只读徽标）仍然画在页面上，没有被整页早退换掉。
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("刷新失败"));
    expect(screen.getByText("只读 · 内容由 Agent 编辑")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "讨论" })).toBeInTheDocument();
    expect(within(p).getAllByText("这一句还能再收紧吗？").length).toBeGreaterThan(0);
  });

  // 设计文档 §5.4：首版本产生前不能创建 thread 或追加 comment——use-document.ts
  // 对这种文档返回 currentVersion: null，页面要据此显示「等待 Operator 初始化」，
  // 并且不能出现任何真能点的评论入口（点了也只会打出一个注定 404 的请求）。
  it("文档还没有 current version 时显示「等待 Operator 初始化」，且没有可用的评论入口", async () => {
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: createMemoryTransport({ seed: { documents: [{ documentId: "doc-new", name: "新作品", versions: [], threads: [] }] } }),
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-new" /></ClientProvider>);

    expect(await screen.findByText(/等待 Operator 初始化/)).toBeInTheDocument();

    const panel = await screen.findByRole("complementary", { name: "讨论" });
    // 唯一两个能发起 createThread/appendComment 的入口：ThreadCard 的「回复」
    // （没有 thread 可回复）和 ViewHost 选区触发的「添加评论」（currentVersion
    // 为 null 时右栏根本不挂载带 host 的 ViewHost，见 document.tsx）。
    expect(within(panel).queryByRole("button", { name: "回复" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "添加评论" })).not.toBeInTheDocument();
    expect(within(panel).queryByText(/在正文里选中一段内容即可添加评论/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前版本" })).not.toBeInTheDocument();
  });
});
