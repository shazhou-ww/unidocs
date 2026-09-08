import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AdminCatalog } from "../src/ui/views/admin-catalog.js";

afterEach(() => vi.unstubAllGlobals());
const record = { docType: "markdown", baseUrl: "https://md.test/", enabled: true, etag: '"type-markdown-1"', checkedAt: new Date().toISOString(), discovered: { displayName: "Markdown", formats: [".md"], capabilities: { preview: false, edit: false } } };
it("validates URL before registration and invalidates proof when URL changes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/url-validations")) return Response.json({ data: { validationId: "proof", baseUrl: "https://md.test/", state: "passed", expiresAt: Date.now() + 60_000, discovered: { ...record.discovered, docType: "markdown" } } });
    if (init?.method === "POST") return Response.json({ data: record });
    return Response.json({ items: [], nextCursor: null, consumption: "not-connected" });
  }));
  const user = userEvent.setup(); render(<AdminCatalog view="types" csrfToken="csrf" onDenied={vi.fn()} />);
  await screen.findByText("没有匹配的文档类型"); await user.click(screen.getByRole("button", { name: "登记类型" }));
  const modal = screen.getByRole("dialog"); const save = within(modal).getByRole("button", { name: "保存配置" });
  expect(save).toBeDisabled(); await user.type(within(modal).getByLabelText("Base URL"), "https://md.test/");
  await user.click(within(modal).getByRole("button", { name: "验证 URL" })); expect(save).not.toBeDisabled();
  await user.type(within(modal).getByLabelText("Base URL"), "other"); expect(save).toBeDisabled();
  await user.clear(within(modal).getByLabelText("Base URL")); await user.type(within(modal).getByLabelText("Base URL"), "https://md.test/");
  await user.click(within(modal).getByRole("button", { name: "验证 URL" })); await user.click(within(modal).getByRole("checkbox")); await user.click(save);
  await screen.findByText("配置已保存，尚未接入主站。");
  const created = calls.find(call => call.init?.method === "POST" && call.url.endsWith("/document-types"))!;
  expect(JSON.parse(created.init!.body as string)).toEqual({ baseUrl: "https://md.test/", enabled: true, validationId: "proof" });
  expect(created.init!.headers).toMatchObject({ "X-CSRF-Token": "csrf", "Idempotency-Key": expect.any(String) });
});

it("confirms an uncertain target-state command without resending a completed mutation", async () => {
  const mutations: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { mutations.push(init); throw new Error("response lost"); }
    if (url.includes("/changes/")) return Response.json({ data: { ...record, enabled: false } });
    return Response.json({ items: [record], nextCursor: null });
  }));
  const user = userEvent.setup(); render(<AdminCatalog view="types" csrfToken="csrf" onDenied={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "查看 markdown" })); await user.click(screen.getByRole("button", { name: "设为停用" }));
  const modal = screen.getByRole("dialog"); await user.type(within(modal).getByLabelText("变更原因"), "maintenance");
  await user.click(within(modal).getByRole("button", { name: "保存配置" }));
  await user.click(await within(modal).findByRole("button", { name: "核实并重试" }));
  await screen.findByText("配置已保存，尚未接入主站。"); expect(mutations).toHaveLength(1); expect(mutations[0]!.headers).toMatchObject({ "If-Match": record.etag });
});

it("clears data and reports revoked authorization", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "administrator_required" } }, { status: 403 })));
  const denied = vi.fn(); render(<AdminCatalog view="audit" csrfToken="csrf" onDenied={denied} />);
  await screen.findByText("没有匹配的事件"); expect(denied).toHaveBeenCalledOnce();
});