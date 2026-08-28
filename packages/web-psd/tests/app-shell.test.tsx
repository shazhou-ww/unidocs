import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/app.js";

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
