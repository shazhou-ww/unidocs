import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { AdminPortalClientError } from "@unidocs/admin-portal-client";
import { adminRoutePath, App, logoutToLogin, parseAdminRoute, returnToAppWhenAuthenticated, sessionInvalidPath } from "../src/app.js";

beforeEach(() => window.history.replaceState({}, "", "/"));

test("parses and builds stable Admin routes", () => {
  expect(parseAdminRoute("https://portal.test/admin/audit")).toEqual({ view: "audit" });
  expect(parseAdminRoute("https://portal.test/admin/administrators")).toEqual({ view: "administrators" });
  expect(parseAdminRoute("https://portal.test/admin/document-types/markdown?tab=contracts")).toEqual({ view: "documentTypes", documentType: "markdown", tab: "contracts" });
  expect(parseAdminRoute("https://portal.test/admin/document-types/markdown?tab=invalid")).toEqual({ view: "documentTypes", documentType: "markdown", tab: "config" });
  expect(adminRoutePath({ view: "documentTypes", documentType: "markdown", tab: "contracts" })).toBe("/admin/document-types/markdown?tab=contracts");
});

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
  expect(screen.getByRole("button", { name: "文档类型" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "管理员" })).toBeInTheDocument();

  const searchInput = screen.getByRole("textbox", { name: "搜索文档类型" });
  fireEvent.change(searchInput, { target: { value: "markdown" } });
  fireEvent.submit(searchInput.closest("form")!);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("q=markdown"), expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "管理员" }));
  expect(window.location.pathname).toBe("/admin/administrators");
  expect(await screen.findByText("还没有管理员成员")).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: "管理员" }));
  expect(await screen.findByRole("heading", { name: "管理员" })).toBeInTheDocument();
  expect(await screen.findByText("当前账户")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加管理员" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Google 账户邮箱" }), { target: { value: "member@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/administrators"), expect.objectContaining({ method: "POST" })));
  vi.unstubAllGlobals();
});

test("confirms removal of another administrator with its current ETag", async () => {
  const member = { adminId: "member", email: "member@example.com", bound: true, addedBy: "admin", addedAt: "2026-09-11T00:00:00.000Z", etag: '"sha256-member"', isSelf: false };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.includes("/administrators/member") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/administrators")) return Response.json({ items: [member], nextCursor: null });
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "管理员" }));
  await screen.findByText("member@example.com");
  fireEvent.click(screen.getByRole("button", { name: "移除 member@example.com" }));
  expect(screen.getByRole("dialog", { name: "移除管理员" })).toHaveTextContent("member@example.com");
  fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/administrators/member"), expect.objectContaining({ method: "DELETE" })));
  const removeCall = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
  expect(new Headers(removeCall[1]?.headers).get("if-match")).toBe(member.etag);
  vi.unstubAllGlobals();
});

test("filters, paginates, and opens audit event details", async () => {
  const first = { auditEventId: "event-2", actorId: "admin", action: "administrator.added", resourceType: "administrator", resourceId: "member", documentType: null, occurredAt: "2026-09-11T01:00:00.000Z", requestId: "request-2", reason: null };
  const second = { ...first, auditEventId: "event-1", action: "administrator.bootstrap", resourceId: "admin", occurredAt: "2026-09-11T00:00:00.000Z", requestId: "request-1" };
  const fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.includes("/administrators")) return Response.json({ items: [{ adminId: "admin", email: "lee.scott@example.com", bound: true, addedBy: "bootstrap", addedAt: "2026-09-11T00:00:00.000Z", etag: '"sha256-admin"', isSelf: true }], nextCursor: null });
    if (url.includes("/audit-events") && url.includes("cursor=next")) return Response.json({ items: [second], nextCursor: null });
    if (url.includes("/audit-events")) return Response.json({ items: [first], nextCursor: "next" });
    return Response.json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "审计" }));
  const allActionLabels = Array.from((screen.getByRole("combobox", { name: "审计动作" }) as HTMLSelectElement).options).map(option => option.text);
  const allResourceLabels = Array.from((screen.getByRole("combobox", { name: "审计资源" }) as HTMLSelectElement).options).map(option => option.text);
  expect(allActionLabels.every(label => !label.includes(".") && !label.includes("_"))).toBe(true);
  expect(allResourceLabels).toEqual(["全部资源", "管理员", "文档类型", "文档契约", "类型卡片包", "视图包", "算子", "算子验证"]);
  const firstRow = await screen.findByRole("row", { name: /administrator\.added/ });
  expect(firstRow).toHaveTextContent("lee.scott");
  expect(firstRow).toHaveTextContent("lee.scott@example.com");
  fireEvent.click(firstRow);
  expect(screen.getByRole("complementary", { name: "审计事件详情" })).toHaveTextContent("request-2");
  expect(screen.getByRole("complementary", { name: "审计事件详情" })).toHaveTextContent("admin");
  fireEvent.change(screen.getByRole("combobox", { name: "审计动作" }), { target: { value: "document_type.registered" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("action=document_type.registered"), expect.anything()));
  fireEvent.change(screen.getByRole("combobox", { name: "审计资源" }), { target: { value: "administrator" } });
  const actionSelect = screen.getByRole("combobox", { name: "审计动作" }) as HTMLSelectElement;
  expect(actionSelect.value).toBe("all");
  const actionOptions = Array.from(actionSelect.options).map(option => option.value);
  expect(actionOptions).toEqual(["all", "administrator.bootstrap", "administrator.bound", "administrator.added", "administrator.removed"]);
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
    const url = String(input);
    return url.includes("resourceType=administrator") && !url.includes("action=");
  })).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByRole("row", { name: /administrator\.bootstrap/ })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=next"), expect.anything());
  vi.unstubAllGlobals();
});

test("restores the audit page from a direct refresh route", async () => {
  window.history.replaceState({}, "", "/admin/audit");
  const fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    return Response.json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("heading", { name: "审计" })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/audit-events"), expect.anything()));
  window.history.replaceState({}, "", "/");
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

test("builds a session-invalid route for protected API authorization loss", () => {
  expect(sessionInvalidPath(new AdminPortalClientError(401, "unauthorized", "expired", "request-401")))
    .toBe("/admin/access-denied?code=session_invalid&requestId=request-401");
  expect(sessionInvalidPath(new AdminPortalClientError(401, "unauthorized", "expired")))
    .toBe("/admin/access-denied?code=session_invalid");
});

test("shows an authorization-loss page after its session probe confirms 401", async () => {
  window.history.replaceState({}, "", "/admin/access-denied?code=session_invalid&requestId=request-removed");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ error: { code: "unauthorized", message: "Authentication required", requestId: "probe" } }, { status: 401 })));
  render(<App />);
  expect(await screen.findByRole("heading", { name: "管理员权限已失效" })).toBeInTheDocument();
  expect(screen.getByText(/成员可能已被移除/)).toBeInTheDocument();
  expect(screen.getByText("request-removed")).toBeInTheDocument();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});