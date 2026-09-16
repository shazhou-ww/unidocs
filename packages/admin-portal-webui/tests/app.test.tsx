import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { AdminPortalClientError } from "@unidocs/admin-portal-client";
import { adminRoutePath, App, logoutToLogin, parseAdminRoute, returnToAppWhenAuthenticated, sessionInvalidPath } from "../src/app.js";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
});

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
  expect(allResourceLabels).toEqual(["全部资源", "管理员", "文档类型", "文档契约", "类型卡片包", "视图包", "算子", "算子验证", "租户成员"]);
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

test("restores the Contract tab, reads a revision, and appends a new one", async () => {
  window.history.replaceState({}, "", "/admin/document-types/markdown?tab=contracts");
  const schema = { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" };
  const registration = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: { documentType: "markdown", documentContractIdx: 0, formatVersion: 1, snapshot: { contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1", schema, schemaHash: "sha256:snapshot" }, location: { contentType: "application/vnd.unidocs.markdown.location+json;version=1", schema, schemaHash: "sha256:location" }, contractHash: "sha256:contract", createdAt: "2026-09-11T00:00:00.000Z" }, typeCardBundle: null, viewBundle: null, builtinOperator: null, etag: '"sha256-registration"', updatedAt: "2026-09-11T00:00:00.000Z" };
  const listItem = { documentType: "markdown", documentContractIdx: 0, formatVersion: 1, snapshotSchemaHash: "sha256:snapshot", locationSchemaHash: "sha256:location", contractHash: "sha256:contract", createdAt: "2026-09-11T00:00:00.000Z" };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.endsWith("/document-contracts/0")) return Response.json(registration.latestDocumentContract);
    if (url.includes("/document-contracts") && init?.method === "POST") return Response.json({ documentContractIdx: 1, contractHash: "sha256:next" }, { status: 201 });
    if (url.includes("/document-contracts")) return Response.json({ items: [listItem], nextCursor: null });
    if (url.endsWith("/document-types/markdown")) return Response.json(registration);
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Markdown" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /文档契约/ })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(await screen.findByRole("button", { name: /文档契约 0/ }));
  expect(await screen.findByText("Snapshot media type")).toBeInTheDocument();
  expect(screen.getByText("application/vnd.unidocs.markdown.snapshot+cbor;version=1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加版本" }));
  fireEvent.change(screen.getByRole("textbox", { name: "变更原因" }), { target: { value: "Add revision one" } });
  fireEvent.click(screen.getByRole("button", { name: "提交版本" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/document-contracts"), expect.objectContaining({ method: "POST" })));
  expect(window.location.pathname + window.location.search).toBe("/admin/document-types/markdown?tab=contracts");
  vi.unstubAllGlobals();
});

test("restores the Type Card tab, uploads a ZIP, previews the manifest, and edits metadata", async () => {
  window.history.replaceState({}, "", "/admin/document-types/markdown?tab=cards");
  const bundleId = `tb_${"a".repeat(64)}`;
  const registration = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, etag: '"sha256-registration"', updatedAt: "2026-09-11T00:00:00.000Z" };
  let candidateName = "Primary card";
  const record = () => ({
    typeCardBundleId: bundleId, bundleUrl: `https://bundles.unidocs.test/type-card-bundles/${bundleId}/`, name: candidateName, description: "Candidate",
    manifest: { protocol: "unidocs-type-card/v1", documentType: "markdown", locales: { en: { name: "Markdown", description: "Text documents", sampleThumbnailAlt: "Markdown sample" } }, icon: { kind: "svg", path: "icon.svg" }, sampleThumbnail: "sample.webp" },
    size: 1024, uploadedAt: "2026-09-11T00:00:00.000Z", etag: candidateName === "Primary card" ? '"sha256-card"' : '"sha256-updated"',
  });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.includes("/type-card-bundles?") && init?.method === "POST") return Response.json({ typeCardBundleId: bundleId, etag: '"sha256-card"' }, { status: 201 });
    if (url.endsWith(`/type-card-bundles/${bundleId}`) && init?.method === "PATCH") { candidateName = "Updated card"; return Response.json({ typeCardBundleId: bundleId, etag: '"sha256-updated"' }); }
    if (url.endsWith(`/type-card-bundles/${bundleId}`)) return Response.json(record());
    if (url.includes("/type-card-bundles?")) { const { manifest: _manifest, ...item } = record(); return Response.json({ items: [{ ...item, documentType: "markdown" }], nextCursor: null }); }
    if (url.endsWith("/document-types/markdown")) return Response.json(registration);
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Markdown" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "类型卡片包" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(candidateName) }));
  expect(await screen.findByText("Text documents")).toBeInTheDocument();
  expect(screen.getByAltText("Markdown sample")).toHaveAttribute("src", expect.stringContaining("sample.webp"));
  fireEvent.click(screen.getByRole("button", { name: "上传候选项" }));
  fireEvent.change(screen.getByRole("textbox", { name: "候选项名称" }), { target: { value: "Primary card" } });
  const file = new File(["zip"], "card.zip", { type: "application/zip" });
  fireEvent.change(screen.getByLabelText("类型卡片包 ZIP"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "上传并验证" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && init.body === file)).toBe(true));
  const uploadCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(new Headers(uploadCall[1]?.headers).get("content-type")).toBe("application/zip");
  fireEvent.click(await screen.findByRole("button", { name: "编辑信息" }));
  fireEvent.change(screen.getByRole("textbox", { name: "候选项名称" }), { target: { value: "Updated card" } });
  fireEvent.click(screen.getByRole("button", { name: "保存信息" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
  expect(new Headers(patchCall[1]?.headers).get("if-match")).toBe('"sha256-card"');
  expect(window.location.pathname + window.location.search).toBe("/admin/document-types/markdown?tab=cards");
  vi.unstubAllGlobals();
});

test("restores the View bundle tab, exposes both entrypoints, uploads, and edits metadata", async () => {
  window.history.replaceState({}, "", "/admin/document-types/markdown?tab=bundles");
  const bundleId = `vb_${"b".repeat(64)}`;
  const registration = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, etag: '"sha256-registration"', updatedAt: "2026-09-11T00:00:00.000Z" };
  let candidateName = "Primary view";
  const record = () => ({
    viewBundleId: bundleId, bundleUrl: `https://bundles.unidocs.test/view-bundles/${bundleId}/`, name: candidateName, description: "Candidate",
    manifest: { protocol: "unidocs-view-bundle/v1", documentType: "markdown", entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: [0, 2] },
    size: 2048, uploadedAt: "2026-09-11T00:00:00.000Z", etag: candidateName === "Primary view" ? '"sha256-view"' : '"sha256-updated"',
  });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.includes("/view-bundles?") && init?.method === "POST") return Response.json({ viewBundleId: bundleId, etag: '"sha256-view"' }, { status: 201 });
    if (url.endsWith(`/view-bundles/${bundleId}`) && init?.method === "PATCH") { candidateName = "Updated view"; return Response.json({ viewBundleId: bundleId, etag: '"sha256-updated"' }); }
    if (url.endsWith(`/view-bundles/${bundleId}`)) return Response.json(record());
    if (url.includes("/view-bundles?")) { const { manifest, ...item } = record(); return Response.json({ items: [{ ...item, documentType: "markdown", supportedDocumentContractIdxs: manifest.supportedDocumentContractIdxs }], nextCursor: null }); }
    if (url.endsWith("/document-types/markdown")) return Response.json(registration);
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Markdown" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "界面包" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(candidateName) }));
  expect(await screen.findByText("revision 0 · revision 2")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /view.html/ })).toHaveAttribute("href", `${record().bundleUrl}view.html`);
  expect(screen.getByRole("link", { name: /thumbnail.html/ })).toHaveAttribute("href", `${record().bundleUrl}thumbnail.html`);
  fireEvent.click(screen.getByRole("button", { name: "上传候选项" }));
  fireEvent.change(screen.getByRole("textbox", { name: "候选项名称" }), { target: { value: "Primary view" } });
  const file = new File(["zip"], "view.zip", { type: "application/zip" });
  fireEvent.change(screen.getByLabelText("界面包 ZIP"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "上传并验证" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && init.body === file)).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "编辑信息" }));
  fireEvent.change(screen.getByRole("textbox", { name: "候选项名称" }), { target: { value: "Updated view" } });
  fireEvent.click(screen.getByRole("button", { name: "保存信息" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
  expect(new Headers(patchCall[1]?.headers).get("if-match")).toBe('"sha256-view"');
  expect(window.location.pathname + window.location.search).toBe("/admin/document-types/markdown?tab=bundles");
  vi.unstubAllGlobals();
});

test("validates the Markdown Operator and restores its short-lived result", async () => {
  window.history.replaceState({}, "", "/admin/document-types/dt-markdown?tab=operators");
  const registration = { documentType: "dt-markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: { operatorId: "op_current", name: "Current Operator" }, etag: '"sha256-registration"', updatedAt: "2026-09-11T00:00:00.000Z" };
  const validation = {
    validationId: "validation-1", documentType: "dt-markdown", baseUrl: "https://unidocs-markdown.shazhou.workers.dev", expectedConfigEtag: '"sha256-config"',
    descriptor: { protocol: "unidocs-operator/v1", declaredOperatorId: "markdown-primary", displayName: "Markdown Operator", supportedDocumentTypes: ["dt-markdown"], supportedDocumentContracts: { "dt-markdown": [0] } },
    validatedAt: "2026-09-11T12:00:00.000Z", expiresAt: "2026-09-11T12:15:00.000Z",
  };
  const operator = { operatorId: "op_one", documentType: "dt-markdown", name: "Markdown Operator", description: "Candidate", baseUrl: validation.baseUrl, descriptor: validation.descriptor, validatedAt: validation.validatedAt, etag: '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' };
  const currentOperator = { ...operator, operatorId: "op_current", name: "Current Operator" };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.endsWith("/document-types/dt-markdown")) return Response.json(registration);
    if (url.endsWith("/operator-validations") && init?.method === "POST") return Response.json(validation);
    if (url.endsWith("/operator-validations/validation-1")) return Response.json(validation);
    if (url.endsWith("/operators") && init?.method === "POST") return Response.json({ operatorId: "op_one", etag: operator.etag }, { status: 201 });
    if (url.endsWith("/operators/op_one")) return Response.json(operator);
    if (url.includes("/operators?")) return Response.json({ items: [{ ...currentOperator, supportedDocumentContractIdxs: [0] }, { ...operator, supportedDocumentContractIdxs: [0] }], nextCursor: null });
    if (url.endsWith("/document-types/dt-markdown") && init?.method === "PATCH") return Response.json({ documentType: "dt-markdown", etag: '"sha256-next"' });
    return Response.json({ items: [], nextCursor: null });
  });
  Object.defineProperty(document, "cookie", { configurable: true, value: "__Host-unidocs_admin_csrf=csrf" });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(await screen.findByRole("tab", { name: /^处理服务/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("textbox", { name: "处理服务 URL" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加操作代理" }));
  expect(screen.getByRole("textbox", { name: "处理服务 URL" })).toHaveValue("https://unidocs-markdown.shazhou.workers.dev");
  expect(screen.getByRole("textbox", { name: "验证文档类型" })).toHaveValue("dt-markdown");
  fireEvent.click(screen.getByRole("button", { name: "验证处理服务" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(createCall[1]?.body))).toEqual({ baseUrl: "https://unidocs-markdown.shazhou.workers.dev", expectedDocumentType: "dt-markdown", expectedConfigEtag: null });
  expect(await screen.findByRole("heading", { name: "Markdown Operator" })).toBeInTheDocument();
  expect(screen.getByText("revision 0")).toBeInTheDocument();
  expect(screen.getByText("validation-1")).toBeInTheDocument();
  expect(sessionStorage.getItem("unidocs.operator-validation.dt-markdown")).toBe("validation-1");
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/operator-validations/validation-1"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存处理服务" }));
  expect((await screen.findAllByText("Current Operator")).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("正在使用")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "编辑 Markdown Operator" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "编辑 Markdown Operator" }));
  expect((await screen.findAllByText("op_one")).length).toBeGreaterThanOrEqual(2);
  fireEvent.click(screen.getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/document-types/dt-markdown") && init?.method === "PATCH")).toBe(true));
  expect(window.location.pathname + window.location.search).toBe("/admin/document-types/dt-markdown?tab=operators");
  vi.unstubAllGlobals();
});

test("restores document-type change history, opens details, and paginates", async () => {
  window.history.replaceState({}, "", "/admin/document-types/dt-markdown?tab=changes");
  const registration = { documentType: "dt-markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, etag: '"sha256-registration"', updatedAt: "2026-09-12T00:00:00.000Z" };
  const first = { auditEventId: "change-2", actorId: "admin", action: "operator.created", resourceType: "operator", resourceId: "op_one", documentType: "dt-markdown", occurredAt: "2026-09-12T01:00:00.000Z", requestId: "request-2", reason: null, details: { declaredOperatorId: "markdown-primary" } };
  const second = { ...first, auditEventId: "change-1", action: "document_type.registered", resourceType: "document_type", resourceId: "dt-markdown", occurredAt: "2026-09-12T00:00:00.000Z", requestId: "request-1", details: undefined };
  const fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/admin/auth/session")) return Response.json({ memberId: "admin", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1, loginConfirmation: "authorization-code-v1", transport: "session" });
    if (url.endsWith("/document-types/dt-markdown")) return Response.json(registration);
    if (url.includes("/administrators")) return Response.json({ items: [{ adminId: "admin", email: "lee.scott@example.com", bound: true, addedBy: "bootstrap", addedAt: first.occurredAt, etag: '"sha256-admin"', isSelf: true }], nextCursor: null });
    if (url.includes("/audit-events") && url.includes("cursor=next")) return Response.json({ items: [second], nextCursor: null });
    if (url.includes("/audit-events")) return Response.json({ items: [first], nextCursor: "next" });
    return Response.json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(await screen.findByRole("tab", { name: "变更记录" })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("documentType=dt-markdown"), expect.anything()));
  const change = await screen.findByRole("button", { name: /创建算子/ });
  expect(change).toHaveTextContent("lee.scott@example.com");
  fireEvent.click(change);
  expect(screen.getByText("request-2")).toBeInTheDocument();
  expect(screen.getByText(/markdown-primary/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByRole("button", { name: /创建文档类型/ })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=next"), expect.anything());
  expect(window.location.pathname + window.location.search).toBe("/admin/document-types/dt-markdown?tab=changes");
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