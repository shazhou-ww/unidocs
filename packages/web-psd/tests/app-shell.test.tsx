import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/app.js";

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
});
