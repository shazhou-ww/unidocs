// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { UserMenu } from "../src/ui/index.js";

describe("UserMenu", () => {
  test("keeps sign out inside the username menu", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    render(<UserMenu name="Admin User" onLogout={onLogout} />);

    const trigger = screen.getByRole("button", { name: "Admin User" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "User menu" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("closes on Escape and outside interaction", async () => {
    const user = userEvent.setup();
    render(<><UserMenu name="Admin User" onLogout={vi.fn()} /><button type="button">Outside</button></>);

    const trigger = screen.getByRole("button", { name: "Admin User" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});