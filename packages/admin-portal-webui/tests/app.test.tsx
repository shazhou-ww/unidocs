import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App, logoutToLogin, returnToAppWhenAuthenticated } from "../src/app.js";

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

test("renders a useful access denial only after the session probe fails", async () => {
  window.history.replaceState({}, "", "/admin/access-denied?code=forbidden&requestId=request-1");
  let rejectSession!: (reason: Error) => void;
  const fetchMock = vi.fn<typeof fetch>(() => new Promise((_resolve, reject) => { rejectSession = reject; }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("heading", { name: "正在确认登录状态" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "没有管理员权限" })).not.toBeInTheDocument();
  rejectSession(new Error("not signed in"));
  expect(await screen.findByRole("heading", { name: "没有管理员权限" })).toBeInTheDocument();
  expect(screen.getByText("request-1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出并返回登录" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith("/admin/auth/session", { credentials: "include" });
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

test("shows a public Google login prompt after the session probe fails", async () => {
  window.history.replaceState({}, "", "/admin/login");
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "unauthorized", message: "Authentication required", requestId: "request" } }, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("heading", { name: "正在确认登录状态" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "登录管理控制台" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "使用 Google Account 登录" })).toHaveAttribute("href", "/admin/auth/login");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith("/admin/auth/session", { credentials: "include" });
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

test("logout always returns to the login prompt after attempting session cleanup", async () => {
  const order: string[] = [];
  await logoutToLogin(async () => { order.push("logout"); }, path => order.push(path));
  expect(order).toEqual(["logout", "/admin/login"]);
  await logoutToLogin(async () => { order.push("failed-logout"); throw new Error("expired"); }, path => order.push(path));
  expect(order.slice(-2)).toEqual(["failed-logout", "/admin/login"]);
});

test("leaves stale denial and login pages when another callback already created a valid session", async () => {
  const destinations: string[] = [];
  expect(await returnToAppWhenAuthenticated(async () => ({ email: "admin@example.com" }), path => destinations.push(path))).toBe(true);
  expect(destinations).toEqual(["/admin/"]);
  expect(await returnToAppWhenAuthenticated(async () => { throw new Error("not signed in"); }, path => destinations.push(path))).toBe(false);
  expect(destinations).toEqual(["/admin/"]);
});