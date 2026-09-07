import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsView } from "../src/ui/views/workspace-documents.js";
import { ApiError, createDocument, documentStatus, downloadDocument, listDocuments, type GatewayDocumentRecord } from "../src/ui/api.js";
import { loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";
import { CREATION_TRACKING_KEY } from "../src/ui/creation-tracking.js";

vi.mock("../src/ui/config.js", () => ({ DEFAULT_DOC_TYPES: ["markdown", "psd", "docx"] }));
vi.mock("../src/ui/api.js", async original => ({ ...await original<typeof import("../src/ui/api.js")>(), listDocuments: vi.fn(), createDocument: vi.fn(), documentStatus: vi.fn(), downloadDocument: vi.fn() }));
const record = (type: string, id: string, updated: number): GatewayDocumentRecord => ({ doc_id: id, doc_type: type, owner_id: "alice", version: 2, created_at: 1000, updated_at: updated });
const markdown = record("markdown", "alpha-note", 2000);
const psd = record("psd", "beta-image", 3000);
const docx = record("docx", "gamma-document", 1000);
beforeEach(() => {
  sessionStorage.clear();
  accessTokenSession("alice");
  vi.mocked(listDocuments).mockReset().mockImplementation(async (_tenant, type) => ({ markdown: [markdown], psd: [psd], docx: [docx] })[type] ?? []);
  vi.mocked(createDocument).mockReset(); vi.mocked(documentStatus).mockReset(); vi.mocked(downloadDocument).mockReset();
});
const mount = () => render(<DocumentsView session={loadSession()!} onSignedOut={vi.fn()} />);

describe("unified cloud workspace", () => {
  it("restores pending creation after remount without resubmitting and removes completed tracking", async () => {
    const user = userEvent.setup(); const view = mount(); await screen.findByRole("table");
    vi.mocked(createDocument).mockResolvedValue({ success: true, docId: "restore-pending", state: "creating" });
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByRole("region", { name: "创建状态 restore-pending" });
    expect(sessionStorage.getItem(CREATION_TRACKING_KEY)).toContain("restore-pending");
    view.unmount();
    const restored = mount();
    const region = screen.getByRole("region", { name: "创建状态 restore-pending" });
    expect(documentStatus).not.toHaveBeenCalled(); expect(createDocument).toHaveBeenCalledTimes(1);
    vi.mocked(documentStatus).mockResolvedValue({ doc_id: "restore-pending", doc_type: "markdown", state: "ready", version: 1 });
    await user.click(within(region).getByRole("button", { name: "检查创建状态" }));
    await within(region).findByRole("link", { name: "打开预览" });
    restored.unmount(); mount();
    await screen.findByRole("table");
    expect(screen.queryByRole("region", { name: "创建状态 restore-pending" })).not.toBeInTheDocument();
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful creation tracked in memory when persistence fails, without reuploading", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    const original = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === CREATION_TRACKING_KEY) throw new Error("Storage full");
      original.call(this, key, value);
    });
    try {
      vi.mocked(createDocument).mockResolvedValue({ success: true, docId: "in-memory", state: "creating" });
      await user.click(screen.getByRole("button", { name: "新建作品" }));
      await user.click(screen.getByRole("button", { name: "创建" }));
      expect(await screen.findByRole("region", { name: "创建状态 in-memory" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("创建跟踪尚未保存");
      expect(createDocument).toHaveBeenCalledTimes(1);
    } finally { failure.mockRestore(); }
    await user.click(screen.getByRole("button", { name: "重试保存跟踪" }));
    expect(sessionStorage.getItem(CREATION_TRACKING_KEY)).toContain("in-memory");
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("tracks a pending create through status checks without submitting another create", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    vi.mocked(createDocument).mockResolvedValue({ success: true, docId: "processing", state: "creating" });
    vi.mocked(documentStatus).mockResolvedValueOnce({ doc_id: "processing", doc_type: "markdown", state: "creating", version: null })
      .mockResolvedValueOnce({ doc_id: "processing", doc_type: "markdown", state: "ready", version: 1 });
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.click(screen.getByRole("button", { name: "创建" }));
    const region = await screen.findByRole("region", { name: "创建状态 processing" });
    expect(documentStatus).not.toHaveBeenCalled();
    await user.click(within(region).getByRole("button", { name: "检查创建状态" }));
    expect(within(region).queryByRole("link")).not.toBeInTheDocument();
    await user.click(within(region).getByRole("button", { name: "检查创建状态" }));
    expect(await within(region).findByRole("link", { name: "打开预览" })).toHaveAttribute("href", "#/preview/markdown/processing");
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(documentStatus).toHaveBeenCalledTimes(2);
  });

  it("allows a new file after a definite upload rejection", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.click(screen.getByRole("radio", { name: "导入文件" }));
    await user.upload(screen.getByLabelText("选择文件 · 最大 32 MiB"), new File(["large"], "notes.md"));
    vi.mocked(createDocument).mockRejectedValue(new ApiError(413, "Upload limit"));
    await user.click(screen.getByRole("button", { name: "导入为新作品" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("重新选择文件");
    expect(screen.getByLabelText("选择文件 · 最大 32 MiB")).toBeEnabled();
    expect(screen.getByRole("button", { name: "导入为新作品" })).toBeDisabled();
  });

  it("selects a file without uploading until confirmed, then offers the ready preview", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.click(screen.getByRole("radio", { name: "导入文件" }));
    const file = new File(["# Real content"], "notes.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("选择文件 · 最大 32 MiB"), file);
    expect(createDocument).not.toHaveBeenCalled();
    vi.mocked(createDocument).mockResolvedValue({ success: true, docId: "import-ready", state: "ready", version: 1 });
    await user.click(screen.getByRole("button", { name: "导入为新作品" }));
    expect(await screen.findByRole("link", { name: "打开预览" })).toHaveAttribute("href", "#/preview/markdown/import-ready");
    expect(createDocument).toHaveBeenCalledWith("alice", "markdown", { file, requestId: expect.any(String) });
  });

  it("retains the file and idempotency key after network failure", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.click(screen.getByRole("radio", { name: "导入文件" }));
    await user.selectOptions(screen.getByLabelText("内容类型"), "psd");
    const file = new File(["psd fixture"], "cover.psd");
    await user.upload(screen.getByLabelText("选择文件 · 最大 32 MiB"), file);
    vi.mocked(createDocument).mockRejectedValueOnce(new Error("Network failed"))
      .mockResolvedValueOnce({ success: true, docId: "import-pending", state: "creating" });
    await user.click(screen.getByRole("button", { name: "导入为新作品" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保留文件和请求标识");
    expect(screen.getByLabelText("内容类型")).toBeDisabled();
    const firstOptions = vi.mocked(createDocument).mock.calls[0]![2];
    await user.click(screen.getByRole("button", { name: "重试导入" }));
    expect(vi.mocked(createDocument).mock.calls[1]![2]).toEqual(firstOptions);
    expect(await screen.findByText(/正在创建 PSD · import-pending/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开预览" })).not.toBeInTheDocument();
  });

  it("mixes types in one metadata list, sorts timestamps and combines ID and type filters", async () => {
    const user = userEvent.setup(); mount();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row").slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining("beta-image"), expect.stringContaining("alpha-note"), expect.stringContaining("gamma-document"),
    ]);
    await user.selectOptions(screen.getByLabelText("按类型筛选"), "markdown");
    expect(screen.queryByText("beta-image")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索作品 ID"), "NO-MATCH");
    expect(screen.getByText("没有匹配的作品")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    await user.selectOptions(screen.getByLabelText("作品排序"), "id");
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("alpha-note");
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(createDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "打开 beta-image" })).toHaveAttribute("href", "#/preview/psd/beta-image");
    expect(screen.queryByRole("link", { name: "打开 gamma-document" })).not.toBeInTheDocument();
  });

  it("opens one create entry, cancels without writing, then creates the selected type once", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(createDocument).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    await user.selectOptions(screen.getByLabelText("内容类型"), "psd");
    vi.mocked(createDocument).mockResolvedValue({ success: true, docId: "new-psd", state: "creating" });
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/正在创建 PSD · new-psd/)).not.toHaveTextContent("undefined");
    expect(createDocument).toHaveBeenCalledExactlyOnceWith("alice", "psd");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores repeated submission while creation is in flight", async () => {
    let finish!: (value: { success: boolean; docId: string; state: string; version: number }) => void;
    vi.mocked(createDocument).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup(); mount(); await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "新建作品" }));
    const form = screen.getByRole("dialog").querySelector("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "创建中…" })).toBeDisabled();
    finish({ success: true, docId: "created", state: "ready", version: 1 });
    expect(await screen.findByText(/已创建 Markdown · created · v1/)).toBeInTheDocument();
  });

  it("keeps successful types visible when one directory fails and retries on refresh", async () => {
    vi.mocked(listDocuments).mockImplementation(async (_tenant, type) => { if (type === "psd") throw new Error("Unavailable"); return type === "markdown" ? [markdown] : []; });
    const user = userEvent.setup(); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("PSD 目录加载失败");
    expect(screen.getByText("alpha-note")).toBeInTheDocument();
    vi.mocked(listDocuments).mockImplementation(async (_tenant, type) => type === "psd" ? [psd] : []);
    await user.click(screen.getByRole("button", { name: "刷新作品列表" }));
    expect(await screen.findByText("beta-image")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not display partial data after an authentication failure", async () => {
    vi.mocked(listDocuments).mockImplementation(async (_tenant, type) => { if (type === "psd") throw new ApiError(401, "Expired"); return [markdown]; });
    const signedOut = vi.fn(); render(<DocumentsView session={loadSession()!} onSignedOut={signedOut} />);
    await waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("alpha-note")).not.toBeInTheDocument();
  });

  it("aborts requests on unmount and ignores their late results", async () => {
    let finish!: (rows: GatewayDocumentRecord[]) => void;
    vi.mocked(listDocuments).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = mount(); const signal = vi.mocked(listDocuments).mock.calls[0]![2]!;
    view.unmount(); expect(signal.aborted).toBe(true); finish([markdown]);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});