// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { StackView } from "../src/ui/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CURRENT_STACK = {
  stackId: "cas_one",
  displayName: "Primary stack",
  description: "Primary production stack",
  status: "active",
  createdAt: 1,
  revision: 3,
};

const OTHER_STACK = {
  stackId: "cas_two",
  displayName: "Secondary stack",
  description: "",
  status: "active",
  createdAt: 2,
  revision: 1,
};

beforeEach(() => {
  window.location.hash = "#/stacks/cas_one";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), "http://localhost").pathname;
    if (pathname === "/admin/stacks/cas_one") return json(CURRENT_STACK);
    if (pathname === "/admin/stacks") return json({ items: [CURRENT_STACK, OTHER_STACK] });
    if (pathname.endsWith("/members")) return json({ items: [] });
    if (pathname.endsWith("/issuer/keys")) return json({ keys: [] });
    if (pathname.endsWith("/issuer")) return json({ error: "NOT_FOUND", message: "issuer is not configured" }, 404);
    if (pathname.endsWith("/ref-domains")) return json({ domains: [] });
    if (pathname.endsWith("/audit-events")) return json({ items: [], nextCursor: null });
    throw new Error(`Unexpected request: ${pathname}`);
  }));
});

describe("StackView", () => {
  test("renders a stack switcher above vertical management navigation", async () => {
    const user = userEvent.setup();
    render(<StackView stackId="cas_one" onOpenMcpConfiguration={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Primary stack" })).toBeInTheDocument());
    expect(document.title).toBe("UniCAS | Primary stack");
    const switcher = screen.getByRole("combobox", { name: "Stack" });
    expect(switcher).toHaveValue("cas_one");
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.queryByRole("tab", { name: "Ref domains" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My Stacks" })).not.toBeInTheDocument();
    const metadata = screen.getByRole("heading", { name: "Stack metadata" }).closest(".card");
    expect(metadata).toHaveTextContent("Stack IDcas_one");
    expect(metadata).toHaveTextContent("Statusactive");
    expect(metadata).toHaveTextContent("Revision3");
    expect(metadata).toHaveTextContent("Created");

    await user.selectOptions(switcher, "cas_two");
    expect(window.location.hash).toBe("#/stacks/cas_two");
  });

  test("documents the concepts behind every management section", async () => {
    const user = userEvent.setup();
    render(<StackView stackId="cas_one" onOpenMcpConfiguration={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("complementary", { name: "Stack identity" })).toBeInTheDocument());
    const guides = [
      ["Members", "Stack administrators"],
      ["Issuer & keys", "Tenant capability trust"],
      ["Control audit", "Control-plane audit"],
      ["Root Ref audit", "Root Ref audit"],
      ["Usage", "Tenant storage usage"],
    ] as const;

    for (const [tab, guide] of guides) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("complementary", { name: guide })).toBeInTheDocument();
      expect(screen.getByText("About this page")).toBeInTheDocument();
    }

    await user.click(screen.getByRole("tab", { name: "Root Ref audit" }));
    expect(screen.getByText("Ref domain")).toBeInTheDocument();
  });

  test("updates the stack description with the current revision", async () => {
    const user = userEvent.setup();
    let currentStack = CURRENT_STACK;
    let patchBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), "http://localhost").pathname;
      if (pathname === "/admin/stacks/cas_one" && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
        currentStack = { ...currentStack, description: String(patchBody.description), revision: 4 };
        return json(currentStack);
      }
      if (pathname === "/admin/stacks/cas_one") return json(currentStack);
      if (pathname === "/admin/stacks") return json({ items: [currentStack, OTHER_STACK] });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    render(<StackView stackId="cas_one" onOpenMcpConfiguration={vi.fn()} onLogout={vi.fn()} />);
    const description = await screen.findByLabelText("Description");
    await user.clear(description);
    await user.type(description, "Updated production stack");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBody).toMatchObject({
      displayName: "Primary stack",
      description: "Updated production stack",
    }));
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