import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { OpenOverlay, formatBytes } from "../src/ui/panels/open-overlay.js";
import { setState } from "../src/ui/store.js";

describe("formatBytes", () => {
  it("switches unit at each 1024 boundary", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(44_150_000)).toBe("42.1 MB");
  });
});

describe("OpenOverlay", () => {
  it("renders nothing when no open is in flight", () => {
    const { container } = render(<OpenOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the file being opened and how big it is", () => {
    setState({ opening: { phase: "upload", name: "summer-sale.psd", bytes: 44_150_000 } });
    render(<OpenOverlay />);
    expect(screen.getByText("summer-sale.psd · 42.1 MB")).toBeInTheDocument();
  });

  // 阶段名本身就是进度：走过的、正在跑的、还没到的必须一眼分得开，
  // 否则四个点和一个转圈没有区别。
  it("splits the steps into done / now / todo around the current phase", () => {
    setState({ opening: { phase: "load", name: "a.psd", bytes: 1024 } });
    render(<OpenOverlay />);
    expect(screen.getByText("上传").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("解析").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("载入").closest("li")).toHaveAttribute("data-state", "now");
    expect(screen.getByText("渲染").closest("li")).toHaveAttribute("data-state", "todo");
    expect(screen.getByText("正在载入…")).toBeInTheDocument();
  });

  it("follows the phase as it advances", () => {
    setState({ opening: { phase: "upload", name: "a.psd", bytes: 1024 } });
    render(<OpenOverlay />);
    expect(screen.getByText("正在上传…")).toBeInTheDocument();
    act(() => { setState({ opening: { phase: "render", name: "a.psd", bytes: 1024 } }); });
    expect(screen.getByText("正在渲染…")).toBeInTheDocument();
    expect(screen.getByText("载入").closest("li")).toHaveAttribute("data-state", "done");
  });
});
