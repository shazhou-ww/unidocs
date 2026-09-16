import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { PublicDocumentType } from "@unidocs/protocol-tenant-portal";
import {
  createMemoryStore, createMemoryTransport, createTenantPortalClient, sampleSeed,
  type PlatformRequest, type PlatformResponse, type PlatformTransport,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { WorkbenchPage } from "../src/pages/workbench.js";
import { TEST_DRAFT_SCOPE } from "./draft-scope.js";

function renderPage() {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(<ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
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

  it("搜索忽略大小写，无结果时可以清除筛选", async () => {
    renderPage();
    await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ });
    const search = screen.getByRole("searchbox", { name: "搜索作品" });
    await userEvent.type(search, "unidocs");
    expect(within(grid()).getByRole("link", { name: /UniDocs · 产品构想/ })).toBeInTheDocument();
    await userEvent.type(search, "nonexistent");
    expect(screen.getByText("没有匹配的作品")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(2);
  });

  it("标题排序与网格、列表视图切换作用于同一作品集合", async () => {
    renderPage();
    await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "作品排序" }), "title");
    const titles = within(grid()).getAllByRole("heading").map((heading) => heading.textContent!);
    expect(titles).toEqual([...titles].sort((left, right) => left.localeCompare(right, "zh-CN")));
    await userEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(grid()).toHaveClass("list");
    expect(screen.getByRole("button", { name: "列表视图" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "网格视图" }));
    expect(grid()).not.toHaveClass("list");
    expect(within(grid()).getAllByRole("link")).toHaveLength(2);
  });

  it("列表为空时给空态而不是伪造样例", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: { documents: [] } }) });
    render(<ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);

    expect(await screen.findByText("还没有作品")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("类型筛选使用真实类型，未知类型仍能显示和筛选", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: { documents: [
      { documentId: "first", documentType: "dt-markdown", name: "文稿", versions: [], threads: [] },
      { documentId: "second", documentType: "dt-psd", name: "海报", versions: [], threads: [] },
    ] } }) });
    render(<ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
    await within(grid()).findByRole("link", { name: /海报/ });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按类型筛选" }), "dt-psd");
    expect(within(grid()).getAllByRole("link")).toHaveLength(1);
    expect(within(grid()).getByRole("link", { name: /海报/ })).toBeInTheDocument();
    expect(within(grid()).queryByRole("link", { name: /文稿/ })).not.toBeInTheDocument();
  });

  it("加载失败可以重试，不显示假数据", async () => {
    const inner = createMemoryTransport({ seed: sampleSeed() });
    let failNext = true;
    const transport: PlatformTransport = (request) => {
      if (failNext && request.path.endsWith("/documents")) {
        failNext = false;
        return Promise.resolve({ ok: false, error: { error: { code: "transport_failure", message: "offline", requestId: "r" } } });
      }
      return inner(request);
    };
    const client = createTenantPortalClient({ tenantId: "t1", transport });
    render(<ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("网络不通");
    expect(within(grid()).queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新加载作品" }));
    expect(await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("作品列表遍历全部分页后再排序和计数", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
    const documents = await client.listDocuments();
    const cursors: (string | undefined)[] = [];
    const paginated = { ...client, listDocuments: async (query: { cursor?: string } = {}) => {
      cursors.push(query.cursor);
      return query.cursor === undefined
        ? { items: [documents.items[0]], nextCursor: "second-page" }
        : { items: [documents.items[1]], nextCursor: null };
    } };
    render(<ClientProvider client={paginated} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
    await within(grid()).findByRole("link", { name: /UniDocs · 产品构想/ });
    expect(within(grid()).getAllByRole("link")).toHaveLength(2);
    expect(cursors).toEqual([undefined, "second-page"]);
    expect(screen.getByText("2 件作品")).toBeInTheDocument();
  });
});

function documentType(documentType: string, locales: Record<string, string>): PublicDocumentType {
  return {
    documentType,
    typeCardBundleId: `tcb-${documentType}`,
    typeCard: {
      locales: Object.fromEntries(Object.entries(locales)
        .map(([tag, name]) => [tag, { name, description: "", sampleThumbnailAlt: name }])) as PublicDocumentType["typeCard"]["locales"],
      icon: { kind: "svg", url: "https://bundles.example/icon.svg" },
      sampleThumbnailUrl: "https://bundles.example/sample.webp",
    },
    viewBundleId: `vb-${documentType}`,
    availableDocumentContractIdxs: [0],
  };
}

/**
 * 记录每次 createDocument 请求；hold 为真时 POST 挂起，直到测试调用 release，
 * 好观察「提交中」的界面。failNext 让下一次 POST 失败一次。
 */
function creationHarness(documentTypes: readonly PublicDocumentType[]) {
  const store = createMemoryStore({ documents: [], documentTypes });
  const inner = createMemoryTransport({ store });
  const creations: PlatformRequest[] = [];
  const control = { hold: false, failNext: false, release: () => {} };
  const transport: PlatformTransport = async (request) => {
    if (request.method !== "POST" || !request.path.endsWith("/documents")) return inner(request);
    creations.push(request);
    if (control.hold) await new Promise<void>((resolve) => { control.release = resolve; });
    if (control.failNext) {
      control.failNext = false;
      return { ok: false, error: { error: { code: "limit_exceeded", message: "slow down", requestId: "r1" } } } satisfies PlatformResponse;
    }
    return inner(request);
  };
  const client = createTenantPortalClient({ tenantId: "t1", transport });
  render(<ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
  return { store, creations, control };
}

const MARKDOWN = documentType("dt-markdown", { en: "Markdown", zh: "Markdown 文稿" });

async function openCreateForm() {
  await userEvent.click(await screen.findByRole("button", { name: "新建文档" }));
  return screen.findByRole("form", { name: "新建文档" });
}

describe("WorkbenchPage 新建文档", () => {
  beforeEach(() => { window.location.hash = ""; });

  it("填名称提交 → createDocument 以非空 key 调一次，跳到新文档", async () => {
    const { store, creations } = creationHarness([MARKDOWN]);
    const form = await openCreateForm();

    // 只有一个类型时默认选中。
    const select = within(form).getByRole("combobox", { name: "文档类型" });
    await waitFor(() => expect(select).toHaveValue("dt-markdown"));

    await userEvent.type(within(form).getByRole("textbox", { name: "名称" }), "我的新文档");
    await userEvent.click(within(form).getByRole("button", { name: "创建" }));

    await waitFor(() => expect(window.location.hash).not.toBe(""));
    expect(creations).toHaveLength(1);
    expect(creations[0].idempotencyKey).toMatch(/\S/);
    expect(creations[0].body).toEqual({ documentType: "dt-markdown", name: "我的新文档" });
    const [created] = store.listDocuments();
    expect(created.name).toBe("我的新文档");
    expect(window.location.hash).toBe(`#/d/${created.documentId}`);
  });

  it("类型显示名取 typeCard.locales 的 zh → en → 第一个键；多个类型时不替用户选", async () => {
    creationHarness([
      MARKDOWN,
      documentType("dt-sheet", { en: "Sheet" }),
      // schema 要求有 en，但显示逻辑不应依赖它：测第三级回退。
      documentType("dt-deck", { ja: "スライド" }),
    ]);
    const form = await openCreateForm();
    const select = within(form).getByRole("combobox", { name: "文档类型" });

    expect(await within(select).findByRole("option", { name: "Markdown 文稿" })).toHaveValue("dt-markdown");
    expect(within(select).getByRole("option", { name: "Sheet" })).toHaveValue("dt-sheet");
    expect(within(select).getByRole("option", { name: "スライド" })).toHaveValue("dt-deck");
    expect(select).toHaveValue("");

    await userEvent.type(within(form).getByRole("textbox", { name: "名称" }), "未选类型");
    expect(within(form).getByRole("button", { name: "创建" })).toBeDisabled();
  });

  it("提交中按钮禁用；失败给中文说明，重试沿用同一个 idempotency key", async () => {
    const { creations, control } = creationHarness([MARKDOWN]);
    const form = await openCreateForm();
    await waitFor(() => expect(within(form).getByRole("combobox", { name: "文档类型" })).toHaveValue("dt-markdown"));
    await userEvent.type(within(form).getByRole("textbox", { name: "名称" }), "重试的文档");

    control.hold = true;
    control.failNext = true;
    const submit = within(form).getByRole("button", { name: "创建" });
    await userEvent.click(submit);
    await waitFor(() => expect(creations).toHaveLength(1));
    expect(submit).toBeDisabled();
    // 禁用期间再点也不会发第二次。
    await userEvent.click(submit);
    expect(creations).toHaveLength(1);

    control.hold = false;
    control.release();
    expect(await within(form).findByRole("alert")).toHaveTextContent("操作太频繁，请稍后再试。");
    expect(submit).toBeEnabled();
    expect(window.location.hash).toBe("");

    await userEvent.click(submit);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/d\//));
    expect(creations).toHaveLength(2);
    expect(creations[1].idempotencyKey).toBe(creations[0].idempotencyKey);
  });

  it("失败后改了名称再提交是另一次创建，换新 key（同 key 不同内容会被服务端判为冲突）", async () => {
    const { creations, control } = creationHarness([MARKDOWN]);
    const form = await openCreateForm();
    await waitFor(() => expect(within(form).getByRole("combobox", { name: "文档类型" })).toHaveValue("dt-markdown"));
    const name = within(form).getByRole("textbox", { name: "名称" });
    await userEvent.type(name, "初稿");

    control.failNext = true;
    await userEvent.click(within(form).getByRole("button", { name: "创建" }));
    await within(form).findByRole("alert");

    await userEvent.type(name, "二");
    await userEvent.click(within(form).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/d\//));
    expect(creations).toHaveLength(2);
    expect(creations[1].idempotencyKey).not.toBe(creations[0].idempotencyKey);
  });

  it("类型列表读不到时给出错误说明，不能提交", async () => {
    const inner = createMemoryTransport({ seed: { documents: [] } });
    const transport: PlatformTransport = async (request) => request.path.endsWith("/document-types")
      ? { ok: false, error: { error: { code: "transport_failure", message: "offline", requestId: "r" } } }
      : inner(request);
    render(<ClientProvider client={createTenantPortalClient({ tenantId: "t1", transport })} draftScope={TEST_DRAFT_SCOPE}><WorkbenchPage /></ClientProvider>);
    const form = await openCreateForm();

    expect(await within(form).findByRole("alert")).toHaveTextContent("网络不通，请检查连接后重试。");
    expect(within(form).getByRole("button", { name: "创建" })).toBeDisabled();
  });
});
