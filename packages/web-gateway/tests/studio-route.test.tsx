import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/ui/app.js";

vi.mock("../src/ui/studio/studio.js", () => ({ StudioView: () => <h1>Local studio</h1> }));

afterEach(() => { window.location.hash = ""; });

test("the default route opens the local studio without a cloud token", async () => {
  window.history.replaceState(null, "", "/ui/");
  window.location.hash = "/";
  sessionStorage.clear(); localStorage.clear();
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Local studio" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with Google" })).not.toBeInTheDocument();
});