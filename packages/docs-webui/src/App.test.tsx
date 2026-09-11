import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./App.js";

vi.mock("@scalar/api-reference", () => ({
  createApiReference: vi.fn(),
}));

describe("shared documentation site", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.history.replaceState(null, "", "/unicas/getting-started");
    window.scrollTo = vi.fn();
  });

  test("renders Markdown guides and the independent Admin Portal link", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Getting started" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Admin Portal/ })).toHaveAttribute(
      "href",
      "https://unicas.shazhou.work/admin/",
    );
  });

  test("navigates between guides without a full-page reload", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: /Leases and Root Refs/ }));

    expect(window.location.pathname).toBe("/unicas/concepts/leases-and-root-refs");
    expect(screen.getByRole("heading", { name: "Leases and Root Refs" })).toBeInTheDocument();
  });

  test("switches from UniCAS to the UniDocs Admin documentation", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "UniDocs" }));

    expect(window.location.pathname).toBe("/unidocs");
    expect(screen.getByRole("heading", { name: "UniDocs Admin control plane" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open UniDocs/ })).toHaveAttribute(
      "href",
      "https://unidocs.shazhou.work/",
    );
    expect(screen.getByRole("link", { name: /Document type lifecycle/ })).toBeInTheDocument();
  });
});