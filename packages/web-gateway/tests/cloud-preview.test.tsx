import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudPreview } from "../src/ui/views/cloud-preview.js";
import { ApiError, readMarkdownPreview } from "../src/ui/api.js";
import { loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";

const psd = vi.hoisted(() => ({ load: vi.fn(), composite: vi.fn() }));
vi.mock("../src/ui/api.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ui/api.js")>(), readMarkdownPreview: vi.fn() }));
vi.mock("@unidocs/psd-client", () => ({
  CasBlobStore: class { }, loadDoc: psd.load,
  RenderCore: class { composite() { return psd.composite(); } },
}));

beforeEach(() => { accessTokenSession("alice"); vi.mocked(readMarkdownPreview).mockReset(); psd.load.mockReset(); psd.composite.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe("CloudPreview", () => {
  it("renders the returned version read-only without creating local storage records", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(readMarkdownPreview).mockResolvedValue({ content: "# Cloud content", version: 12 });
    render(<CloudPreview session={loadSession()!} docType="markdown" docId="document" onSignedOut={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Cloud content" })).toBeInTheDocument();
    expect(screen.getByTestId("loaded-version")).toHaveTextContent("v12");
    expect(screen.queryByRole("button", { name: /保存|编辑/ })).not.toBeInTheDocument();
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