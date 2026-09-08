import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AdminView } from "../src/ui/views/admin.js";
import { StrictMode } from "react";

const self = { adminId: "self", email: "shazhou.ww@gmail.com", bound: true, isSelf: true, addedAt: "2026-09-08T00:00:00Z", etag: '"self-2"' };
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
it("uses management API only and protects self removal while adding an administrator", async () => {
  const items = [self];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/session")) return Response.json({ data: { ...self, csrfToken: "csrf" } });
    if (init?.method === "POST") { items.push({ ...self, adminId: "other", email: "other@example.com", isSelf: false }); return Response.json({ data: items[1] }, { status: 201 }); }
    return Response.json({ items, nextCursor: null });
  }));
  const user = userEvent.setup(); render(<AdminView />);
  expect(await screen.findByRole("button", { name: "不能删除自己" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "添加管理员" }));
  const modal = screen.getByRole("dialog");
  await user.type(within(modal).getByLabelText("Google 账号邮箱"), "other@example.com");
  await user.click(within(modal).getByRole("button", { name: "添加" }));
  await screen.findByText("other@example.com");
  const post = calls.find(call => call.init?.method === "POST")!;
  expect(post.init?.headers).toMatchObject({ "X-CSRF-Token": "csrf", "Idempotency-Key": expect.any(String) });
  expect(calls.every(call => call.url.startsWith("/admin/"))).toBe(true);
});

it("preserves original command and input after an uncertain outcome", async () => {
  const posts: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ data: { ...self, csrfToken: "csrf" } });
    if (init?.method === "POST") { posts.push(init); if (posts.length === 1) throw new Error("offline"); return Response.json({ data: {} }, { status: 201 }); }
    return Response.json({ items: [self], nextCursor: null });
  }));
  const user = userEvent.setup(); render(<AdminView />); await screen.findByRole("button", { name: "不能删除自己" });
  await user.click(screen.getByRole("button", { name: "添加管理员" }));
  const modal = screen.getByRole("dialog");
  await user.type(within(modal).getByLabelText("Google 账号邮箱"), "other@example.com");
  await user.click(within(modal).getByRole("button", { name: "添加" }));
  expect(await within(modal).findByText(/结果待确认/)).toBeInTheDocument();
  expect(within(modal).getByLabelText("Google 账号邮箱")).toBeDisabled();
  await user.click(within(modal).getByRole("button", { name: "重试原请求" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(posts[1]!.headers).toEqual(posts[0]!.headers); expect(posts[1]!.body).toEqual(posts[0]!.body);
});

it("clears management data on denied session and does not auto-create a session", async () => {
  const fetch = vi.fn(async () => Response.json({ error: { code: "administrator_required" } }, { status: 403 }));
  vi.stubGlobal("fetch", fetch); render(<AdminView />);
  expect(await screen.findByRole("alert")).toHaveTextContent("没有运营管理权限");
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(fetch.mock.calls).toHaveLength(1);
});

it("exchanges the shared Google login once on callback return before loading management data", async () => {
  window.history.replaceState(null, "", "/admin/?google=complete");
  const calls: string[] = [];
  let established = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/admin/auth/session") {
      expect(init?.headers).toEqual({ "X-UniDocs-Admin": "1" });
      established = true;
      return Response.json({ data: { csrfToken: "csrf" } }, { status: 201 });
    }
    expect(established).toBe(true);
    if (url.endsWith("/session")) return Response.json({ data: { ...self, csrfToken: "csrf" } });
    return Response.json({ items: [self], nextCursor: null });
  }));
  render(<StrictMode><AdminView /></StrictMode>);
  expect(await screen.findByRole("button", { name: "不能删除自己" })).toBeDisabled();
  expect(calls).toEqual(["POST /admin/auth/session", "GET /admin/api/v1/session", "GET /admin/api/v1/administrators?limit=50"]);
  expect(window.location.search).toBe("");
});

it("does not redirect-loop or read the list when callback session exchange is denied", async () => {
  window.history.replaceState(null, "", "/admin/?google=complete");
  const fetch = vi.fn(async () => Response.json({ error: { code: "google_login_required" } }, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  render(<AdminView />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Google 登录确认未能恢复");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe("/admin/");
  expect(window.location.search).toBe("");
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});