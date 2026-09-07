import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudPreview } from "../src/ui/views/cloud-preview.js";
import { ApiError, readMarkdownPreview } from "../src/ui/api.js";
import { loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";
import { markdownDraftKey, readMarkdownDraft, writeMarkdownDraft } from "../src/ui/markdown-draft.js";

const psd = vi.hoisted(() => ({ load: vi.fn(), composite: vi.fn() }));
vi.mock("../src/ui/api.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ui/api.js")>(), readMarkdownPreview: vi.fn() }));
vi.mock("@unidocs/psd-client", () => ({
  CasBlobStore: class { }, loadDoc: psd.load,
  RenderCore: class { composite() { return psd.composite(); } },
}));

beforeEach(() => { sessionStorage.clear(); accessTokenSession("alice"); vi.mocked(readMarkdownPreview).mockReset(); psd.load.mockReset(); psd.composite.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe("CloudPreview", () => {
  it("does not restore or fetch private content on the mobile placeholder", async () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({ matches: true }), writable: true });
    const read = vi.spyOn(Storage.prototype, "getItem");
    const session = loadSession()!;
    read.mockClear();
    const view = render(<CloudPreview session={session} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "请在电脑或平板上查看" })).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(readMarkdownPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    view.unmount();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined, writable: true });
  });

  it("hides both the source and rendered draft after access is denied without deleting the record", async () => {
    const user = userEvent.setup();
    const session = loadSession()!;
    const key = markdownDraftKey(session, "markdown", "document")!;
    writeMarkdownDraft(key, { content: "# Private draft", baseContent: "# Cloud", baseVersion: 1 });
    vi.mocked(readMarkdownPreview).mockResolvedValueOnce({ content: "# Cloud", version: 1 }).mockRejectedValueOnce(new ApiError(403, "Forbidden"));
    render(<CloudPreview session={session} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    await screen.findByRole("heading", { name: "Cloud" });
    await user.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    await user.click(screen.getByRole("button", { name: "刷新当前版本" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Private draft" })).not.toBeInTheDocument();
    expect(readMarkdownDraft(key)?.content).toBe("# Private draft");
  });

  it("restores a draft after remount without mistaking the new cloud head for its base", async () => {
    const user = userEvent.setup();
    const props = { session: loadSession()!, docType: "markdown", docId: "document", onSignedOut: vi.fn() };
    vi.mocked(readMarkdownPreview).mockResolvedValueOnce({ content: "# Original", version: 12 })
      .mockResolvedValueOnce({ content: "# New head", version: 15 });
    const view = render(<CloudPreview {...props} />);
    await screen.findByRole("heading", { name: "Original" });
    await user.click(screen.getByRole("button", { name: "编辑 Markdown" }));
    await user.clear(screen.getByRole("textbox"));
    await user.paste("# My draft");
    expect(screen.getByRole("status")).toHaveTextContent("草稿已暂存于当前标签页");
    view.unmount();
    render(<CloudPreview {...props} />);
    await screen.findByRole("heading", { name: "New head" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("基于 v12 · 云端已加载 v15");
    await user.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect(screen.getByRole("textbox")).toHaveValue("# My draft");
    expect(readMarkdownDraft(markdownDraftKey(props.session, "markdown", "document"))).toEqual({ content: "# My draft", baseContent: "# Original", baseVersion: 12 });
  });

  it("keeps unsaved input on quota failure, guards navigation and retries only local persistence", async () => {
    const user = userEvent.setup();
    const network = vi.spyOn(globalThis, "fetch");
    vi.mocked(readMarkdownPreview).mockResolvedValue({ content: "# Original", version: 1 });
    render(<CloudPreview session={loadSession()!} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    await screen.findByRole("heading", { name: "Original" });
    await user.click(screen.getByRole("button", { name: "编辑 Markdown" }));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await user.clear(screen.getByRole("textbox"));
    await user.paste("# Still in memory");
    expect(screen.getByRole("alert")).toHaveTextContent("暂存失败");
    expect(screen.getByRole("status")).toHaveTextContent("草稿未暂存");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("link", { name: "返回作品列表" }));
    expect(confirm).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "返回云端预览" }));
    await user.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect(screen.getByRole("textbox")).toHaveValue("# Still in memory");
    write.mockRestore();
    await user.click(screen.getByRole("button", { name: "重试暂存草稿" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("草稿已暂存于当前标签页");
    expect(network).not.toHaveBeenCalled();
  });

  it("does not expose an old identity's draft when the principal changes in the same tenant", async () => {
    const session = loadSession()!;
    writeMarkdownDraft(markdownDraftKey(session, "markdown", "document"), { content: "# Private draft", baseContent: "", baseVersion: 1 });
    vi.mocked(readMarkdownPreview).mockResolvedValue({ content: "# Cloud", version: 2 });
    const props = { docType: "markdown", docId: "document", onSignedOut: vi.fn() };
    const view = render(<CloudPreview {...props} session={session} />);
    await screen.findByRole("button", { name: "继续编辑草稿" });
    const other = { ...session, accessToken: `header.${btoa(JSON.stringify({ iss: "issuer", sub: "other" }))}.signature` };
    view.rerender(<CloudPreview {...props} session={other} />);
    await screen.findByRole("heading", { name: "Cloud" });
    expect(screen.queryByRole("button", { name: "继续编辑草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("preserves unreadable records until explicit discard and retains drafts when deletion fails", async () => {
    const user = userEvent.setup();
    const session = loadSession()!;
    const key = markdownDraftKey(session, "markdown", "document")!;
    sessionStorage.setItem(key, "broken");
    vi.mocked(readMarkdownPreview).mockResolvedValue({ content: "# Cloud", version: 2 });
    render(<CloudPreview session={session} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    await screen.findByRole("heading", { name: "Cloud" });
    expect(screen.getByRole("button", { name: "编辑 Markdown" })).toBeDisabled();
    expect(sessionStorage.getItem(key)).toBe("broken");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    await user.click(screen.getByRole("button", { name: "丢弃草稿" }));
    expect(screen.getByRole("alert")).toHaveTextContent("删除失败");
    expect(sessionStorage.getItem(key)).toBe("broken");
    remove.mockRestore();
    await user.click(screen.getByRole("button", { name: "丢弃草稿" }));
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.getByRole("button", { name: "编辑 Markdown" })).toBeEnabled();
  });

  it("keeps a separate safe draft and its base through preview, refresh and explicit discard", async () => {
    const user = userEvent.setup();
    const network = vi.spyOn(globalThis, "fetch");
    vi.mocked(readMarkdownPreview).mockResolvedValueOnce({ content: "# Original", version: 12 })
      .mockResolvedValueOnce({ content: "# Updated", version: 13 });
    render(<CloudPreview session={loadSession()!} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    await screen.findByRole("heading", { name: "Original" });
    await user.click(screen.getByRole("button", { name: "编辑 Markdown" }));
    await user.clear(screen.getByRole("textbox"));
    await user.paste('# Draft\n<script>alert(1)</script>\n![remote](https://example.com/private.png)');
    expect(screen.getByRole("heading", { name: "Draft" })).toBeInTheDocument();
    expect(screen.getByRole("article").querySelector("script, img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "返回云端预览" }));
    expect(screen.getByRole("heading", { name: "Original" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新当前版本" }));
    await screen.findByRole("heading", { name: "Updated" });
    await user.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("# Draft");
    expect(screen.getByRole("status")).toHaveTextContent("基于 v12");
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "丢弃草稿" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "丢弃草稿" }));
    expect(screen.getByRole("heading", { name: "Updated" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(network).not.toHaveBeenCalled();
  });

  it("renders the returned version read-only without creating local storage records", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(readMarkdownPreview).mockResolvedValue({ content: "# Cloud content", version: 12 });
    render(<CloudPreview session={loadSession()!} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Cloud content" })).toBeInTheDocument();
    expect(screen.getByTestId("loaded-version")).toHaveTextContent("v12");
    expect(screen.getByRole("button", { name: "编辑 Markdown" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /保存/ })).not.toBeInTheDocument();
    expect(localWrite).not.toHaveBeenCalled();
  });

  it("aborts an old document read and ignores its late response", async () => {
    let finish!: (value: { content: string; version: number }) => void;
    vi.mocked(readMarkdownPreview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ content: "# New document", version: 3 });
    const props = { session: loadSession()!, docType: "markdown", onSignedOut: vi.fn() };
    const view = render(<CloudPreview {...props} docId="old" />);
    const signal = vi.mocked(readMarkdownPreview).mock.calls[0]![2];
    view.rerender(<CloudPreview {...props} docId="new" />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByRole("heading", { name: "New document" })).toBeInTheDocument();
    finish({ content: "# Old document", version: 99 });
    await waitFor(() => expect(screen.getByTestId("loaded-version")).toHaveTextContent("v3"));
    expect(screen.queryByRole("heading", { name: "Old document" })).not.toBeInTheDocument();
  });

  it("clears content on access denial during refresh", async () => {
    vi.mocked(readMarkdownPreview).mockResolvedValueOnce({ content: "# Private", version: 1 }).mockRejectedValueOnce(new ApiError(403, "Forbidden"));
    render(<CloudPreview session={loadSession()!} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    await screen.findByRole("heading", { name: "Private" });
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
    expect(screen.queryByRole("heading", { name: "Private" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("loaded-version")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新当前版本" })).toBeDisabled();
  });

  it("reports PSD version only after the pixels have rendered and clears the canvas on unmount", async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData,
    } as unknown as CanvasRenderingContext2D);
    psd.load.mockResolvedValue({ doc: { canvas: { width: 2, height: 2 }, layers: [{ id: "one", name: "Image", visible: true }] }, version: 7 });
    psd.composite.mockResolvedValue({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) });
    const view = render(<CloudPreview session={loadSession()!} docType="psd" docId="document" onSignedOut={vi.fn()} />);
    expect(await screen.findByTestId("loaded-version")).toHaveTextContent("v7");
    expect(putImageData).toHaveBeenCalledTimes(1);
    const canvas = screen.getByLabelText("云端 PSD 只读画布") as HTMLCanvasElement;
    expect(canvas.dataset.ready).toBe("true");
    view.unmount();
    expect(canvas.width).toBe(1); expect(canvas.dataset.ready).toBeUndefined();
  });

  it("does not show a loaded version when PSD resources fail", async () => {
    psd.load.mockRejectedValue(new ApiError(404, "Missing pixels"));
    render(<CloudPreview session={loadSession()!} docType="psd" docId="document" onSignedOut={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing pixels");
    expect(screen.queryByTestId("loaded-version")).not.toBeInTheDocument();
  });
});