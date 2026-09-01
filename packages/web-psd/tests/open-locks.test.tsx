import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { SidePanel } from "../src/ui/panels/side-panel.js";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ChatPanel } from "../src/ui/panels/chat-panel.js";
import { setState } from "../src/ui/store.js";

const { exportDoc, openFile } = vi.hoisted(() => ({
  exportDoc: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
}));

vi.mock("../src/ui/controller.js", () => ({
  getController: () => null,
  exportDoc,
  openFile,
}));

const opening = { phase: "parse", name: "a.psd", bytes: 1024 } as const;

beforeEach(() => {
  exportDoc.mockClear();
  openFile.mockClear();
  setState({ docId: "abcdef0123456789", docName: "a.psd", version: 3 });
});

describe("locks while a file is opening", () => {
  // 这期间 store 里的 doc 前半段还是旧文档、后半段是新文档但没有像素,
  // 任何一处能点的地方都在对一个不该被操作的文档发指令。
  it("disables 打开 so a second open cannot start on top of the first", () => {
    setState({ opening });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "打开" })).toBeDisabled();
  });

  it("disables 导出 even though a document id is present", () => {
    // docId 此刻指向的可能正是那个正在被替换掉的旧文档。
    setState({ opening });
    render(<TopBar />);
    const button = screen.getByRole("button", { name: "导出" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(exportDoc).not.toHaveBeenCalled();
  });

  it("leaves both buttons live when nothing is opening", () => {
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "打开" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
  });

  // 同一个文件连选两次,第二次不触发 change,看起来像点了没反应。清 value
  // 要在 onChange 里做:openFile 是 async 的,等它回来才清,中间这段时间
  // 同一个文件仍然选不动。
  it("clears the file input so the same file can be picked twice", () => {
    const { container } = render(<TopBar />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const setValue = vi.fn();
    Object.defineProperty(input, "value", {
      set: setValue, get: () => "C:\\fakepath\\a.psd", configurable: true,
    });

    fireEvent.change(input, { target: { files: [{ name: "a.psd" }] } });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledWith("");
  });

  it("makes the layers/props column inert", () => {
    setState({ opening, doc: { canvas: { width: 1, height: 1 }, layers: [] } as never });
    const { container } = render(<SidePanel />);
    expect(container.querySelector(".col-panel")).toHaveAttribute("inert");
  });

  it("makes the tool strip inert", () => {
    setState({ opening });
    const { container } = render(<ToolStrip />);
    expect(container.querySelector(".tools")).toHaveAttribute("inert");
  });

  it("leaves them interactive when nothing is opening", () => {
    setState({ doc: { canvas: { width: 1, height: 1 }, layers: [] } as never });
    const { container: panel } = render(<SidePanel />);
    expect(panel.querySelector(".col-panel")).not.toHaveAttribute("inert");
    const { container: tools } = render(<ToolStrip />);
    expect(tools.querySelector(".tools")).not.toHaveAttribute("inert");
  });

  // agent 跑在服务端的 docId 上,加载中发消息会打到正在被替换的旧文档。
  it("disables the chat composer", () => {
    setState({ opening });
    render(<ChatPanel />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
