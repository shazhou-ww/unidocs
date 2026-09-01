import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/app.js";
import { setState } from "../src/ui/store.js";

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId = null;
    createFrom = vi.fn(async () => {});
    requestVisibleTiles = vi.fn();
    toScreen = () => ({ x: 0, y: 0 });
    toCanvas = () => ({ x: 0, y: 0 });
    pickColor = () => null;
    reconcile = vi.fn(async () => {});
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })));

describe("App shell", () => {
  it("renders the three columns", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".col-chat")).toBeInTheDocument();
    expect(container.querySelector(".col-canvas")).toBeInTheDocument();
    expect(container.querySelector(".col-panel")).toBeInTheDocument();
  });

  it("gives each column its header", () => {
    render(<App />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("图层")).toBeInTheDocument();
    expect(screen.getByText("属性")).toBeInTheDocument();
  });

  // Visual column ORDER lives in styles.css (`order: 1|2|3`) and cannot be
  // asserted here — jsdom does not apply the imported stylesheet. It is
  // verified by the manual smoke step at the end of Task 9 instead.
  it("declares the columns in the DOM", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll(".col-chat, .col-canvas, .col-panel")).toHaveLength(3);
  });

  it("mounts the open overlay inside the canvas column, not the stage", () => {
    // .stage 会滚动,遮罩必须挂在不滚动的列上,否则换一个大文件时它会跟着
    // 上一个文档的内容滚出视野。
    setState({ opening: { phase: "upload", name: "a.psd", bytes: 1024 } });
    const { container } = render(<App />);
    const overlay = container.querySelector(".open-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay!.parentElement).toHaveClass("col-canvas");
  });
});
