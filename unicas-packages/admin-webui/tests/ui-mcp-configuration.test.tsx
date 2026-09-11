// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../src/ui/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AI tool connection", () => {
  test("opens from the desktop header, copies connection details, and closes with Escape", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/admin/me") {
        return json({
          identity: { displayName: "Admin User", emailForDisplay: "admin@example.com" },
          memberships: [],
        });
      }
      if (path === "/admin/stacks") return json({ items: [] });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const docsLink = await screen.findByRole("link", { name: "Open UniCAS documentation" });
    expect(docsLink).toHaveAttribute("href", "https://docs.shazhou.work/unicas");
    expect(docsLink).toHaveAttribute("target", "_blank");
    expect(docsLink).toHaveAttribute("rel", "noreferrer");

    const trigger = await screen.findByRole("button", { name: "Connect AI tools" });
    const userMenu = screen.getByRole("button", { name: "Admin User" });
    expect(trigger.compareDocumentPosition(userMenu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Connect an AI tool" });
    expect(dialog).toHaveTextContent(`${window.location.origin}/mcp`);
    expect(dialog).toHaveTextContent("Configuration prompt");
    expect(dialog).toHaveTextContent("No API key required");
    expect(dialog).toHaveTextContent("CLI prompt");
    expect(dialog).toHaveTextContent("unicas login");
    // The CLI prompt is the single merged prompt: install + skill + usage.
    expect(dialog).not.toHaveTextContent("CLI setup & usage");
    expect(dialog).not.toHaveTextContent("Agent skill install");
    expect(dialog).toHaveTextContent(`${window.location.origin}/admin/assets/skills/unicas-cli/SKILL.md`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close AI tool connection" })).toHaveFocus());

    // The URL is a click-to-copy bubble (no separate label row or Copy URL button).
    const urlBubble = screen.getByRole("button", { name: "Copy MCP server URL" });
    await user.click(urlBubble);
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/mcp`);
    expect(screen.queryByRole("button", { name: "Copy URL" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(await navigator.clipboard.readText()).toContain('remote MCP server named "UniCAS"');
    expect(screen.getByRole("button", { name: "Prompt copied" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy CLI prompt" }));
    const cliPrompt = await navigator.clipboard.readText();
    expect(cliPrompt).toContain("pnpm install --global ./unicas-packages/admin-cli");
    expect(cliPrompt).toContain("unicas login");
    expect(cliPrompt).toContain(`${window.location.origin}/admin/assets/skills/unicas-cli/SKILL.md`);
    expect(cliPrompt).toContain("standard agent-skills location");
    expect(cliPrompt).not.toContain("DeepSeek Harness");
    expect(cliPrompt).not.toContain("Claude Code");
    expect(cliPrompt).toContain('command "unicas", args ["mcp"]');
    expect(screen.getByRole("button", { name: "CLI prompt copied" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Connect an AI tool" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});