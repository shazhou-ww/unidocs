import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsView } from "../src/ui/views/workspace-documents.js";
import { ApiError, createDocument, downloadDocument, listDocuments, type GatewayDocumentRecord } from "../src/ui/api.js";
import { loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";

vi.mock("../src/ui/config.js", () => ({ DEFAULT_DOC_TYPES: ["markdown", "psd", "docx"] }));
vi.mock("../src/ui/api.js", async original => ({ ...await original<typeof import("../src/ui/api.js")>(), listDocuments: vi.fn(), createDocument: vi.fn(), downloadDocument: vi.fn() }));
const record = (type: string, id: string, updated: number): GatewayDocumentRecord => ({ doc_id: id, doc_type: type, owner_id: "alice", version: 2, created_at: 1000, updated_at: updated });
const markdown = record("markdown", "alpha-note", 2000);
const psd = record("psd", "beta-image", 3000);
const docx = record("docx", "gamma-document", 1000);
beforeEach(() => {
  accessTokenSession("alice");
  vi.mocked(listDocuments).mockReset().mockImplementation(async (_tenant, type) => ({ markdown: [markdown], psd: [psd], docx: [docx] })[type] ?? []);
  vi.mocked(createDocument).mockReset(); vi.mocked(downloadDocument).mockReset();
});
const mount = () => render(<DocumentsView session={loadSession()!} onSignedOut={vi.fn()} />);

describe("unified cloud workspace", () => {
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