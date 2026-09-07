import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreationStatus } from "../src/ui/views/creation-status.js";
import { ApiError, documentStatus } from "../src/ui/api.js";

vi.mock("../src/ui/api.js", async original => ({ ...await original<typeof import("../src/ui/api.js")>(), documentStatus: vi.fn() }));
beforeEach(() => { vi.mocked(documentStatus).mockReset(); });
const props = () => ({ tenantId: "alice", docType: "psd", docId: "pending", onReady: vi.fn(), onSignedOut: vi.fn() });
describe("creation status", () => {
  it("checks only on demand, keeps pending, then enables preview when ready", async () => {
    const callbacks = props(); render(<CreationStatus {...callbacks} />);
    expect(documentStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    vi.mocked(documentStatus).mockResolvedValueOnce({ doc_id: "pending", doc_type: "psd", state: "creating", version: null })
      .mockResolvedValueOnce({ doc_id: "pending", doc_type: "psd", state: "ready", version: 1 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "检查创建状态" }));
    expect(await screen.findByText("仍在处理中")).toBeInTheDocument();
    expect(callbacks.onReady).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "检查创建状态" }));
    expect(await screen.findByRole("link", { name: "打开预览" })).toHaveAttribute("href", "#/preview/psd/pending");
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
  });
  it("keeps errors retryable and treats terminal failure as no preview", async () => {
    render(<CreationStatus {...props()} />);
    vi.mocked(documentStatus).mockRejectedValueOnce(new Error("Network"))
      .mockResolvedValueOnce({ doc_id: "pending", doc_type: "psd", state: "failed", version: null });
    const user = userEvent.setup(); await user.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未确认");
    await user.click(screen.getByRole("button"));
    expect(await screen.findByText("创建失败")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("deduplicates clicks and aborts on unmount", async () => {
    vi.mocked(documentStatus).mockImplementation(() => new Promise(() => { }));
    const view = render(<CreationStatus {...props()} />);
    const button = screen.getByRole("button"); fireEvent.click(button); fireEvent.click(button);
    expect(documentStatus).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(documentStatus).mock.calls[0]![3]!;
    view.unmount(); expect(signal.aborted).toBe(true);
  });
  it("returns expired sessions to sign-in", async () => {
    const callbacks = props(); vi.mocked(documentStatus).mockRejectedValue(new ApiError(401, "Expired"));
    render(<CreationStatus {...callbacks} />); fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(callbacks.onSignedOut).toHaveBeenCalledTimes(1));
  });
});