// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
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
    render(<StackView stackId="cas_one" onOpenMcpConfiguration={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Primary stack" })).toBeInTheDocument());
    const switcher = screen.getByRole("combobox", { name: "Stack" });
    expect(switcher).toHaveValue("cas_one");
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(screen.queryByRole("link", { name: "My Stacks" })).not.toBeInTheDocument();

    await user.selectOptions(switcher, "cas_two");
    expect(window.location.hash).toBe("#/stacks/cas_two");
  });

  test("opens and dismisses the mobile navigation drawer", async () => {
    const user = userEvent.setup();
    const onOpenMcpConfiguration = vi.fn();
    const onLogout = vi.fn();
    render(
      <StackView
        stackId="cas_one"
        onOpenMcpConfiguration={onOpenMcpConfiguration}
        onLogout={onLogout}
      />,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Primary stack" })).toBeInTheDocument());
    const trigger = screen.getByRole("button", { name: /Open navigation/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Stack management navigation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close navigation" })).toHaveFocus());
    expect(within(dialog).getByRole("link", { name: /UniCAS Admin/ })).toHaveAttribute("href", "#/");
    await user.click(within(dialog).getByRole("button", { name: "Connect AI tools" }));
    expect(onOpenMcpConfiguration).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("tab", { name: "Usage" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});