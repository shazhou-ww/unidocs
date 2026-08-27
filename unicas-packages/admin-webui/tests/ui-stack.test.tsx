// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { StackView } from "../src/ui/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const CURRENT_STACK = {
  stackId: "cas_one",
  displayName: "Primary stack",
  status: "active",
  createdAt: 1,
  revision: 3,
};

const OTHER_STACK = {
  stackId: "cas_two",
  displayName: "Secondary stack",
  status: "active",
  createdAt: 2,
  revision: 1,
};

beforeEach(() => {
  window.location.hash = "#/stacks/cas_one";
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(json(CURRENT_STACK))
    .mockResolvedValueOnce(json({ items: [CURRENT_STACK, OTHER_STACK] })));
});

describe("StackView", () => {
  test("renders a stack switcher above vertical management navigation", async () => {
    const user = userEvent.setup();
    render(<StackView stackId="cas_one" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Primary stack" })).toBeInTheDocument());
    const switcher = screen.getByRole("combobox", { name: "Stack" });
    expect(switcher).toHaveValue("cas_one");
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getAllByRole("tab")).toHaveLength(7);

    await user.selectOptions(switcher, "cas_two");
    expect(window.location.hash).toBe("#/stacks/cas_two");
  });
});