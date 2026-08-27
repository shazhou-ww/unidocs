// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyStacksView } from "../src/ui/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MyStacksView", () => {
  test("shows loading then the stack list", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { stackId: "cas_one", displayName: "Cloudflare", status: "active", createdAt: 1, revision: 1 },
    ] }));
    render(<MyStacksView />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CAS stacks" })).toBeInTheDocument();
    expect(screen.getByText(/top-level UniCAS trust and storage boundary/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Cloudflare")).toBeInTheDocument());
    expect(screen.getByText("cas_one")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/admin/stacks", expect.any(Object));
  });

  test("shows the empty state when there are no stacks", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    render(<MyStacksView />);
    await waitFor(() => expect(screen.getByText(/not a member of any stack/)).toBeInTheDocument());
  });

  test("creates a stack and refreshes the list", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ stackId: "cas_new", displayName: "New", status: "active", createdAt: 1, revision: 1 }))
      .mockResolvedValueOnce(json({ items: [
        { stackId: "cas_new", displayName: "New", status: "active", createdAt: 1, revision: 1 },
      ] }));
    const user = userEvent.setup();
    render(<MyStacksView />);
    await waitFor(() => expect(screen.getByText(/not a member/)).toBeInTheDocument());
    await user.type(screen.getByLabelText("Stack display name"), "New");
    await user.click(screen.getByRole("button", { name: "Create stack" }));
    await waitFor(() => expect(screen.getByText("cas_new")).toBeInTheDocument());
    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/admin/stacks" && call[1]?.method === "POST");
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall![1]!.body as string)).toEqual({ displayName: "New" });
  });

  test("surfaces creation errors", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ error: "INVALID_REQUEST", message: "displayName must not be empty" }, 400));
    const user = userEvent.setup();
    render(<MyStacksView />);
    await waitFor(() => expect(screen.getByText(/not a member/)).toBeInTheDocument());
    await user.type(screen.getByLabelText("Stack display name"), "X");
    await user.click(screen.getByRole("button", { name: "Create stack" }));
    await waitFor(() => expect(screen.getByText("displayName must not be empty")).toBeInTheDocument());
  });
});
