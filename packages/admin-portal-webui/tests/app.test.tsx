import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../src/app.js";

test("loads the signed-in administrator and real empty document type state", async () => {
  const fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    return Response.json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("heading", { name: "文档类型" })).toBeInTheDocument();
  expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
  expect(await screen.findByText("没有匹配的文档类型")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();

  const searchInput = screen.getByRole("textbox", { name: "搜索文档类型" });
  fireEvent.change(searchInput, { target: { value: "markdown" } });
  fireEvent.submit(searchInput.closest("form")!);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("q=markdown"), expect.anything()));
  vi.unstubAllGlobals();
});

test("loads members and submits a new administrator from the navigation", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.includes("/administrators") && init?.method === "POST") return Response.json({ adminId: "member", etag: '"sha256-member"' }, { status: 201 });
    if (url.includes("/administrators")) return Response.json({ items: [{ adminId: "admin", email: "admin@example.com", bound: true, addedBy: "bootstrap", addedAt: "2026-09-11T00:00:00.000Z", etag: '"sha256-admin"', isSelf: true }], nextCursor: null });
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /管理员/ }));
  expect(await screen.findByRole("heading", { name: "管理员" })).toBeInTheDocument();
  expect(await screen.findByText("当前账户")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加管理员" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Google 账户邮箱" }), { target: { value: "member@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/administrators"), expect.objectContaining({ method: "POST" })));
  vi.unstubAllGlobals();
});

test("renders a useful access denial without calling authenticated APIs", () => {
  window.history.replaceState({}, "", "/admin/access-denied?code=forbidden&requestId=request-1");
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("heading", { name: "没有管理员权限" })).toBeInTheDocument();
  expect(screen.getByText("request-1")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/admin/auth/login");
  expect(fetchMock).not.toHaveBeenCalled();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});